// REWRITING A MESSAGE BEFORE IT LEAVES, with a model.
//
// Asked for directly: "For every sentence gone through scramble message, using
// Gemini 3.7 flash to rewrite it to professional product and technical
// communication standards."
//
// My objection was that a rewriter can change what a claim SAYS, turning "did
// not reach" into "may not have reached". The answer that settled it: an agent
// that already publishes wrong claims on its own gets no new failure mode from
// this, so the argument reduces to "rewriting does not fix that", which is a
// reason to want more, and no reason to refuse.
//
// What the shape has to guarantee:
//
//   The message ALWAYS goes. A model that is slow, missing or broken costs the
//   sender a rewrite, and never the message.
//
//   Nothing changes silently. When a rewrite is sent, the original is printed
//   beside it, so the sender sees what was changed at the moment it happens.
//
//   The deterministic rules still decide. A rewrite is checked exactly as the
//   sender's own words are, and one that breaks a rule is dropped in favour of
//   the words that did pass.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lengthRefusal, lintLanguage, proseOf } from "./language";

/** Which service answers. Gemini has its own request shape; Fireworks and
 *  LiteLLM both speak the OpenAI chat-completions shape, so they are one code
 *  path with different addresses. */
export type Provider = "gemini" | "fireworks" | "litellm";

/** Where the rewrite comes from, and how long it may take. */
export interface RewriteConfig {
  /** The API key. Absent means this whole feature is off. */
  key?: string;
  provider: Provider;
  /** The model id, so a newer one needs no code change. */
  model: string;
  /** The base URL. LiteLLM is a proxy anyone can host, so its address is
   *  configuration; the other two have one address each. */
  url: string;
  /** Milliseconds before the rewrite is abandoned and the original sent. */
  timeoutMs: number;
}

export const DEFAULT_TIMEOUT_MS = 5000;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const FIREWORKS_BASE = "https://api.fireworks.ai/inference/v1";
const DEFAULT_MODELS: Record<Provider, string> = {
  gemini: "gemini-3.7-flash",
  fireworks: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  litellm: "gpt-4o-mini",
};
/** Kept for the tests and callers that ask what a bare config resolves to. */
export const DEFAULT_MODEL = DEFAULT_MODELS.gemini;

/** Read the config off the environment.
 *
 *  `SCRAMBLE_REWRITE_KEY` turns it on, and `GEMINI_API_KEY` does the same for
 *  the Gemini case so an existing credential needs no new name.
 *  `SCRAMBLE_REWRITE_PROVIDER` picks the service, `SCRAMBLE_REWRITE_MODEL` a
 *  model, `SCRAMBLE_REWRITE_URL` the address for a self-hosted LiteLLM, and
 *  `SCRAMBLE_REWRITE_TIMEOUT_MS` a slower link.
 *
 *  An unknown provider name falls back to gemini and is NOT silently accepted as
 *  its own thing: a typo that reached a real request would fail per message with
 *  a network error, where this fails once, visibly, at the first send. */
export function rewriteConfig(env: (name: string) => string | undefined): RewriteConfig {
  const raw = Number(env("SCRAMBLE_REWRITE_TIMEOUT_MS"));
  const key = env("SCRAMBLE_REWRITE_KEY") ?? env("GEMINI_API_KEY");
  const named = env("SCRAMBLE_REWRITE_PROVIDER");
  const provider: Provider =
    named === "fireworks" || named === "litellm" || named === "gemini" ? named : "gemini";
  const base = env("SCRAMBLE_REWRITE_URL");
  return {
    ...(key === undefined || key === "" ? {} : { key }),
    provider,
    model: env("SCRAMBLE_REWRITE_MODEL") ?? DEFAULT_MODELS[provider],
    url: base !== undefined && base !== "" ? base.replace(/\/$/, "") : provider === "fireworks" ? FIREWORKS_BASE : GEMINI_BASE,
    timeoutMs: Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS,
  };
}

/** The address and body for one provider. Split out so the request shape is
 *  readable beside the thing it is a shape FOR. */
