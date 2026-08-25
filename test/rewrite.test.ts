// test/rewrite.test.ts — a model rewriting a message before it leaves.
//
// The message ALWAYS goes: a missing key, a timeout or a bad answer costs the
// rewrite. Nothing changes silently: the sender's own words are printed beside a
// rewrite that is sent. And the rewrite passes the same rules the sender's words
// did, or it is dropped in favour of the words that passed.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  chooseText,
  rewriteConfig,
  rewritePrompt,
  rewriteWith,
} from "../src/rewrite";

const reply = (text: string): Response =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }), {
    status: 200,
  });

describe("the configuration", () => {
  test("no key means the feature is off", () => {
    expect(rewriteConfig(() => undefined).key).toBeUndefined();
    expect(rewriteConfig((n) => (n === "SCRAMBLE_REWRITE_KEY" ? "" : undefined)).key).toBeUndefined();
  });

  test("either key turns it on, and the model and timeout have defaults", () => {
    const a = rewriteConfig((n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k1" : undefined));
    expect(a).toEqual({ key: "k1", model: DEFAULT_MODEL, timeoutMs: DEFAULT_TIMEOUT_MS });
    const b = rewriteConfig((n) => (n === "GEMINI_API_KEY" ? "k2" : undefined));
    expect(b.key).toBe("k2");
  });

  test("a newer model and a slower link need no code change", () => {
    const c = rewriteConfig((n) =>
      n === "SCRAMBLE_REWRITE_KEY" ? "k" : n === "SCRAMBLE_REWRITE_MODEL" ? "gemini-9" : "250",
    );
    expect(c.model).toBe("gemini-9");
    expect(c.timeoutMs).toBe(250);
    // A nonsense timeout falls back rather than disabling the call.
    const d = rewriteConfig((n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : n === "SCRAMBLE_REWRITE_TIMEOUT_MS" ? "no" : undefined));
    expect(d.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("the instruction", () => {
  test("it names what must not change, because that is the whole risk", () => {
    const p = rewritePrompt("the socket delivered nothing");
    expect(p).toContain("Keep every claim exactly as strong as it is");
    expect(p).toContain("Do not add words like may, might, appears");
    expect(p).toContain("byte for byte");
    expect(p).toContain("the socket delivered nothing");
  });
});

describe("the call", () => {
  test("a good answer comes back trimmed", async () => {
    const cfg = { key: "k", model: "m", timeoutMs: 1000 };
    const r = await rewriteWith(async () => reply("  the rewritten line  "), cfg, "x");
    expect(r).toEqual({ ok: true, text: "the rewritten line" });
  });

  test("the key and the model ride the URL, and the prompt rides the body", async () => {
    let seen = "";
    let body = "";
    await rewriteWith(
      async (u, init) => {
        seen = String(u);
        body = String(init?.body);
        return reply("out");
      },
      { key: "k1", model: "gemini-9", timeoutMs: 1000 },
      "the words",
    );
    expect(seen).toContain("models/gemini-9:generateContent");
    expect(seen).toContain("key=k1");
    expect(body).toContain("the words");
  });

  test("every failure is a REASON, never a throw", async () => {
    const cfg = { key: "k", model: "m", timeoutMs: 1000 };
    expect(await rewriteWith(async () => reply("x"), { model: "m", timeoutMs: 1 }, "x")).toEqual({
      ok: false,
      why: "no rewrite key configured",
    });
    const thrown = await rewriteWith(async () => {
      throw new Error("socket hung up");
    }, cfg, "x");
    expect(thrown).toEqual({ ok: false, why: "the rewrite call failed: socket hung up" });
    expect(await rewriteWith(async () => new Response("", { status: 503 }), cfg, "x")).toEqual({
      ok: false,
      why: "the rewrite call answered 503",
    });
    expect(await rewriteWith(async () => new Response("not json", { status: 200 }), cfg, "x")).toEqual({
      ok: false,
      why: "the rewrite answer was not JSON",
    });
    for (const shape of [{}, { candidates: [] }, { candidates: [{}] }, { candidates: [{ content: { parts: [] } }] },
      { candidates: [{ content: { parts: [{ text: 7 }] } }] }, { candidates: [{ content: { parts: [{ text: "  " }] } }] }]) {
      expect(await rewriteWith(async () => new Response(JSON.stringify(shape), { status: 200 }), cfg, "x")).toEqual({
        ok: false,
        why: "the rewrite answer carried no text",
      });
    }
    expect(await rewriteWith(async () => new Response("null", { status: 200 }), cfg, "x")).toEqual({
      ok: false,
      why: "the rewrite answer carried no text",
    });
  });

  test("the timeout ABORTS the call, so a slow model costs the rewrite", async () => {
    const r = await rewriteWith(
      async (_u, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("the operation was aborted")));
        }),
      { key: "k", model: "m", timeoutMs: 20 },
      "x",
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("the rewrite call failed");
  });
});

describe("choosing what to send", () => {
  test("a clean rewrite is sent, and the sender's own words are printed beside it", () => {
    const out = chooseText("the original words", { ok: true, text: "the professional words" });
    expect(out.text).toBe("the professional words");
    expect(out.note).toContain("sent a rewrite");
    expect(out.note).toContain("the original words");
  });

  test("a failed rewrite sends the sender's words, and says why", () => {
    const out = chooseText("mine", { ok: false, why: "the rewrite call answered 503" });
    expect(out.text).toBe("mine");
    expect(out.note).toContain("sent your own words: the rewrite call answered 503");
  });

  test("an unchanged rewrite says nothing at all", () => {
    expect(chooseText("same words", { ok: true, text: " same words " })).toEqual({ text: "same words", note: "" });
  });

  test("a rewrite that breaks a language rule is DROPPED", () => {
    // Posting prose the repo refuses because a model wrote it would make the
    // rules mean nothing.
    const out = chooseText("plain words here", { ok: true, text: "a rewrite with an em dash — like this" });
    expect(out.text).toBe("plain words here");
    expect(out.note).toContain("the rewrite broke 1 language rule(s)");
    expect(out.note).toContain("em dash");
  });

  test("a rewrite over the word limit is DROPPED", () => {
    const long = Array.from({ length: 260 }, () => "word").join(" ");
    const out = chooseText("short", { ok: true, text: long });
    expect(out.text).toBe("short");
    expect(out.note).toContain("ran over the word limit");
  });
});
