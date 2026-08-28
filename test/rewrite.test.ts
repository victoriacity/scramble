// The test file `test/rewrite.test.ts` verifies that a model rewrites an outgoing
// message before transmission.
//
// The system always transmits the message. A missing key, a timeout, or an invalid
// response cancels the rewrite. The system prints the sender's original words
// alongside the sent rewrite, so no change occurs silently. The rewrite must pass
// the same validation rules that the sender's words passed, or the system drops
// the rewrite and sends the original text that passed.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORD_LIMIT } from "../src/language";

const scratch = (): string => mkdtempSync(join(tmpdir(), "scramble-prompt-"));
import {
  DEFAULT_MODEL,
  commentRuns,
  renderComment,
  documentPromptPath,
  fencedBlocks,
  readDocumentTemplate,
  splitSections,
  DEFAULT_TIMEOUT_MS,
  MIN_PROSE_RATIO,
  chooseText,
  causalIn,
  connectivesIn,
  factsIn,
  quotedSpan,
  citedTimestamps,
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
  readTierBlock,
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
    // An invalid timeout value reverts to the default setting, which keeps the call
    // alive.
    const d = rewriteConfig((n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : n === "SCRAMBLE_REWRITE_TIMEOUT_MS" ? "no" : undefined));
    expect(d.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("the instruction", () => {
  // The document lives in a markdown file beside the code, so developers can read
  // and change it without touching TypeScript, and so the language gate lints it
  // like every other document this repository ships.
  const here = join(import.meta.dir, "..", "src");

  test("EVERY SHIPPED INSTRUCTION FILE LOADS, whatever its prose", () => {
    // This positive control runs against the real artifact. The loader retained
    // only what followed a `---` line, and this test asserted that the text above
    // that line was absent. The operator rewrote the file and removed that line along
    // with the note it separated (commit 228f53a), and the loader began refusing:
    // every send posted unrewritten with a reason. The operator controls the wording,
    // so the assertions here check only properties that a rewording cannot break.
    for (const load of [
      () => readPromptTemplate(here),
      () => readTierBlock(here, "internal"),
      () => readTierBlock(here, "external"),
    ]) {
      const t = load();
      expect(t.ok).toBe(true);
      expect((t.ok ? t.text : "").length).toBeGreaterThan(0);
    }
    // A rewrite that drops `@name` leaves the message unaddressed and the reader
    // unnotified. Losing this rule costs a PERSON.
    expect(readPromptTemplate(here).ok && (readPromptTemplate(here) as { text: string }).text).toContain("@name");
  });

  test("a missing instruction is a REASON, never a default", () => {
    // A rewrite executed without instructions is worse than no rewrite, because the
    // model would be free to do anything to a claim.
    const missing = readPromptTemplate(join(scratch(), "nowhere"));
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.why).toContain("could not be read");
  });

  test("an empty instruction file is a REASON too", () => {
    const dir = scratch();
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(promptPath(dir), "   \n\n");
    const empty = readPromptTemplate(dir);
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.why).toContain("is empty");
    // A file containing prose without a marker is now a complete instruction, and the
    // note at the top of the file goes to the model with the rest of the text.
    writeFileSync(promptPath(dir), "# Rewrite instruction\n\nRewrite it.\n");
    const whole = readPromptTemplate(dir);
    expect(whole.ok && whole.text).toBe("# Rewrite instruction\n\nRewrite it.");
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
    // The output includes the elapsed time, so a reader can tell a hung socket at 3 ms
    // from one at 40 seconds.
    expect(!thrown.ok && thrown.why).toContain("the rewrite call failed after");
    expect(!thrown.ok && thrown.why).toContain("socket hung up");
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
    // The ceiling belongs to this system, and the message states this. The output
    // read "the rewrite call failed: The operation was aborted." while the service was
    // still answering. The send operation prints that line while refusing to post,
    // which sends the reader to an endpoint that is up. A cold call measured 12282 ms
    // on this host.
    expect(!r.ok && r.why).toContain("passed this build's 20 ms ceiling");
    expect(!r.ok && r.why).toContain("1-character prompt");
    expect(!r.ok && r.why).toContain("nothing here says the service failed");
    expect(!r.ok && r.why).toContain("SCRAMBLE_REWRITE_TIMEOUT_MS");
    // A slow call that remains below the ceiling does not abort. The same request
    // with room to answer returns successfully, so the branch above is the ceiling
    // and never the service.
    const fine = await rewriteWith(
      async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "out" }] } }] }), { status: 200 }),
      { key: "k", provider: "gemini" as const, model: "m", url: "https://g", timeoutMs: 5000 },
      "x",
    );
    expect(fine).toEqual({ ok: true, text: "out" });
  });
});