function request(cfg: RewriteConfig & { key: string }, prompt: string): { url: string; init: RequestInit } {
  if (cfg.provider === "gemini") {
    return {
      url: `${cfg.url}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    };
  }
  // Fireworks and LiteLLM: the OpenAI chat-completions shape, bearer auth.
  return {
    url: `${cfg.url}/chat/completions`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: prompt }] }),
    },
  };
}

/** WHERE THE INSTRUCTION LIVES: a markdown file beside the code, so it can be
 *  read and changed without touching TypeScript, and so the language gate lints
 *  it like every other document this repo ships. */
/** ONE ROW PER SEND THAT MET THE REWRITER, so the question "does this help" is
 *  answered by a number. Every earlier answer was an anecdote.
 *
 *  The rewriter runs on every send from two hosts and five agents, and nobody can
 *  say how often it improves a message, how often a guard refuses one, or which
 *  guard fires most. Every claim about it today has been a single case somebody
 *  remembered (2026-08-25).
 *
 *  `outcome` is one of: `sent` (a rewrite went out), `unchanged` (the model
 *  returned what it was given), `retried` (the first attempt was refused and the
 *  second went out), `refused` (both attempts failed a guard), `skipped` (the
 *  call itself did not happen). `why` carries the guard's label for a refusal. */
export interface RewriteRecord {
  at: string;
  agent: string;
  channel: string;
  outcome: "sent" | "unchanged" | "retried" | "refused" | "skipped";
  why?: string;
  /** Prose words before and after, so a reader sees what the rewrite did to
   *  length without keeping either text. */
  words: [number, number];
}

export function rewritesPath(configPath: string): string {
  return join(dirname(configPath), "rewrites.jsonl");
}

export function recordRewrite(path: string, row: RewriteRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

export function readRewrites(path: string): RewriteRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: RewriteRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as RewriteRecord;
      if (typeof row.outcome === "string") out.push(row);
    } catch {
      continue;
    }
  }
  return out;
}

/** What the rows say, in the shape a person asks it. */
export function rewritesReport(rows: RewriteRecord[], agent?: string): string {
  // ONE FILE PER HOST, AND THE AGENT IS ON EVERY ROW. `--as` named nothing here,
  // so two agents sharing a host read each other's counts as their own and one
  // of them reported a guard catch it had never had (xingyubot, 2026-08-25).
  const all = rows;
  if (agent !== undefined && agent !== "") rows = rows.filter((r) => r.agent === agent);
  if (rows.length === 0) {
    const others = new Set(all.map((r) => r.agent));
    return agent !== undefined && agent !== "" && all.length > 0
      ? `No sends from ${agent} have met the rewriter on this host. ${all.length} row(s) here belong to ` +
          `${[...others].sort().join(", ")}.`
      : `No sends have met the rewriter on this host yet. A row is written per send ` +
          `while a key is configured, so an empty file means the rewrite is off or nothing has been sent.`;
  }
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.outcome, (by.get(r.outcome) ?? 0) + 1);
  const refusals = new Map<string, number>();
  for (const r of rows) {
    if (r.outcome === "refused" || r.outcome === "retried") {
      const why = r.why ?? "unnamed";
      refusals.set(why, (refusals.get(why) ?? 0) + 1);
    }
  }
  const order: RewriteRecord["outcome"][] = ["sent", "unchanged", "retried", "refused", "skipped"];
  const counts = order
    .filter((o) => (by.get(o) ?? 0) > 0)
    .map((o) => `  ${o.padEnd(10)} ${by.get(o)}`)
    .join("\n");
  const guards =
    refusals.size === 0
      ? ""
      : `\nWhat the guards caught:\n` +
        [...refusals.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([why, n]) => `  ${n}  ${why}`)
          .join("\n");
  const grew = rows.filter((r) => r.words[1] > r.words[0]).length;
  // WHOSE ROWS THESE ARE, on the first line. The file is shared by every agent
  // on the host, so a count with no name on it invites the reader to take it for
  // their own.
  const whose =
    agent !== undefined && agent !== ""
      ? ` from ${agent}`
      : ` from ${[...new Set(all.map((r) => r.agent))].sort().join(", ")}`;
  return (
    `${rows.length} send(s)${whose} met the rewriter, from ` +
    `${new Date(rows[0]?.at ?? "").toISOString().slice(0, 10)}:\n` +
    `${counts}${guards}\n` +
    `${grew} of them came back longer than the draft.`
  );
}

/** What to ask the model when someone wants the DIAGNOSIS, with no fix attached.
 *
 *  The operator, 2026-08-26, about a refusal message this tool prints: "Use
 *  gemini 3.7 to find why the communication is wrong." A rewrite shows a better
 *  version and leaves the author guessing which of their habits produced the
 *  worse one. */
export function critiquePrompt(text: string): string {
  return (
    `You are a very experienced Member of Technical Staff in a frontier AI company reviewing a ` +
    `message written by a coding agent that communicates badly.\n\n` +
    `Name what is wrong with it, worst first, at most five points. For each one quote the exact ` +
    `words and say in one sentence what a reader loses. Judge the writing: buried answer, missing ` +
    `subject, a clause that carries no information, an anecdote the reader did not ask for, ` +
    `length that hides the point, a word doing no work. Do not rewrite it and do not praise it.\n\n` +
    `---\n${text}`
  );
}

export function promptPath(moduleDir: string): string {
  return join(moduleDir, "prompts", "rewrite.md");
}

/** Read the instruction. A missing or empty file is a REASON, never a default:
 *  a rewrite driven by no instruction is worse than no rewrite, since the model
 *  would be free to do anything to a claim. */
export function readPromptTemplate(moduleDir: string): { ok: true; text: string } | { ok: false; why: string } {
  const path = promptPath(moduleDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, why: `the rewrite instruction at ${path} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Everything above the first `---` on its own line is the file explaining
  // itself to a human. The model gets what follows.
  const body = raw.split(/\n---\n/).slice(1).join("\n---\n").trim();
  if (body === "") return { ok: false, why: `the rewrite instruction at ${path} carries no instruction below its first --- line` };
  return { ok: true, text: body };
}

/** The instruction with the message appended, which is what the model receives. */
export function composePrompt(template: string, text: string): string {
  return `${template}\n\n---\n${text}`;
}

/** The Gemini REST call, returning the rewritten text or a reason it is absent.
 *
 *  Every failure is a REASON, never a throw: the caller sends the original and
 *  says why the rewrite is missing. */
export async function rewriteWith(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  cfg: RewriteConfig,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  if (cfg.key === undefined) return { ok: false, why: "no rewrite key configured" };
  const { url, init } = request({ ...cfg, key: cfg.key }, prompt);
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: control.signal });
  } catch (e) {
    return { ok: false, why: `the rewrite call failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return { ok: false, why: `the rewrite call answered ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, why: "the rewrite answer was not JSON" };
  }
  const out = cfg.provider === "gemini" ? firstText(body) : firstChoice(body);
  if (out === undefined || out.trim() === "") return { ok: false, why: "the rewrite answer carried no text" };
  return { ok: true, text: out.trim() };
}

