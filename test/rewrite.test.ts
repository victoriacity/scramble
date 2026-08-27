// test/rewrite.test.ts — a model rewriting a message before it leaves.
//
// The message ALWAYS goes: a missing key, a timeout or a bad answer costs the
// rewrite. Nothing changes silently: the sender's own words are printed beside a
// rewrite that is sent. And the rewrite passes the same rules the sender's words
// did, or it is dropped in favour of the words that passed.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORD_LIMIT } from "../src/language";

const scratch = (): string => mkdtempSync(join(tmpdir(), "scramble-prompt-"));
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MIN_PROSE_RATIO,
  chooseText,
  causalIn,
  connectivesIn,
  factsIn,
  mentionsIn,
  proseRatio,
  strengthDrift,
  readRewrites,
  recordRewrite,
  rewritesPath,
  rewritesReport,
  rewriteConfig,
  composePrompt,
  promptPath,
  readPromptTemplate,
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
    expect(a).toEqual({
      key: "k1",
      provider: "gemini",
      model: DEFAULT_MODEL,
      url: "https://generativelanguage.googleapis.com/v1beta",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
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
  // It lives in a markdown file beside the code, so it can be read and changed
  // without touching TypeScript, and so the language gate lints it like every
  // other document this repo ships.
  const here = join(import.meta.dir, "..", "src");

  test("the shipped file protects the claim", () => {
    const t = readPromptTemplate(here);
    expect(t.ok).toBe(true);
    const text = t.ok ? t.text : "";
    // The operator removed the 140-token cap and the pinned claim-strength
    // phrase (2026-08-25): the wording belongs to the prompt author, and the
    // cap had no measured basis. What must hold: byte-exact preservation is
    // still demanded, and the note above the first --- line is NOT sent.
    expect(text).toContain("byte for byte");
    // THE ROLE COMES FIRST, so the model is told who it is before what to do.
    expect(text.startsWith("You are a very experienced Member of Technical Staff")).toBe(true);
    // The check that forbade `because` and `since` here is GONE. The instruction
    // has to name those words as connectives it must preserve: "never turn `A,
    // because B` into `A. B`" (2026-08-25). A token check cannot tell a word
    // being explained from a word being named, and the instruction needs to name
    // them.
    expect(text).toContain("Never turn `A, because B` into `A. B`");
    expect(text).not.toContain("# Rewrite instruction");
  });

  test("a missing instruction is a REASON, never a default", () => {
    // A rewrite driven by no instruction is worse than no rewrite: the model
    // would be free to do anything to a claim.
    const missing = readPromptTemplate(join(scratch(), "nowhere"));
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.why).toContain("could not be read");
  });

  test("a file with no instruction below its marker is a REASON too", () => {
    const dir = scratch();
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(promptPath(dir), "# only a preamble\n\nnothing below a marker\n");
    const empty = readPromptTemplate(dir);
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.why).toContain("carries no instruction");
  });

  test("the message is appended after the marker", () => {
    expect(composePrompt("INSTRUCTION", "the socket delivered nothing")).toBe(
      "INSTRUCTION\n\n---\nthe socket delivered nothing",
    );
  });
});