describe("three providers", () => {
  // Gemini uses its own request shape. Fireworks and LiteLLM both use the OpenAI
  // chat-completions shape, so they share a single code path with different
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
    // The system trims the trailing slash, so a copied URL works.
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
    // A typo that reached a live request would fail with a network error on every
    // message. This fails once, visibly, at the first send.
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
    // The system must prevent Claude's original message from going out because its
    // communication is poor. Falling back to the author's words published the exact
    // prose that the rewrite exists to replace.
    const out = chooseText("mine", { ok: false, why: "the rewrite call answered 503" });
    expect("refuse" in out && out.refuse).toContain("the rewrite did not happen");
    expect("refuse" in out && out.refuse).toContain("503");
    expect("refuse" in out && out.refuse).toContain("do not go out while the rewrite is on");
  });

  test("an unchanged rewrite says nothing at all", () => {
    expect(chooseText("same words", { ok: true, text: " same words " })).toEqual({ send: "same words", note: "" });
  });

  test("a rewrite that QUOTES ITS OWN INSTRUCTION is refused", () => {
    // On a second attempt, the model receives the guard's complaint appended to the
    // instruction, and returns that complaint in a closing paragraph addressed to the
    // reader. A phrase list caught the complaint in the exact words this file writes.
    // The model then produced `The system rejected your previous attempt`, which the
    // list did not hold. The system checks the answer against the instruction it was
    // given.
    const retry = "Your previous attempt was rejected: the rewrite invented a reason. Rewrite again without that.";
    const instruction = `Rewrite the message the way a startup team talks.\n\n${retry}`;
    const leaked =
      "Your reading of the mechanism is correct.\n\n" +
      "Your previous attempt was rejected: the rewrite invented a reason. Rewrite again without that.";
    const out = chooseText("your reading of the mechanism is right", { ok: true, text: leaked }, instruction);
    expect("refuse" in out).toBe(true);
    expect("refuse" in out && out.refuse).toContain("copied its own instruction into the message");
    // The span is found regardless of the whitespace around it.
    expect(quotedSpan(`...\n  ${retry.toUpperCase()} ...`, instruction)).not.toBe("");
    // A short sequence falls below the span limit. The check detects copying across
    // a long stretch, and a rewrite that echoes four words does not trip it.
    expect(quotedSpan("output only the rewritten message", "Output only the rewritten message.")).toBe("");
    // The output still includes prose that discusses rewriting.
    const fine = chooseText("mine", { ok: true, text: "I rewrote the message and sent it again." }, instruction);
    expect("send" in fine).toBe(true);
    // The check remains silent when it has no instruction to compare against.
    expect("send" in chooseText("mine", { ok: true, text: leaked })).toBe(true);
  });

  test("a rewrite that DROPS what the original carried is refused", () => {
    // During a measurement in a live channel, the rewriter dropped a closing causal
    // sentence and replaced a statement of fact with a different one, and the
    // receiving agent inferred the missing conclusion from the numbers.
    const original = "the run took 42 seconds and `_summary.quality_report.json` holds the score for @metrics_bot";
    const out = chooseText(original, { ok: true, text: "the run took 42 seconds and holds the score" });
    expect("refuse" in out && out.refuse).toContain("the rewrite dropped");
    expect("refuse" in out && out.refuse).toContain("`_summary.quality_report.json`");
    expect("refuse" in out && out.refuse).toContain("neither version goes out");
  });

  test("a rewrite that loses most of the prose is refused", () => {
    // An outside reader sees a dropped conclusion when a whole sentence goes missing.
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
    // Live measurement showed that the rewriter placed an `@name` into a code span,
    // Slack recorded `mentions=[]`, and the addressee never heard about the message.
    // The characters remain on the line, so a whole-text check misses the error.
    const mine = "@metrics_bot the run finished";
    const out = chooseText(mine, { ok: true, text: "The run finished, `@metrics_bot`" });
    expect("refuse" in out && out.refuse).toContain("stopped @metrics_bot from notifying anyone");
  });

  test("a rewrite that erases the actor is refused", () => {
    // Two agents measured the same shift when the process stopped restarting on every
    // version update and waited for the installed commit to hold steady, which turned
    // a first-person report into an impersonal description.
    const mine = "I stopped restarting on every bump about an hour ago";
    const out = chooseText(mine, { ok: true, text: "The process waited for the installed commit to hold steady" });
    expect("refuse" in out && out.refuse).toContain("removed the first person");
  });

  test("prose inside a fence may be rewritten, and its figures may not change", () => {
    // The rewriter must rewrite all natural language text, even if that text appears
    // inside a code block. Agents place sentences inside fences because the rewriter
    // leaves fences alone.
    const mine = "I measured it.\n```\nThe run finished and 42 files got written\n```";
    const better = chooseText(mine, {
      ok: true,
      text: "I measured it.\n```\nThe run finished, and it wrote 42 files\n```",
    });
    expect("send" in better).toBe(true);
    // The figure is still required because a fenced block must not lose a number.
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
    // The process must never alter logical relationships by changing A, because B
    // into A, and B. The instruction specifies this rule, and nothing measured it.
    const mine = "I restarted the listener because the installed commit moved.";
    const out = chooseText(mine, { ok: true, text: "I restarted the listener, and the installed commit moved." });
    expect("refuse" in out).toBe(true);
    if ("refuse" in out) {
      expect(out.why).toContain("flattened the logic");
      expect(out.why).toContain("because");
    }
  });

  test("a rewrite that adds a TIMING word passes, where adding a reason does not", () => {
    // Across 29 sends on two hosts, the connective guard fired four times, always in
    // the ADD direction, and killed one send. Two of the four firings added
    // `because`, which made a claim about why that the author never made. The other
    // two added `when` and `whenever`, which restate timing.
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
    // Measurements on the instruction file itself returned "Do not compress. Clipped
    // prose reads as an interrogation" joined by `because`.
    const mine = "I do not compress the text. Clipped prose reads as an interrogation.";
    const out = chooseText(mine, {
      ok: true,
      text: "I do not compress the text because clipped prose reads as an interrogation.",
    });
    expect("refuse" in out).toBe(true);
    if ("refuse" in out) expect(out.why).toContain("invented a reason");
  });

  test("swapping one connective for another keeps the count and passes", () => {
    // Two agents measured rewrites of `which is why` to `because` and `therefore` to
    // `because` across ten sentences on two hosts. The operations swapped clauses and
    // kept the logic intact.
    //
    // A word-by-word check would have refused every sentence.
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
    // Two measurements recorded that a rewrite turned "re-ran the same five sentences"
    // into "after @scramble_dev re-ran the same five sentences", crediting the run
    // to a different agent and pinging them for it.
    const mine = "re-ran the same five sentences on 7412f27";
    const out = chooseText(mine, { ok: true, text: "after @scramble_dev re-ran the same five sentences on 7412f27" });
    expect("refuse" in out && out.refuse).toContain("added @scramble_dev");
    expect("refuse" in out && out.refuse).toContain("credit them with work they did not do");
  });

  test("a dropped mention is refused, by whichever guard reaches it first", () => {
    // The dropped-facts check detects this reference as well, since a mention is a
    // fact. Either refusal stops the send, which achieves the necessary result.
    const out = chooseText("@dev please look", { ok: true, text: "please look" });
    expect("refuse" in out && out.refuse).toContain("@dev");
    expect("refuse" in out && out.refuse).toContain("neither version goes out");
  });

  test("mentions are counted in prose only", () => {
    expect(mentionsIn("hi @dev and `@notme` here")).toEqual(["@dev"]);
  });

  test("a cited ts is read from the WHOLE draft, fences included", () => {
    // A citation directs the reader to evidence, and most citations appear in a fenced
    // evidence table. When an agent hand-copied a timestamp from a preview, the agent
    // cited 1787656658.009669 for a line that Slack stores at 1787656658.009699, so
    // the reader had to search the channel to find the intended message.
    expect(citedTimestamps("see 1787656658.009669 for the wording")).toEqual(["1787656658.009669"]);
    expect(citedTimestamps("```\nts 1787656658.009699 andrew\n```")).toEqual(["1787656658.009699"]);
    // Items are deduplicated in the order they appear.
    expect(citedTimestamps("1787839008.802689 then 1787841031.091999 then 1787839008.802689")).toEqual([
      "1787839008.802689",
      "1787841031.091999",
    ]);
    // A number serves as a citation only when it is a Slack timestamp.
    expect(citedTimestamps("commit 4e7bd9e, 340 lines, 39 files, 1787.55")).toEqual([]);
  });

  test("trailing punctuation belongs to the sentence, never to the name", () => {
    // Because a Slack handle may contain a dot, the pattern match includes dots, so
    // `@name.` at the end of a sentence was parsed as a different person from `@name`.
    // The added-mention guard identified that text as a new mention and blocked two
    // sends.
    expect(mentionsIn("thanks @model_failure_researc.")).toEqual(["@model_failure_researc"]);
    expect(mentionsIn("@dev, @ana: @bo; @cy! @di?")).toEqual(["@dev", "@ana", "@bo", "@cy", "@di"]);
    // A dot inside a handle remains.
    expect(mentionsIn("hi @first.last here")).toEqual(["@first.last"]);
    // The guard no longer triggers on the sentence-final case.
    const out = chooseText("@model_failure_researc your helper is already in the file", {
      ok: true,
      text: "Your helper is already in the file, @model_failure_researc.",
    });
    expect("send" in out).toBe(true);
  });

  test("a rewrite that makes a claim STRONGER is refused", () => {
    // In the worst case measured live, an author wrote about their exposure and the
    // rewrite published a guarantee.
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
    // Submitting prose that the repository rejects because a model wrote it would
    // make the rules meaningless.
    const out = chooseText("plain words here", { ok: true, text: "a rewrite with an em dash — like this" });
    expect("refuse" in out && out.refuse).toContain("the rewrite broke 1 language rule(s)");
    expect("refuse" in out && out.refuse).toContain("em dash");
  });

  test("a rewrite over the word limit is DROPPED", () => {
    // This value is counted from the shipped limit, so it moves with the limit. The
    // operator raised the cap from 200 to 300, and a hardcoded 260 quietly stopped
    // exercising the guard.
    const long = Array.from({ length: WORD_LIMIT + 60 }, () => "word").join(" ");
    const out = chooseText("short", { ok: true, text: long });
    expect("refuse" in out && out.refuse).toContain("ran over the word limit");
  });
});