/** The first message of an OpenAI chat-completions reply, defensively: the body
 *  comes from a service, and a shape that surprises us must cost the rewrite and
 *  never the message. */
function firstChoice(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  return typeof content === "string" ? content : undefined;
}

/** The first text part of a generateContent reply, defensively. */
function firstText(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const parts = (candidates[0] as { content?: { parts?: unknown } }).content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const t = (parts[0] as { text?: unknown }).text;
  return typeof t === "string" ? t : undefined;
}

/** Words that change how strong a claim is. A rewrite may not introduce one the
 *  original never used, in either direction.
 *
 *  Measured live, and the worst case in the set: an author wrote about their
 *  exposure and the rewrite published a guarantee, "the diff check PREVENTS the
 *  rewriter from silently replacing measured numbers" (2026-08-25). The reverse
 *  is the failure the instruction already names, a fact softened into an
 *  impression. Both are the same defect: the strength of a claim is the author's
 *  to set. */
const STRENGTH = /\b(prevents?|guarantees?|ensures?|eliminates?|always|never|cannot|impossible|entirely|fully|completely|may|might|appears?|seems?|likely|possibly|generally|typically|usually)\b/gi;

/** Strength words the REWRITE introduced. Case-folded, and counted by
 *  presence, so a word the author already used stays the author's. */
export function strengthDrift(original: string, rewritten: string): string[] {
  const had = new Set([...proseOf(original).matchAll(STRENGTH)].map((m) => m[0].toLowerCase()));
  const added = new Set<string>();
  for (const m of proseOf(rewritten).matchAll(STRENGTH)) {
    const w = m[0].toLowerCase();
    if (!had.has(w)) added.add(w);
  }
  return [...added];
}