describe("the call", () => {
  test("a good answer comes back trimmed", async () => {
    const cfg = { key: "k", provider: "gemini" as const, model: "m", url: "https://g", timeoutMs: 1000 };
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
      { key: "k1", provider: "gemini" as const, model: "gemini-9", url: "https://generativelanguage.googleapis.com/v1beta", timeoutMs: 1000 },
      "the words",
    );
    expect(seen).toContain("models/gemini-9:generateContent");
    expect(seen).toContain("key=k1");
    expect(body).toContain("the words");
  });

  test("every failure is a REASON, never a throw", async () => {
    const cfg = { key: "k", provider: "gemini" as const, model: "m", url: "https://g", timeoutMs: 1000 };
    expect(await rewriteWith(async () => reply("x"), { provider: "gemini" as const, model: "m", url: "https://g", timeoutMs: 1 }, "x")).toEqual({
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
      { key: "k", provider: "gemini" as const, model: "m", url: "https://g", timeoutMs: 20 },
      "x",
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("the rewrite call failed");
  });
});

describe("three providers", () => {
  // Gemini has its own request shape; Fireworks and LiteLLM both speak the
  // OpenAI chat-completions shape, so they are one code path with different
  // addresses.
  const chat = (content: string): Response =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200 });

  test("fireworks goes to its own address with bearer auth", async () => {
    let url = "";
    let auth = "";
    let body = "";
    const cfg = rewriteConfig((n) =>
      n === "SCRAMBLE_REWRITE_KEY" ? "fw-key" : n === "SCRAMBLE_REWRITE_PROVIDER" ? "fireworks" : undefined,
    );
    const r = await rewriteWith(
      async (u, init) => {
        url = String(u);
        auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
        body = String(init?.body);
        return chat("the fireworks rewrite");
      },
      cfg,
      "words",
    );
    expect(url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(auth).toBe("Bearer fw-key");
    expect(body).toContain("accounts/fireworks/models/");
    expect(r).toEqual({ ok: true, text: "the fireworks rewrite" });
  });

  test("litellm is a proxy anyone hosts, so its address is configuration", async () => {
    let url = "";
    const cfg = rewriteConfig((n) =>
      n === "SCRAMBLE_REWRITE_KEY" ? "k" :
      n === "SCRAMBLE_REWRITE_PROVIDER" ? "litellm" :
      n === "SCRAMBLE_REWRITE_URL" ? "http://127.0.0.1:4000/v1/" : undefined,
    );
    // The trailing slash is trimmed, so a copied URL works.
    expect(cfg.url).toBe("http://127.0.0.1:4000/v1");
    const r = await rewriteWith(
      async (u) => {
        url = String(u);
        return chat("the litellm rewrite");
      },
      cfg,
      "words",
    );
    expect(url).toBe("http://127.0.0.1:4000/v1/chat/completions");
    expect(r).toEqual({ ok: true, text: "the litellm rewrite" });
  });

  test("a chat answer of a shape we did not expect costs the rewrite, never the message", async () => {
    const cfg = rewriteConfig((n) =>
      n === "SCRAMBLE_REWRITE_KEY" ? "k" : n === "SCRAMBLE_REWRITE_PROVIDER" ? "fireworks" : undefined,
    );
    for (const shape of [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: {} }] },
      { choices: [{ message: { content: 7 } }] }]) {
      const r = await rewriteWith(async () => new Response(JSON.stringify(shape), { status: 200 }), cfg, "x");
      expect(r).toEqual({ ok: false, why: "the rewrite answer carried no text" });
    }
  });

  test("an unknown provider name falls back to gemini", async () => {
    // A typo that reached a real request would fail per message with a network
    // error; this fails once, visibly, at the first send.
    const cfg = rewriteConfig((n) =>
      n === "SCRAMBLE_REWRITE_KEY" ? "k" : n === "SCRAMBLE_REWRITE_PROVIDER" ? "gemeni" : undefined,
    );
    expect(cfg.provider).toBe("gemini");
    expect(cfg.url).toContain("generativelanguage");
  });
});