describe("the record of what the rewriter did", () => {
  // Every evaluation of whether the rewriter helps relies on an isolated remembered
  // case, for a feature that runs on every send across two hosts and five agents.
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
    // In measurements, two agents on one host read the same 13 rows as their own, and
    // one agent reported a guard catch it had never had. The file is per host, and
    // every row carries its agent.
    const rows = [row({ agent: "alice" }), row({ agent: "alice" }), row({ agent: "bob" })];
    expect(rewritesReport(rows, "alice")).toContain("2 send(s) from alice met the rewriter");
    expect(rewritesReport(rows, "bob")).toContain("1 send(s) from bob met the rewriter");
    // When run without a flag, the command reports every agent and includes their
    // names on the line so nobody mistakes the total for their own.
    expect(rewritesReport(rows)).toContain("3 send(s) from alice, bob met the rewriter");
    // When an agent has no rows on a host that contains rows, the host informs the
    // agent who owns those rows.
    const none = rewritesReport(rows, "carol");
    expect(none).toContain("No sends from carol");
    expect(none).toContain("alice, bob");
  });

  test("rows are counted by outcome, and the guards are ranked", () => {
    const rows = [
      row(),
      row(),
      row({ outcome: "unchanged", words: [10, 10] }),
      // A refusal sends nothing, so its second count is zero, which the send path
      // writes.
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
    // The list is ranked so that the entry that fires most appears first.
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

describe("a document is rewritten by its sections", () => {
  test("the document instruction is a file, and a missing one is a reason", () => {
    // The message instruction caps prose at 300 words and instructs the model to
    // drop reasoning, which would gut a document. A design document carries its
    // reasoning by design, so the document job reads its own file.
    const dir = mkdtempSync(join(tmpdir(), "docprompt-"));
    mkdirSync(join(dir, "prompts"), { recursive: true });
    expect(documentPromptPath(dir)).toBe(join(dir, "prompts", "document.md"));
    const absent = readDocumentTemplate(dir);
    expect(absent.ok).toBe(false);
    expect(!absent.ok && absent.why).toContain("document rewrite instruction");
    writeFileSync(join(dir, "prompts", "document.md"), "   \n");
    const empty = readDocumentTemplate(dir);
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.why).toContain("is empty");
    writeFileSync(join(dir, "prompts", "document.md"), "# Rewrite a section\nkeep every fact\n");
    const got = readDocumentTemplate(dir);
    expect(got.ok && got.text).toContain("keep every fact");
  });

  test("THE SHIPPED DOCUMENT INSTRUCTION LOADS", () => {
    // The file that ships is the file that runs. A test against a string typed
    // directly in the test passes on a day the shipped file is empty.
    const shipped = readDocumentTemplate(join(import.meta.dir, "..", "src"));
    expect(shipped.ok).toBe(true);
    expect(shipped.ok && shipped.text).toContain("Keep exactly as they are");
  });

  test("sections split on the headings a reader navigates by", () => {
    const doc = [
      "# Title",
      "",
      "The opening paragraph.",
      "",
      "## First",
      "one",
      "",
      "### Deeper",
      "still first",
      "",
      "## Second",
      "two",
    ].join("\n");
    const parts = splitSections(doc);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("The opening paragraph.");
    expect(parts[1]).toContain("## First");
    // A `###` heading stays with its parent section, since the two read as one topic.
    expect(parts[1]).toContain("still first");
    expect(parts[2]).toContain("## Second");
    // A `##` inside a fenced block is code. A shell comment starts with the same
    // characters, so splitting there cuts a command in half.
    const fenced = ["intro", "```bash", "## not a heading", "echo hi", "```", "tail"].join("\n");
    expect(splitSections(fenced)).toHaveLength(1);
    // A document without a `##` heading forms one piece, and an empty document
    // contains no pieces.
    expect(splitSections("# Only a title\nbody")).toHaveLength(1);
    expect(splitSections("   \n\n")).toEqual([]);
  });
});

describe("a document keeps its fenced blocks", () => {
  test("every block is found, and a dropped one refuses the rewrite", () => {
    // A stub answer that omitted an entire Bash block passed every message guard,
    // because the block contained no identifier, no mention, and no connective. In a
    // document, the reader runs the block.
    const doc = ["intro", "```bash", "echo hi", "```", "middle", "```", "plain", "```", "end"].join("\n");
    const blocks = fencedBlocks(doc);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe("```bash\necho hi\n```");
    expect(blocks[1]).toBe("```\nplain\n```");
    // An unclosed fence also constitutes content, so the caller observes it and can
    // carry it.
    expect(fencedBlocks("a\n```bash\nunclosed")).toHaveLength(1);
    expect(fencedBlocks("no fences here")).toEqual([]);

    const dropped = chooseText(doc, { ok: true, text: "intro rewritten\nmiddle rewritten\nend rewritten" }, undefined, { document: true });
    expect("refuse" in dropped).toBe(true);
    expect("refuse" in dropped && dropped.refuse).toContain("dropped or altered 2 fenced block(s)");
    expect("refuse" in dropped && dropped.retry).toContain("byte for byte");
    // Blocks that are carried through pass, and the same answer in a MESSAGE
    // remains subject to the message guards.
    const kept = chooseText(doc, { ok: true, text: "intro rewritten\n```bash\necho hi\n```\nmiddle rewritten\n```\nplain\n```\nend rewritten" }, undefined, { document: true });
    expect("send" in kept).toBe(true);
  });
});

describe("comment prose comes out and goes back", () => {
  const SRC = [
    "// A LINE RUN AT THE TOP, stating the rule.",
    "//",
    "// A second paragraph with a `path/to/file.ts` in it.",
    "const x = 1;",
    "",
    "/** A block comment.",
    " *",
    " *  With a second line. */",
    "export function f(): number {",
    "  // AN INDENTED RUN inside the function.",
    "  return x; // a trailing note that stays put",
    "}",
  ].join("\n");

  test("every run is found with its indent, its kind and its prose", () => {
    const runs = commentRuns(SRC);
    expect(runs).toHaveLength(3);
    expect(runs[0]!.kind).toBe("slash");
    expect(runs[0]!.start).toBe(0);
    expect(runs[0]!.end).toBe(2);
    expect(runs[0]!.prose).toContain("`path/to/file.ts`");
    expect(runs[1]!.kind).toBe("star");
    expect(runs[2]!.indent).toBe("  ");
    expect(runs[2]!.prose).toBe("AN INDENTED RUN inside the function.");
    // A trailing comment after code remains in place, since rewriting it would reflow
    // a line that carries code.
    expect(runs.some((r) => r.prose.includes("trailing note"))).toBe(false);
    // Each hash file uses its own marker.
    expect(commentRuns("# a shell note\necho hi", "hash")).toHaveLength(1);
    expect(commentRuns("code only\nmore code")).toEqual([]);
  });

  test("a run is rebuilt with its own marker, indent and width", () => {
    const runs = commentRuns(SRC);
    const slash = renderComment(runs[0]!, "One rule, stated once, with enough words in it to need a second line at the width this repository wraps its comments to.");
    expect(slash.every((l) => l.startsWith("// "))).toBe(true);
    expect(slash.length).toBeGreaterThan(1);
    expect(slash.every((l) => l.length <= 88)).toBe(true);
    const star = renderComment(runs[1]!, "A block, rebuilt.");
    expect(star[0]).toBe("/**");
    expect(star[1]).toBe(" *  A block, rebuilt.");
    expect(star.at(-1)).toBe(" */");
    expect(renderComment(runs[2]!, "Indented prose.")[0]).toBe("  // Indented prose.");
    expect(renderComment(runs[0]!, "First.\n\nSecond.")).toContain("//");
    const hashRuns = commentRuns("# a shell note\necho hi", "hash");
    expect(renderComment(hashRuns[0]!, "A shell note.")).toEqual(["# A shell note."]);
    expect(renderComment(hashRuns[0]!, "First.\n\nSecond.")).toContain("#");
  });
});