/** The words that say how two facts relate. A rewrite keeps as many as the
 *  original had, no more and no fewer.
 *
 *  The operator, 2026-08-25: "rewrite should be explicitly insturcted to exactly
 *  preserve the causal and logic structure. it should never break the logic such
 *  as A, because B into A, and B." The instruction said so and nothing measured
 *  it. Running the instruction file through the rewriter produced the opposite
 *  fault in the same minute: "Do not compress. Clipped prose reads as an
 *  interrogation" came back as "We do not compress the text BECAUSE clipped
 *  prose reads like an interrogation", inventing a causal claim from two
 *  adjacent statements.
 *
 *  COUNTED AS A CLASS. Two agents measured `which is why` ->
 *  `because` and `therefore` -> `because` across ten sentences on two hosts, with
 *  the clauses swapped and the logic intact (2026-08-25). Swapping one connective
 *  for another keeps the count and passes; flattening a link into `and` or a full
 *  stop drops the count, and inventing one raises it. */
const CONNECTIVES =
  /\b(because|so|since|therefore|thus|hence|if|unless|when|whenever|although|though|but|however|otherwise|which means|as a result|that is why|which is why|in order to)\b/gi;

/** How many connectives each text carries, and which ones, for the refusal. */
export function connectivesIn(text: string): string[] {
  return [...proseOf(text).matchAll(CONNECTIVES)].map((m) => m[0].toLowerCase());
}

/** The connectives that state WHY, which is the half a rewrite must not invent.
 *
 *  MEASURED over 29 sends on two hosts: the connective guard fired four times,
 *  every one of them in the ADD direction, and it killed one send outright. Two
 *  of the four added `because`, which is a claim about why that the author did
 *  not make. The other two added `when` and `whenever`, which restate timing and
 *  invent nothing (2026-08-26).
 *
 *  So the DROP check keeps the whole class, since losing any link flattens the
 *  logic, and the ADD check counts these only. */
const CAUSAL = /\b(because|so|since|therefore|thus|hence|which means|as a result|that is why|which is why)\b/gi;

export function causalIn(text: string): string[] {
  return [...proseOf(text).matchAll(CAUSAL)].map((m) => m[0].toLowerCase());
}

/** What the send should post, and what it should say about it.
 *
 *  A rewrite that breaks a language rule is DROPPED: the sender's own words
 *  already passed, and posting prose the repo refuses because a model wrote it
 *  would make the rules mean nothing. */
/** Things the rewrite must still carry, taken out of the ORIGINAL.
 *
 *  Backticked spans and fenced blocks, numbers, @mentions, URLs and file paths.
 *  A rewrite missing any of them changed the evidence, whatever it did to the
 *  prose. */
/** The refusal a failed rewrite produces, carrying what the model returned so the
 *  author sees what happened before writing it again. */
function refusal(what: string, attempt: string): { refuse: string; why: string; attempt: string; retry: string } {
  return {
    refuse:
      `message send REFUSED: ${what}, so neither version goes out.\n` +
      `What the rewriter produced:\n${attempt}\n` +
      `Rewrite your message and send again.`,
    // THE SAME TWO FACTS, FOR A READER THAT IS NOT A SEND. The ledger wants the
    // guard's name and `scramble rewrite` wants the model's answer with no
    // sentence about sending, since it never sends. Both come from here, so the
    // refusal a person reads and the row a counter reads cannot disagree.
    why: what,
    attempt,
    // WHAT TO TELL THE MODEL ON A SECOND ATTEMPT. Every guard here fires on
    // something the MODEL did, so the model is the party that can fix it. Two
    // agents wrote prose that avoided a banned form on purpose, the rewriter put
    // it back, and the send died with both versions refused (2026-08-25).
    retry: `Your previous attempt was rejected: ${what}. Rewrite again without that.`,
  };
}