describe("choosing what to send", () => {
  test("a clean rewrite is sent, and the sender's own words are printed beside it", () => {
    const out = chooseText("the original words", { ok: true, text: "the professional words" });
    expect("send" in out && out.send).toBe("the professional words");
    expect("note" in out && out.note).toContain("sent a rewrite");
    expect("note" in out && out.note).toContain("the original words");
  });

  test("a failed rewrite STOPS the send, and says why", () => {
    // "we should not allow claude original message go out. The communication is
    // too bad" (2026-08-25). Falling back to the author's words published exactly
    // the prose the rewrite exists to replace.
    const out = chooseText("mine", { ok: false, why: "the rewrite call answered 503" });
    expect("refuse" in out && out.refuse).toContain("the rewrite did not happen");
    expect("refuse" in out && out.refuse).toContain("503");
    expect("refuse" in out && out.refuse).toContain("do not go out while the rewrite is on");
  });

  test("an unchanged rewrite says nothing at all", () => {
    expect(chooseText("same words", { ok: true, text: " same words " })).toEqual({ send: "same words", note: "" });
  });

  test("a rewrite that DROPS what the original carried is refused", () => {
    // Measured in a live channel: the rewriter dropped a closing causal sentence
    // and replaced a statement of fact with a different one, and the receiving
    // agent inferred the missing conclusion from the numbers (2026-08-25).
    const original = "the run took 42 seconds and `_summary.mesh_quality.json` holds the score for @peer_metrics";
    const out = chooseText(original, { ok: true, text: "the run took 42 seconds and holds the score" });
    expect("refuse" in out && out.refuse).toContain("the rewrite dropped");
    expect("refuse" in out && out.refuse).toContain("`_summary.mesh_quality.json`");
    expect("refuse" in out && out.refuse).toContain("neither version goes out");
  });

  test("a rewrite that loses most of the prose is refused", () => {
    // A whole sentence going missing is what a dropped conclusion looks like
    // from outside.
    const original = Array.from({ length: 40 }, (_, i) => `word${i % 3}`).join(" ");
    const out = chooseText(original, { ok: true, text: "word0 word1 word2 word0 word1" });
    expect("refuse" in out && out.refuse).toContain("under the 60% floor");
  });

  test("what counts as a fact to preserve", () => {
    const facts = factsIn("see `a b` and 42 items for @dev at https://x.dev/y in /srv/data/f.json");
    expect(facts).toContain("`a b`");
    expect(facts).toContain("42");
    expect(facts).toContain("@dev");
    expect(facts).toContain("https://x.dev/y");
    expect(facts).toContain("/srv/data/f.json");
  });

  test("the prose ratio ignores code, so an evidence-heavy message is not penalised", () => {
    const original = ["one two three four five", "```", "a b c d e f g h i j", "```"].join("\n");
    expect(proseRatio(original, "one two three four five")).toBe(1);
    expect(MIN_PROSE_RATIO).toBeLessThan(1);
  });

  test("a mention moved into code stopped notifying, and is refused", () => {
    // Measured live: the rewriter moved an `@name` into a code span, Slack
    // recorded `mentions=[]`, and the addressee never heard about the message
    // (2026-08-25). The characters are still on the line, so a whole-text check
    // misses it.
    const mine = "@peer_metrics the run finished";
    const out = chooseText(mine, { ok: true, text: "The run finished, `@peer_metrics`" });
    expect("refuse" in out && out.refuse).toContain("stopped @peer_metrics from notifying anyone");
  });

  test("a rewrite that erases the actor is refused", () => {
    // Two agents measured the same shift: "I stopped restarting on every bump"
    // became "The process waited for the installed commit to hold steady", and a
    // first-person report turned into a description with nobody in it.
    const mine = "I stopped restarting on every bump about an hour ago";
    const out = chooseText(mine, { ok: true, text: "The process waited for the installed commit to hold steady" });
    expect("refuse" in out && out.refuse).toContain("removed the first person");
  });

  test("prose inside a fence may be rewritten, and its figures may not change", () => {
    // The operator, 2026-08-26: "any natural language text MUST be rewritten
    // even if it is in the code block." An agent had said an hour earlier that
    // they put sentences in fences because the rewriter leaves fences alone.
    const mine = "I measured it.\n```\nThe run finished and 42 files got written\n```";
    const better = chooseText(mine, {
      ok: true,
      text: "I measured it.\n```\nThe run finished, and it wrote 42 files\n```",
    });
    expect("send" in better).toBe(true);
    // The figure is still required: a fence is not a place to lose a number.
    const lost = chooseText(mine, {
      ok: true,
      text: "I measured it.\n```\nThe run finished and wrote some files\n```",
    });
    expect("refuse" in lost).toBe(true);
    if ("refuse" in lost) expect(lost.why).toContain("42");
  });

  test("factsIn keeps an inline span whole and takes figures out of a fence", () => {
    expect(factsIn("run `land.sh --now` on 3 hosts")).toEqual(["`land.sh --now`", "3"]);
    expect(factsIn("```\nposted at 1787715115.551859 for @dev\n```")).toEqual([
      "1787715115.551859",
      "@dev",
    ]);
  });

  test("a rewrite that flattens `A, because B` into two facts is refused", () => {
    // The operator, 2026-08-25: "it should never break the logic such as A,
    // because B into A, and B." The instruction said so and nothing measured it.
    const mine = "I restarted the listener because the installed commit moved.";
    const out = chooseText(mine, { ok: true, text: "I restarted the listener, and the installed commit moved." });
    expect("refuse" in out).toBe(true);
    if ("refuse" in out) {
      expect(out.why).toContain("flattened the logic");
      expect(out.why).toContain("because");
    }
  });

  test("a rewrite that adds a TIMING word passes, where adding a reason does not", () => {
    // MEASURED over 29 sends on two hosts: the connective guard fired four
    // times, always in the ADD direction, and killed one send. Two of the four
    // added `because`, a claim about why the author never made. The other two
    // added `when` and `whenever`, which restate timing (2026-08-26).
    const mine = "I restarted the listener, so the new build is live.";
    const timing = chooseText(mine, {
      ok: true,
      text: "I restarted the listener when the build changed, so the new build is live.",
    });
    expect("send" in timing).toBe(true);
    const why = chooseText(mine, {
      ok: true,
      text: "I restarted the listener because the build changed, so the new build is live.",
    });
    expect("refuse" in why).toBe(true);
    if ("refuse" in why) expect(why.why).toContain("invented a reason");
  });

  test("causalIn counts only the words that state why", () => {
    expect(causalIn("I did it because it broke, so I restarted it when it settled")).toEqual(["because", "so"]);
    expect(causalIn("I did it when it broke, although it settled")).toEqual([]);
  });

  test("a rewrite that invents a link between two facts is refused", () => {
    // Measured on the instruction file itself: "Do not compress. Clipped prose
    // reads as an interrogation" came back joined by `because` (2026-08-25).
    const mine = "I do not compress the text. Clipped prose reads as an interrogation.";
    const out = chooseText(mine, {
      ok: true,
      text: "I do not compress the text because clipped prose reads as an interrogation.",
    });
    expect("refuse" in out).toBe(true);
    if ("refuse" in out) expect(out.why).toContain("invented a reason");
  });

  test("swapping one connective for another keeps the count and passes", () => {
    // Two agents measured `which is why` -> `because` and `therefore` ->
    // `because` over ten sentences on two hosts, clauses swapped, logic intact
    // (2026-08-25). A word-by-word check would have refused every one.
    const mine = "The build passed, therefore I merged the change.";
    const out = chooseText(mine, { ok: true, text: "I merged the change because the build passed." });
    expect("send" in out).toBe(true);
  });

  test("connectivesIn counts the class and ignores code", () => {
    expect(connectivesIn("I landed it because the gate was green, so the build moved.")).toEqual(["because", "so"]);
    expect(connectivesIn("run `land.sh` if it fails")).toEqual(["if"]);
    expect(connectivesIn("no links here")).toEqual([]);
  });

  test("a message with no first person is left alone by that rule", () => {
    const out = chooseText("the run finished and the file holds the score", {
      ok: true,
      text: "the run finished; the file holds the score",
    });
    expect("send" in out).toBe(true);
  });

  test("a mention the author never wrote is refused", () => {
    // Measured twice: a rewrite turned "re-ran the same five sentences" into
    // "after @scramble_dev re-ran the same five sentences", crediting the run to
    // a different agent and pinging them for it (2026-08-25).
    const mine = "re-ran the same five sentences on 7412f27";
    const out = chooseText(mine, { ok: true, text: "after @scramble_dev re-ran the same five sentences on 7412f27" });
    expect("refuse" in out && out.refuse).toContain("added @scramble_dev");
    expect("refuse" in out && out.refuse).toContain("credit them with work they did not do");
  });

  test("a dropped mention is refused, by whichever guard reaches it first", () => {
    // The dropped-facts check sees it too, since a mention is a fact. Either
    // refusal stops the send, which is what matters.
    const out = chooseText("@dev please look", { ok: true, text: "please look" });
    expect("refuse" in out && out.refuse).toContain("@dev");
    expect("refuse" in out && out.refuse).toContain("neither version goes out");
  });

  test("mentions are counted in prose only", () => {
    expect(mentionsIn("hi @dev and `@notme` here")).toEqual(["@dev"]);
  });

  test("trailing punctuation belongs to the sentence, never to the name", () => {
    // A Slack handle may contain a dot, so the match takes one, and `@name.` at
    // the end of a sentence read as a different person from `@name`. The
    // added-mention guard called that a new mention and blocked two sends
    // (2026-08-25).
    expect(mentionsIn("thanks @model_failure_researc.")).toEqual(["@model_failure_researc"]);
    expect(mentionsIn("@dev, @ana: @bo; @cy! @di?")).toEqual(["@dev", "@ana", "@bo", "@cy", "@di"]);
    // A dot INSIDE a handle stays.
    expect(mentionsIn("hi @first.last here")).toEqual(["@first.last"]);
    // And the guard no longer fires on the sentence-final case.
    const out = chooseText("@model_failure_researc your helper is already in the file", {
      ok: true,
      text: "Your helper is already in the file, @model_failure_researc.",
    });
    expect("send" in out).toBe(true);
  });

  test("a rewrite that makes a claim STRONGER is refused", () => {
    // The worst case measured live: an author wrote about their exposure and the
    // rewrite published a guarantee (2026-08-25).
    const mine = "the diff check narrows the window where the rewriter can replace a measured number";
    const out = chooseText(mine, {
      ok: true,
      text: "the diff check prevents the rewriter from replacing a measured number",
    });
    expect("refuse" in out && out.refuse).toContain("introduced prevents");
    expect("refuse" in out && out.refuse).toContain("belongs to whoever made it");
    expect("refuse" in out && out.refuse).toContain("What the rewriter produced");
  });

  test("a rewrite that SOFTENS a claim is refused by the same rule", () => {
    const mine = "the socket delivered nothing";
    const out = chooseText(mine, { ok: true, text: "the socket appears to have delivered nothing" });
    expect("refuse" in out && out.refuse).toContain("introduced appears");
  });

  test("a strength word the author already used is the author's", () => {
    expect(strengthDrift("this never works", "this never works well")).toEqual([]);
    expect(strengthDrift("a plain claim", "a plain claim, `always` in code")).toEqual([]);
  });

  test("a rewrite that breaks a language rule is DROPPED", () => {
    // Posting prose the repo refuses because a model wrote it would make the
    // rules mean nothing.
    const out = chooseText("plain words here", { ok: true, text: "a rewrite with an em dash — like this" });
    expect("refuse" in out && out.refuse).toContain("the rewrite broke 1 language rule(s)");
    expect("refuse" in out && out.refuse).toContain("em dash");
  });

  test("a rewrite over the word limit is DROPPED", () => {
    // COUNTED FROM THE SHIPPED LIMIT, so this moves with it. The operator
    // raised the cap from 200 to 300 on 2026-08-27, and a hardcoded 260 quietly
    // stopped exercising the guard.
    const long = Array.from({ length: WORD_LIMIT + 60 }, () => "word").join(" ");
    const out = chooseText("short", { ok: true, text: long });
    expect("refuse" in out && out.refuse).toContain("ran over the word limit");
  });
});

describe("the record of what the rewriter did", () => {
  // Every claim about whether the rewriter helps has been a single case somebody
  // remembered, on a feature running on every send from two hosts and five
  // agents (2026-08-25).
  const row = (over: Partial<Parameters<typeof recordRewrite>[1]> = {}) => ({
    at: "2026-08-25T12:00:00.000Z",
    agent: "dev",
    channel: "general",
    outcome: "sent" as const,
    words: [20, 22] as [number, number],
    ...over,
  });

  test("an empty file says why it can be empty", () => {
    const said = rewritesReport([]);
    expect(said).toContain("No sends have met the rewriter");
    expect(said).toContain("the rewrite is off or nothing has been sent");
  });

  test("`--as` scopes the count to one agent, and names whose rows are here", () => {
    // MEASURED: two agents on one host read the same 13 rows as their own, and
    // one of them reported a guard catch it had never had (xingyubot,
    // 2026-08-25). The file is per host and every row carries its agent.
    const rows = [row({ agent: "alice" }), row({ agent: "alice" }), row({ agent: "bob" })];
    expect(rewritesReport(rows, "alice")).toContain("2 send(s) from alice met the rewriter");
    expect(rewritesReport(rows, "bob")).toContain("1 send(s) from bob met the rewriter");
    // No flag: every agent, with the names on the line so nobody takes the
    // total for their own.
    expect(rewritesReport(rows)).toContain("3 send(s) from alice, bob met the rewriter");
    // An agent with no rows on a host that has some is told whose they are.
    const none = rewritesReport(rows, "carol");
    expect(none).toContain("No sends from carol");
    expect(none).toContain("alice, bob");
  });

  test("rows are counted by outcome, and the guards are ranked", () => {
    const rows = [
      row(),
      row(),
      row({ outcome: "unchanged", words: [10, 10] }),
      // A REFUSAL SENDS NOTHING, so its second count is zero, which is what the
      // send path writes.
      row({ outcome: "refused", why: "the rewrite introduced prevents", words: [20, 0] }),
      row({ outcome: "refused", why: "the rewrite introduced prevents", words: [20, 0] }),
      row({ outcome: "retried", why: "the rewrite broke 1 language rule(s)" }),
      row({ outcome: "skipped", words: [20, 0] }),
    ];
    const said = rewritesReport(rows);
    expect(said).toContain("7 send(s) from dev met the rewriter");
    expect(said).toContain("sent       2");
    expect(said).toContain("refused    2");
    expect(said).toContain("What the guards caught:");
    // Ranked, so the one that fires most reads first.
    expect(said.indexOf("2  the rewrite introduced prevents")).toBeLessThan(
      said.indexOf("1  the rewrite broke"),
    );
    expect(said).toContain("3 of them came back longer than the draft");
  });

  test("rows survive a round trip, and a damaged line is skipped", () => {
    const p = rewritesPath(join(scratch(), "slack.json"));
    recordRewrite(p, row());
    recordRewrite(p, row({ outcome: "refused", why: "a guard" }));
    writeFileSync(p, `${readRewrites(p).map((r) => JSON.stringify(r)).join("\n")}\nnot json\n{"nope":1}\n`);
    const back = readRewrites(p);
    expect(back).toHaveLength(2);
    expect(back[1]?.outcome).toBe("refused");
  });

  test("an unreadable file reads as no rows", () => {
    expect(readRewrites(join(scratch(), "nothing.jsonl"))).toEqual([]);
  });
});