export function factsIn(text: string): string[] {
  const out = new Set<string>();
  // AN INLINE SPAN IS AN IDENTIFIER and survives byte for byte: a ts, a flag, a
  // filename, a command.
  for (const m of text.matchAll(/`[^`\n]+`/g)) out.add(m[0]);
  // A FENCED BLOCK IS NOT EXEMPT PROSE. The operator, 2026-08-26: "any natural
  // language text MUST be rewritten even if it is in the code block." An agent
  // had said the quiet part out loud an hour earlier: they put sentences in
  // fences because the rewriter edits prose and leaves fenced blocks alone.
  //
  // So the block text is no longer required verbatim, and what it MEASURES
  // still is: every number, id, mention, url and path inside it has to come
  // back. A rewrite may turn the sentences in a fence into better sentences,
  // and it may not change a figure.
  for (const m of text.matchAll(/```[\s\S]*?```/g)) for (const a of atomsIn(m[0])) out.add(a);
  for (const a of atomsIn(proseOf(text))) out.add(a);
  out.delete("");
  return [...out];
}

/** The parts of a text that MEASURE something: numbers, mentions, urls, paths.
 *  A rewrite that loses one of these changed the evidence. */
function atomsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b\d[\d.,:_-]*\b/g)) out.push(m[0]);
  for (const m of text.matchAll(/@[A-Za-z0-9._-]+/g)) out.push(m[0]);
  for (const m of text.matchAll(/https?:\/\/\S+/g)) out.push(m[0]);
  for (const m of text.matchAll(/(?:^|\s)(\/[A-Za-z0-9._\/-]{3,})/g)) out.push(m[1] ?? "");
  return out;
}

/** The mentions that will NOTIFY someone: `@name` in prose.
 *
 *  A mention inside a backtick span notifies nobody, and Slack records the
 *  message with an empty `mentions` list. Measured live: the rewriter moved an
 *  `@name` into a code span and the addressee never heard about the message
 *  (2026-08-25). The whole-text check misses this, since the characters are
 *  still there.
 *
 *  Keeping mentions working is the point of the message, so this is checked in
 *  PROSE on both sides. */
export function mentionsIn(text: string): string[] {
  // TRAILING PUNCTUATION BELONGS TO THE SENTENCE. A Slack handle may contain a
  // dot, so the match takes one and `@name.` at the end of a sentence read as a
  // different person from `@name`: the added-mention guard called it a new
  // mention and blocked two sends by the agent writing them (2026-08-25).
  return [
    ...new Set(
      [...proseOf(text).matchAll(/@[A-Za-z0-9._-]+/g)].map((m) => m[0].replace(/[.,:;!?]+$/, "")).filter((m) => m !== "@"),
    ),
  ];
}

/** How much of the original's prose survived, as a fraction. Whole sentences
 *  disappearing is what a dropped conclusion looks like from outside. */
export function proseRatio(original: string, rewritten: string): number {
  const words = (t: string): number => proseOf(t).split(/\s+/).filter((w) => w !== "").length;
  const before = words(original);
  return before === 0 ? 1 : words(rewritten) / before;
}

/** The share of the original's prose a rewrite may drop before it is refused. */
export const MIN_PROSE_RATIO = 0.6;

/** What the send does with a rewrite. `send` carries the text to post; `refuse`
 *  carries the reason the send stops.
 *
 *  THE ORIGINAL NO LONGER GOES OUT WHERE THE REWRITE IS ON, 2026-08-25: "we
 *  should not allow claude original message go out. The communication is too
 *  bad." Falling back to the author's words on a failed rewrite published exactly
 *  the prose the rewrite exists to replace. A rewrite that cannot be used stops
 *  the send and says what happened, and the author writes it again, which is what
 *  the language rules already require.
 *
 *  With no key configured the rewriter is OFF and this is never consulted. */
export type RewriteChoice =
  | { send: string; note: string }
  | { refuse: string; why: string; attempt?: string; retry?: string };

export function chooseText(
  original: string,
  rewritten: { ok: true; text: string } | { ok: false; why: string },
): RewriteChoice {
  if (!rewritten.ok) {
    return {
      refuse:
        `message send REFUSED: the rewrite did not happen (${rewritten.why}), and your own words ` +
        `do not go out while the rewrite is on. Fix the rewriter, or unset SCRAMBLE_REWRITE_KEY ` +
        `for this send if the message has to go now.`,
      why: `the rewrite did not happen (${rewritten.why})`,
    };
  }
  if (rewritten.text.trim() === original.trim()) return { send: original, note: "" };
  const over = lengthRefusal(rewritten.text);
  if (over !== "") {
    return refusal("the rewrite ran over the word limit", rewritten.text);
  }
  // WHAT THE ORIGINAL CARRIED MUST STILL BE THERE. Measured in a live channel:
  // the rewriter dropped a closing causal sentence and replaced a statement of
  // fact with a different one, and the receiving agent then inferred the missing
  // conclusion from the numbers (2026-08-25). The instruction already demands
  // both; this refuses the rewrite when the demand went unmet.
  const lost = factsIn(original).filter((f) => !rewritten.text.includes(f));
  if (lost.length > 0) {
    return refusal(
        `the rewrite dropped ${lost.length} thing(s) yours carried: ${lost.slice(0, 5).join(", ")}`,
        rewritten.text,
    );
  }
  // A MENTION THAT STOPPED NOTIFYING IS A LOST MENTION, even with the characters
  // still on the line.
  const keptMentions = mentionsIn(rewritten.text);
  const mine = mentionsIn(original);
  // A MENTION THE AUTHOR NEVER WROTE notifies someone they did not address, and
  // it can invent attribution. Measured twice: a rewrite turned "re-ran the same
  // five sentences" into "after @scramble_dev re-ran the same five sentences",
  // crediting the run to a different agent and pinging them for it
  // (2026-08-25).
  const addedMentions = keptMentions.filter((m) => !mine.includes(m));
  if (addedMentions.length > 0) {
    return refusal(
      `the rewrite added ${addedMentions.join(", ")}, which yours never mentioned, so it notifies ` +
        `someone you did not address and can credit them with work they did not do`,
      rewritten.text,
    );
  }
  const lostMentions = mine.filter((m) => !keptMentions.includes(m));
  if (lostMentions.length > 0) {
    return refusal(
        `the rewrite stopped ${lostMentions.join(", ")} from notifying anyone, by moving it into ` +
          `code or dropping it`,
        rewritten.text,
    );
  }
  // THE ACTOR STAYS THE ACTOR. Two agents measured the same shift: "I stopped
  // restarting on every bump" became "The process waited for the installed
  // commit to hold steady", and a first-person report turned into a description
  // with nobody in it (2026-08-25). Who did a thing is part of the claim.
  const firstPerson = /\b(I|I'm|I've|my|me|we|we're|we've|our)\b/i;
  if (firstPerson.test(proseOf(original)) && !firstPerson.test(proseOf(rewritten.text))) {
    return refusal(
      `the rewrite removed the first person from a message that had it, so who did the thing is gone`,
      rewritten.text,
    );
  }
  // THE LOGIC IS THE AUTHOR'S. `A, because B` carries a claim about why, and two
  // true facts with the connective gone leave a reader nothing to object to.
  const myLinks = connectivesIn(original);
  const keptLinks = connectivesIn(rewritten.text);
  if (keptLinks.length < myLinks.length) {
    return refusal(
      `the rewrite flattened the logic: yours has ${myLinks.length} connective(s) ` +
        `(${[...new Set(myLinks)].slice(0, 6).join(", ") || "none"}) and the rewrite has ` +
        `${keptLinks.length} (${[...new Set(keptLinks)].slice(0, 6).join(", ") || "none"}), so a stated ` +
        `link between two facts is gone`,
      rewritten.text,
    );
  }
  const myWhy = causalIn(original);
  const keptWhy = causalIn(rewritten.text);
  if (keptWhy.length > myWhy.length) {
    return refusal(
      `the rewrite invented a reason: yours states why ${myWhy.length} time(s) ` +
        `(${[...new Set(myWhy)].slice(0, 6).join(", ") || "never"}) and the rewrite ${keptWhy.length} ` +
        `(${[...new Set(keptWhy)].slice(0, 6).join(", ")}), so it claims a cause you did not`,
      rewritten.text,
    );
  }
  const stronger = strengthDrift(original, rewritten.text);
  if (stronger.length > 0) {
    return refusal(
        `the rewrite introduced ${stronger.join(", ")}, which yours did not use, and how strong a ` +
          `claim is belongs to whoever made it`,
        rewritten.text,
    );
  }
  const kept = proseRatio(original, rewritten.text);
  if (kept < MIN_PROSE_RATIO) {
    return refusal(
        `the rewrite kept ${Math.round(kept * 100)}% of your prose, under the ` +
          `${Math.round(MIN_PROSE_RATIO * 100)}% floor, and a whole sentence going missing is what a ` +
          `dropped conclusion looks like`,
        rewritten.text,
    );
  }
  const hits = lintLanguage(rewritten.text);
  if (hits.length > 0) {
    return refusal(
        `the rewrite broke ${hits.length} language rule(s): ${hits.map((h) => h.label).join(", ")}`,
        rewritten.text,
    );
  }
  return { send: rewritten.text, note: `sent a rewrite. Your words were:\n${original}` };
}
