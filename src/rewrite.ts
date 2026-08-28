// REWRITING A MESSAGE BEFORE IT LEAVES, with a model.
//
// Gemini 3.7 flash rewrites every sentence processed by scramble message to meet
// professional product and technical communication standards.
//
// A rewriter can alter the strength of a claim, such as converting "did not reach"
// into "may not have reached". An agent that already publishes inaccurate claims
// introduces no new failure mode through this process, so the limitation reduces
// to the fact that rewriting does not resolve existing inaccuracies, which is a
// reason to seek further improvements and no reason to refuse the feature.
//
// The design guarantees three behaviors:
//
// The system always delivers the message. A model that is slow, missing, or
// broken costs the sender a rewrite, and the message still delivers.
//
// Modifications never occur silently. When the system sends a rewrite, it prints
// the original text alongside the rewrite so the sender sees the modifications
// immediately.
//
// Deterministic rules govern acceptance. The system validates a rewrite using the
// same checks applied to the sender's original text. When a rewrite violates a
// rule, the system discards it and transmits the original text that passed
// validation.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lengthRefusal, lintLanguage, proseOf } from "./language";
// The system reuses the duplicate guard's text comparison so a document rewrite
// is measured the same way a repeated message is. The inbox reaches only
// `slack-backend` and `language`, and neither file reaches back here.
import { allWords, contentOf, wordOverlap } from "./inbox";

/**
 *  The request structure depends on which service answers. Gemini uses its own
 *  request shape. Fireworks and LiteLLM both use the OpenAI chat-completions shape,
 *  so they share a single code path with different addresses.
 */
export type Provider = "gemini" | "fireworks" | "litellm";

/**
 *  The rewrite originates from its source, and the process may take time.
 */
export interface RewriteConfig {
  /**
   *  Provide the API key. If the key is absent, the entire feature is off.
   */
  key?: string;
  provider: Provider;
  /**
   *  Specify the model ID, so a newer model needs no code change.
   */
  model: string;
  /**
   *  Set the base URL. Anyone can host the LiteLLM proxy, so its address is
   *  configured by the operator; the other two each have one address.
   */
  url: string;
  /**
   *  Milliseconds elapse before the system abandons the rewrite and sends the
   *  original.
   */
  timeoutMs: number;
}

/**
 *  This host measured request latency against the configured LiteLLM endpoint.
 *  Five cold calls on a 6674-character prompt, each worded differently to miss the
 *  service's cache, completed in 6914, 15189, 7931, 10217 and 9937 ms. A cached
 *  repeat returns in 47 to 92 ms.
 *
 *  This timeout value handles tail latency. One send in the same window passed
 *  60002 ms on a prompt of that size and its retry answered normally, so the stall
 *  sits outside the generation time the five calls measure. A ceiling is a bet on
 *  that tail either way: the send asks twice, and the refusal names the ceiling,
 *  the elapsed time and the prompt size, so a host that keeps hitting it can raise
 *  `SCRAMBLE_REWRITE_TIMEOUT_MS` from its own numbers.
 *
 *  A timeout of five seconds refused the send on any draft the model had not seen,
 *  and that refusal read as an endpoint failure.
 */
export const DEFAULT_TIMEOUT_MS = 60000;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const FIREWORKS_BASE = "https://api.fireworks.ai/inference/v1";
const DEFAULT_MODELS: Record<Provider, string> = {
  gemini: "gemini-3.7-flash",
  fireworks: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  litellm: "gpt-4o-mini",
};
/**
 *  This function remains for tests and callers that determine what a bare
 *  configuration resolves to.
 */
export const DEFAULT_MODEL = DEFAULT_MODELS.gemini;

/**
 *  The system reads its configuration from the environment.
 *
 *  Setting `SCRAMBLE_REWRITE_KEY` enables rewriting, and setting `GEMINI_API_KEY`
 *  does the same for Gemini so an existing credential needs no new name.
 *  `SCRAMBLE_REWRITE_PROVIDER` selects the service, `SCRAMBLE_REWRITE_MODEL`
 *  picks a model, `SCRAMBLE_REWRITE_URL` specifies the address for a self-hosted
 *  LiteLLM instance, and `SCRAMBLE_REWRITE_TIMEOUT_MS` accommodates a slower link.
 *
 *  An unknown provider name falls back to gemini and is not silently accepted as
 *  a distinct service. A typo that reached a real request would fail per message
 *  with a network error, where this approach fails once, visibly, at the first
 *  send.
 */
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

/**
 *  This definition provides the address and the body for a single provider. It is
 *  split out so that the request shape is readable alongside the provider it
 *  configures.
 */
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
  // Fireworks and LiteLLM use the OpenAI chat completions format and authenticate
  // with bearer tokens.
  return {
    url: `${cfg.url}/chat/completions`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: prompt }] }),
    },
  };
}

/**
 *  The instruction lives in a markdown file beside the code, so a reader can
 *  read and change it without editing TypeScript, and so the language gate lints
 *  it like every other document this repository ships.
 */
/**
 *  The log records one row for every send that reached the rewriter, so a number
 *  answers whether the tool helps. Every earlier answer was an anecdote.
 *
 *  The rewriter runs on every send from two hosts and five agents, and no one can
 *  say how often it improves a message, how often a guard refuses one, or which
 *  guard fires most. Every claim about the rewriter today has been a single case
 *  someone remembered.
 *
 *  The `outcome` field holds one of several values: `sent` (a rewrite went out),
 *  `unchanged` (the model returned what it was given), `retried` (the first attempt
 *  was refused and the second went out), `refused` (both attempts failed a guard),
 *  or `skipped` (the call itself did not happen). The `why` field carries the
 *  guard's label for a refusal.
 */
export interface RewriteRecord {
  at: string;
  agent: string;
  channel: string;
  outcome: "sent" | "unchanged" | "retried" | "refused" | "skipped";
  why?: string;
  /**
   *  The document records prose word counts before and after the edit, so a reader
   *  sees what the rewrite did to length without keeping either text.
   */
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

/**
 *  The rows present their data in the format a person requests.
 */
export function rewritesReport(rows: RewriteRecord[], agent?: string): string {
  // Each host uses one file, and every row records the agent. The `--as` flag
  // named nothing here, so two agents sharing a host read each other's counts as
  // their own and one of them reported a guard catch it had never had.
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
  // The first line identifies whose rows these are. Every agent on the host shares
  // the file, so an unnamed count invites the reader to take it for their own.
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

/**
 *  Prompt the model for a diagnosis without an attached fix.
 *
 *  When evaluating a refusal message that this tool prints, ask Gemini 3.7 to find
 *  why the communication is wrong. A rewrite shows a better version and leaves the
 *  author guessing which habits produced the worse one.
 */
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

/**
 *  The system appends the register block for a tier to the instruction.
 *
 *  Two files sit beside the instruction, so the difference between speaking to
 *  agents and speaking to people is readable in one place and editable without
 *  touching code.
 */
export function tierPromptPath(moduleDir: string, tier: string): string {
  return join(moduleDir, "prompts", `tier-${tier}.md`);
}

/**
 *  The loader reads an instruction file whole. An empty file yields a reason.
 *
 *  The whole file is the instruction. Both loaders previously kept only what
 *  followed a `---` line, so the text above it could explain the file to a reader.
 *  An operator rewrote `prompts/rewrite.md` and dropped that line with the note
 *  (228f53a), which left the loader refusing and every send posting unrewritten
 *  with a reason. A prose edit that disarms the rewriter is a rule hiding inside a
 *  file whose whole purpose is prose, where the person editing it cannot see the
 *  rule. Reading the file whole keeps the guarantee that no rewrite runs on an
 *  empty instruction.
 */
function readInstructionFile(path: string, label: string): { ok: true; text: string } | { ok: false; why: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, why: `${label} at ${path} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = raw.trim();
  if (body === "") return { ok: false, why: `${label} at ${path} is empty, so no rewrite can run from it` };
  return { ok: true, text: body };
}

export function readTierBlock(moduleDir: string, tier: string): { ok: true; text: string } | { ok: false; why: string } {
  return readInstructionFile(tierPromptPath(moduleDir, tier), `the ${tier} register`);
}

export function promptPath(moduleDir: string): string {
  return join(moduleDir, "prompts", "rewrite.md");
}

export function documentPromptPath(moduleDir: string): string {
  return join(moduleDir, "prompts", "document.md");
}

/**
 *  This instruction governs the rewriting of a repository document, which differs
 *  from rewriting a message.
 *
 *  The message instruction would gut a document because it caps prose at 300 words,
 *  tells the model to drop reasoning and process detail, and asks for a Slack
 *  message from a startup team. A design document carries 4000 words of
 *  reasoning by design.
 */
export function readDocumentTemplate(moduleDir: string): { ok: true; text: string } | { ok: false; why: string } {
  return readInstructionFile(documentPromptPath(moduleDir), "the document rewrite instruction");
}

/**
 *  The splitter divides a document into the pieces a single model call handles:
 *  the text before the first heading, then each `##` section with everything under
 *  it.
 *
 *  Whole-file calls fail in two ways. A 6000-word document runs past the output
 *  length a single call returns, and a stall costs the whole file where a section
 *  would have been the only loss. Sections are also the unit a reader skips by, so a
 *  rewrite that keeps their boundaries keeps the document navigable.
 *
 *  Splits occur at `##` headings, while deeper headings stay inside their parent
 *  section, since a `###` under a `##` reads as one topic. A document with no `##`
 *  heading forms a single piece.
 */
export function splitSections(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of lines) {
    // A `##` inside a fence counts as code, and shell comments start with the same
    // characters, so the fence state determines whether a line is a heading.
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line) && current.length > 0) {
      out.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) out.push(current.join("\n"));
  return out.filter((s) => s.trim() !== "");
}

/**
 *  The system reads the instruction. A missing or empty file constitutes a
 *  reason. A rewrite driven by no instruction is worse than no rewrite, since the
 *  model would be free to do anything to a claim.
 */
export function readPromptTemplate(moduleDir: string): { ok: true; text: string } | { ok: false; why: string } {
  return readInstructionFile(promptPath(moduleDir), "the rewrite instruction");
}

/**
 *  The model receives the instruction with the appended message.
 */
export function composePrompt(template: string, text: string, register?: string): string {
  const withRegister = register === undefined || register === "" ? template : `${template}\n\n${register}`;
  return `${withRegister}\n\n---\n${text}`;
}

/**
 *  The Gemini REST call returns the rewritten text or the reason it is absent.
 *
 *  The call reports every failure as a reason code: the caller sends the original
 *  text and states why the rewrite is missing.
 */
export async function rewriteWith(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  cfg: RewriteConfig,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  if (cfg.key === undefined) return { ok: false, why: "no rewrite key configured" };
  const { url, init } = request({ ...cfg, key: cfg.key }, prompt);
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), cfg.timeoutMs);
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: control.signal });
  } catch (e) {
    // Local limits cause this failure while the endpoint remains operational. The
    // system reported "the rewrite call failed: The operation was aborted." for a call
    // that the service was still answering, and the sender prints that line while
    // refusing to post, so the reader investigates an endpoint that is up. The error
    // sentence must include the number that stopped the call.
    const ms = Math.round(performance.now() - started);
    if (control.signal.aborted) {
      return {
        ok: false,
        why:
          `the rewrite call passed this build's ${cfg.timeoutMs} ms ceiling after ${ms} ms on a ` +
          `${prompt.length}-character prompt, and nothing here says the service failed. ` +
          `SCRAMBLE_REWRITE_TIMEOUT_MS raises the ceiling.`,
      };
    }
    return { ok: false, why: `the rewrite call failed after ${ms} ms: ${e instanceof Error ? e.message : String(e)}` };
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

/**
 *  The client defensively extracts the first message of an OpenAI
 *  chat-completions reply. A remote service supplies the body, and an unexpected
 *  payload shape must fail the rewrite while preserving the message.
 */
function firstChoice(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  return typeof content === "string" ? content : undefined;
}

/**
 *  The code defensively extracts the first text part of a `generateContent` reply.
 */
function firstText(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const parts = (candidates[0] as { content?: { parts?: unknown } }).content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const t = (parts[0] as { text?: unknown }).text;
  return typeof t === "string" ? t : undefined;
}

/**
 *  Certain words change the strength of a claim. A rewrite may not introduce such
 *  a word in either direction if the original text never used it.
 *
 *  A live measurement recorded the worst case in the set: an author described
 *  their exposure, and the rewrite published a guarantee, "the diff check PREVENTS
 *  the rewriter from silently replacing measured numbers". The reverse outcome is
 *  the failure the instruction already names, where a fact is softened into an
 *  impression. Both outcomes represent the same defect, because the author sets
 *  the strength of a claim.
 */
const STRENGTH = /\b(prevents?|guarantees?|ensures?|eliminates?|always|never|cannot|impossible|entirely|fully|completely|may|might|appears?|seems?|likely|possibly|generally|typically|usually)\b/gi;

/**
 *  The rewrite case-folds introduced strength words and counts them by presence,
 *  so a word the author already used stays the author's.
 */
export function strengthDrift(original: string, rewritten: string): string[] {
  const had = new Set([...proseOf(original).matchAll(STRENGTH)].map((m) => m[0].toLowerCase()));
  const added = new Set<string>();
  for (const m of proseOf(rewritten).matchAll(STRENGTH)) {
    const w = m[0].toLowerCase();
    if (!had.has(w)) added.add(w);
  }
  return [...added];
}

/**
 *  Connectives express how two facts relate. A rewrite preserves the exact count
 *  of connectives present in the original text.
 *
 *  Rewrites must preserve causal and logical structure without severing linked
 *  clauses. The instruction stated this requirement, but no test measured it.
 *  Running the instruction file through the rewriter produced an opposing defect:
 *  the input "Do not compress. Clipped prose reads as an interrogation" returned
 *  as "We do not compress the text BECAUSE clipped prose reads like an
 *  interrogation", inventing a causal link across two adjacent statements.
 *
 *  Connectives are counted as a class. Two agents measured `which is why` ->
 *  `because` and `therefore` -> `because` across ten sentences on two hosts,
 *  swapping clauses while keeping the underlying logic intact. Exchanging one
 *  connective for another maintains the count and passes. Flattening a connective
 *  into `and` or a full stop lowers the count, and inventing a connective raises
 *  the count.
 */
const CONNECTIVES =
  /\b(because|so|since|therefore|thus|hence|if|unless|when|whenever|although|though|but|however|otherwise|which means|as a result|that is why|which is why|in order to)\b/gi;

/**
 *  The refusal states how many connectives each text carries and which
 *  connectives are present.
 */
export function connectivesIn(text: string): string[] {
  return [...proseOf(text).matchAll(CONNECTIVES)].map((m) => m[0].toLowerCase());
}

/**
 *  A rewrite must not invent connectives that state why.
 *
 *  Across 29 sends measured on two hosts, the connective guard fired four times,
 *  every time in the ADD direction, and it killed one send outright. Two of the four
 *  firings added `because`, which is a claim about why that the author did not
 *  make. The other two added `when` and `whenever`, which restate timing and invent
 *  nothing.
 *
 *  So the DROP check keeps the whole class, since losing any link flattens the
 *  logic, and the ADD check counts these only.
 */
const CAUSAL = /\b(because|so|since|therefore|thus|hence|which means|as a result|that is why|which is why)\b/gi;

export function causalIn(text: string): string[] {
  return [...proseOf(text).matchAll(CAUSAL)].map((m) => m[0].toLowerCase());
}

/**
 *  The send operation defines what to post and what description accompanies it.
 *
 *  The system drops any rewrite that breaks a language rule. The sender's own
 *  words already passed, and posting prose that the repository rejects because a
 *  model wrote it would make the rules mean nothing.
 */
/**
 *  The rewrite must preserve every element taken from the original document.
 *
 *  The text must keep all backticked spans, fenced blocks, numbers, @mentions,
 *  URLs, and file paths. A rewrite that omits any of these items changes the
 *  evidence, whatever happens to the prose.
 */
/**
 *  Only this file's own prompts use these phrases, so an answer carrying one is the
 *  model repeating its instructions into the message. The validator matches
 *  lower-case phrases against a lower-cased answer.
 */
/**
 *  The function returns the longest span of `prompt` that `answer` repeats, or ""
 *  when they share nothing that long.
 *
 *  The output must not quote its own instruction. An earlier phrase list caught
 *  retry complaints that used the exact words written in this file. The model then
 *  produced `The system rejected your previous attempt` and `Rewrite the message
 *  again without that`, neither of which appeared in the list. A wording guard
 *  requires the exact wording, and a paraphrase has its own phrasing. Comparing
 *  against the prompt catches any span the model copies out of it, whatever the
 *  phrasing around it.
 *
 *  The caller excludes the draft, because a rewrite shares long spans with the
 *  author's words on purpose.
 */
export function quotedSpan(answer: string, prompt: string, span = 40): string {
  const a = answer.toLowerCase().replace(/\s+/g, " ");
  const p = prompt.toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i + span <= p.length; i += 1) {
    const piece = p.slice(i, i + span);
    if (a.includes(piece)) return piece;
  }
  return "";
}

/**
 *  A failed rewrite produces a refusal that contains the model's output so the
 *  author can see what happened before writing the text again.
 */
function refusal(what: string, attempt: string): { refuse: string; why: string; attempt: string; retry: string } {
  return {
    refuse:
      `message send REFUSED: ${what}, so neither version goes out.\n` +
      `What the rewriter produced:\n${attempt}\n` +
      `Rewrite your message and send again.`,
    // The same two facts serve a reader that does not send. The ledger requires the
    // guard's name, and `scramble rewrite` requires the model's answer without any
    // sentence about sending, since it never sends. Both come from here, so the
    // refusal a person reads and the row a counter reads cannot disagree.
    why: what,
    attempt,
    // WHAT TO TELL THE MODEL ON A SECOND ATTEMPT. Every guard here fires on an action
    // the model took, so the model can fix it. Two agents intentionally wrote prose
    // that avoided a banned form, the rewriter restored that form, and the send
    // failed because both versions were refused.
    retry: `Your previous attempt was rejected: ${what}. Rewrite again without that.`,
  };
}

export function factsIn(text: string): string[] {
  const out = new Set<string>();
  // An inline span designates an identifier, such as a timestamp, a flag, a
  // filename, or a command, and survives byte for byte.
  for (const m of text.matchAll(/`[^`\n]+`/g)) out.add(m[0]);
  // Fenced blocks are not exempt from prose editing. Any natural language text
  // must be rewritten when it appears inside a code block. Sentences were placed
  // inside fences because the rewriter edits prose and leaves fenced blocks alone.
  //
  // Block text is no longer required verbatim, while every measurement inside it
  // remains required: every number, id, mention, url, and path inside it must come
  // back. A rewrite may turn the sentences inside a fence into better sentences,
  // and it may not change a figure.
  for (const m of text.matchAll(/```[\s\S]*?```/g)) for (const a of atomsIn(m[0])) out.add(a);
  for (const a of atomsIn(proseOf(text))) out.add(a);
  out.delete("");
  return [...out];
}

/**
 *  Numbers, mentions, URLs, and paths measure values in a text. A rewrite that
 *  loses one of these values changes the evidence.
 */
function atomsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b\d[\d.,:_-]*\b/g)) out.push(m[0]);
  for (const m of text.matchAll(/@[A-Za-z0-9._-]+/g)) out.push(m[0]);
  for (const m of text.matchAll(/https?:\/\/\S+/g)) out.push(m[0]);
  for (const m of text.matchAll(/(?:^|\s)(\/[A-Za-z0-9._\/-]{3,})/g)) out.push(m[1] ?? "");
  return out;
}

/**
 *  An `@name` mention in prose notifies the recipient.
 *
 *  A mention inside a backtick span notifies nobody, and Slack records the message
 *  with an empty `mentions` list. During a live measurement, the rewriter moved an
 *  `@name` into a code span, and the addressee never received word of the message.
 *  The whole-text check misses this error, since the characters remain present.
 *
 *  Keeping mentions working is the point of the message, so the system checks prose
 *  on both sides.
 */
/**
 *  Extract every Slack timestamp cited in a draft, remove duplicates, and preserve
 *  the order in which they appear.
 *
 *  An agent uses a citation to point another agent to evidence. Read the entire
 *  draft, including fenced blocks, because an evidence table is where a timestamp
 *  most often sits, and a mistyped digit there sends the reader to nothing.
 */
export function citedTimestamps(text: string): string[] {
  return [...new Set([...text.matchAll(/\b\d{10}\.\d{6}\b/g)].map((m) => m[0]))];
}

export function mentionsIn(text: string): string[] {
  // Trailing punctuation belongs to the sentence. A Slack handle may contain a dot,
  // so the match includes trailing dots, which meant `@name.` at the end of a
  // sentence read as a different person from `@name`. The added-mention guard
  // therefore classified it as a new mention and blocked two sends by the agent
  // writing them.
  return [
    ...new Set(
      [...proseOf(text).matchAll(/@[A-Za-z0-9._-]+/g)].map((m) => m[0].replace(/[.,:;!?]+$/, "")).filter((m) => m !== "@"),
    ),
  ];
}

/**
 *  The fraction measures how much of the original prose survived. An outside
 *  reader treats disappearing whole sentences as dropped conclusions.
 */
export function proseRatio(original: string, rewritten: string): number {
  const words = (t: string): number => proseOf(t).split(/\s+/).filter((w) => w !== "").length;
  const before = words(original);
  return before === 0 ? 1 : words(rewritten) / before;
}

/**
 *  A rewrite may drop a share of the original prose before it is refused.
 */
export const MIN_PROSE_RATIO = 0.6;

/**
 *  A send operation processes rewrites using `send` and `refuse`. The `send`
 *  field carries the text to post, and `refuse` carries the reason the send stops.
 *
 *  The system no longer sends the original message when the rewrite feature is on.
 *  Falling back to the author's words on a failed rewrite published exactly the
 *  prose the rewrite exists to replace. A rewrite that cannot be used stops the send
 *  and states what happened, and the author writes it again, which is what the
 *  language rules already require.
 *
 *  With no key configured, the rewriter is off and the system never consults this
 *  process.
 */
export type RewriteChoice =
  | { send: string; note: string }
  | { refuse: string; why: string; attempt?: string; retry?: string };

/**
 *  Every fenced block in a text, fence lines included.
 *
 *  A document's blocks contain its commands and its output. Message guards never
 *  inspected these blocks. A stub answer that dropped an entire `bash` block passed
 *  every check, because the block held no id, no mention, and no connective. In a
 *  message a lost block is a lost line, while in a document it is the part the
 *  reader runs.
 */
export function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (current === undefined) {
        current = [line];
      } else {
        current.push(line);
        out.push(current.join("\n"));
        current = undefined;
      }
      continue;
    }
    if (current !== undefined) current.push(line);
  }
  // The rewrite still carries content from an unclosed fence.
  if (current !== undefined) out.push(current.join("\n"));
  return out;
}

/**
 *  A rewrite preserves the subject of a section based on the share of original
 *  content words that survive.
 *
 *  When measured on a real pair, the rewritten opening of OPERATING.md keeps every
 *  noun the original names and reads as a different sentence. A replacement that
 *  shares nothing scores 0. The floor sits at half, which leaves room for a heavy
 *  rewording and refuses a substitution.
 */
export const DOCUMENT_SUBJECT_FLOOR = 0.5;

/**
 *  A run of consecutive comment lines in a source file tracks where the block
 *  starts, how the comments are marked, and the prose inside it.
 *
 *  A rewrite modifies the prose a person reads, and the surrounding code returns
 *  byte for byte, so a run records its own indentation and marker and the caller
 *  rebuilds the lines from those. The system leaves a trailing comment after code
 *  on the same line alone, since rewriting it would reflow a line carrying code.
 */
export interface CommentRun {
  start: number;
  end: number;
  indent: string;
  kind: "slash" | "star" | "hash";
  prose: string;
}

export function commentRuns(text: string, style: "slash" | "hash" = "slash"): CommentRun[] {
  const lines = text.split("\n");
  const runs: CommentRun[] = [];
  let i = 0;
  const lineMarker = style === "hash" ? /^(\s*)#\s?(.*)$/ : /^(\s*)\/\/\s?(.*)$/;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = lineMarker.exec(line);
    if (m !== null) {
      const indent = m[1]!;
      const body: string[] = [m[2]!];
      let j = i + 1;
      while (j < lines.length) {
        const next = lineMarker.exec(lines[j]!);
        if (next === null || next[1] !== indent) break;
        body.push(next[2]!);
        j += 1;
      }
      runs.push({ start: i, end: j - 1, indent, kind: style === "hash" ? "hash" : "slash", prose: body.join("\n").trim() });
      i = j;
      continue;
    }
    const open = style === "slash" ? /^(\s*)\/\*+\s?(.*)$/.exec(line) : null;
    if (open !== null) {
      const indent = open[1]!;
      const body: string[] = [open[2]!.replace(/\*+\/\s*$/, "")];
      let j = i;
      if (!/\*+\/\s*$/.test(line)) {
        j = i + 1;
        while (j < lines.length) {
          const l = lines[j]!;
          const closed = /\*+\/\s*$/.test(l);
          body.push(l.replace(/^\s*\*+\s?/, "").replace(/\*+\/\s*$/, ""));
          if (closed) break;
          j += 1;
        }
      }
      runs.push({ start: i, end: Math.min(j, lines.length - 1), indent, kind: "star", prose: body.join("\n").trim() });
      i = Math.min(j, lines.length - 1) + 1;
      continue;
    }
    i += 1;
  }
  return runs.filter((r) => r.prose !== "");
}

/**
 *  The process rebuilds a comment run's lines from rewritten prose, wrapped to
 *  `width` columns including the marker and the indentation.
 */
export function renderComment(run: CommentRun, prose: string, width = 88): string[] {
  const opener = run.kind === "hash" ? "# " : run.kind === "slash" ? "// " : " *  ";
  const prefix = `${run.indent}${opener}`;
  const out: string[] = [];
  for (const para of prose.split("\n")) {
    if (para.trim() === "") {
      out.push(`${run.indent}${run.kind === "star" ? " *" : run.kind === "hash" ? "#" : "//"}`);
      continue;
    }
    let line = "";
    for (const word of para.trim().split(/\s+/)) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (`${prefix}${candidate}`.length > width && line !== "") {
        out.push(`${prefix}${line}`);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line !== "") out.push(`${prefix}${line}`);
  }
  if (run.kind === "star") {
    out.unshift(`${run.indent}/**`);
    out.push(`${run.indent} */`);
  }
  return out;
}

export function chooseText(
  original: string,
  rewritten: { ok: true; text: string } | { ok: false; why: string },
  /**
   *  The prompt provides the instruction given to the model and omits the author's
   *  draft. An answer that repeats a span of the instruction quotes its own orders.
   */
  instruction?: string,
  /**
   *  A repository document is evaluated against all of these guards except two.
   *
   *  The 300-word cap applies to a Slack message, and a design document carries 4000
   *  words by design. The first-person guard rejects a rewrite that omits the
   *  author's "I". That rule serves a message written by one agent, but conflicts
   *  with a document because the document instruction directs the model to remove the
   *  editor from the text. Every other guard applies unchanged, so a document cannot
   *  lose a fact, a link between two facts, or a claim's strength.
   */
  opts?: { document?: boolean },
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
  // The instruction remains distinct from the message text. On a second attempt the
  // model receives the guard's complaint appended to the instruction, and one
  // answer came back carrying that complaint as a closing paragraph addressed to
  // the author: the reviewer rejected the previous attempt, so rewrite the message
  // without the added cause. Sending that reply would have posted the guard's own
  // words to the channel as though a person had written them to a peer.
  //
  // This file defines the retry sentence as fixed text, so the detector is exact.
  if (instruction !== undefined && instruction !== "") {
    const echoed = quotedSpan(rewritten.text, instruction);
    if (echoed !== "") {
      return refusal(`the rewrite copied its own instruction into the message ("${echoed.trim()}")`, rewritten.text);
    }
  }
  // A section preserves its subject. A stub response of unrelated prose passed
  // every guard on a section containing no identifier, mention, or connective,
  // because no check compared the topic of the response to the topic of the input.
  // The duplicate guard already measures that topic overlap, so the system runs the
  // same containment check here, and the floor is low enough that a heavy rewording
  // passes.
  if (opts?.document === true) {
    const mineWords = contentOf(allWords(proseOf(original)));
    if (mineWords.length >= 8) {
      const kept = wordOverlap(mineWords, contentOf(allWords(proseOf(rewritten.text))));
      if (kept < DOCUMENT_SUBJECT_FLOOR) {
        return {
          refuse:
            `document REFUSED: the rewrite kept ${(kept * 100).toFixed(0)}% of what the section was about, ` +
            `and the floor is ${(DOCUMENT_SUBJECT_FLOOR * 100).toFixed(0)}%.`,
          why: `the rewrite kept ${(kept * 100).toFixed(0)}% of the section's subject`,
          retry: `Your previous attempt replaced the section instead of rewriting it. Carry every fact from the input across.`,
        };
      }
    }
  }
  // A document preserves every fenced block in full.
  if (opts?.document === true) {
    const lostBlocks = fencedBlocks(original).filter((b) => !rewritten.text.includes(b.trim()));
    if (lostBlocks.length > 0) {
      const first = (lostBlocks[0] ?? "").split("\n").slice(0, 3).join(" / ");
      return {
        refuse: `document REFUSED: the rewrite dropped or altered ${lostBlocks.length} fenced block(s), starting with: ${first}`,
        why: `the rewrite dropped ${lostBlocks.length} fenced block(s)`,
        retry: `Your previous attempt lost a fenced block. Return every fenced block byte for byte, fences included.`,
      };
    }
  }
  const over = opts?.document === true ? "" : lengthRefusal(rewritten.text);
  if (over !== "") {
    return refusal("the rewrite ran over the word limit", rewritten.text);
  }
  // The rewrite must preserve everything present in the original document. During a
  // measurement in a live channel, the rewriter dropped a closing causal sentence
  // and replaced a statement of fact with a different one, and the receiving agent
  // then inferred the missing conclusion from the numbers. The instruction already
  // demands both requirements, and the system refuses the rewrite when the demand
  // goes unmet.
  const lost = factsIn(original).filter((f) => !rewritten.text.includes(f));
  if (lost.length > 0) {
    return refusal(
        `the rewrite dropped ${lost.length} thing(s) yours carried: ${lost.slice(0, 5).join(", ")}`,
        rewritten.text,
    );
  }
  // A mention that stops generating notifications is lost, even when its characters
  // remain on the line.
  const keptMentions = mentionsIn(rewritten.text);
  const mine = mentionsIn(original);
  // A mention that the author did not write notifies someone the author did not
  // address, and it can invent attribution. In two measurements, a rewrite turned
  // "re-ran the same five sentences" into "after @scramble_dev re-ran the same five
  // sentences", which credited the run to a different agent and pinged them for it.
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
  // The actor remains the actor. Two agents measured the same shift. The statement
  // "I stopped restarting on every bump" became "The process waited for the
  // installed commit to hold steady", which turned a first-person report into a
  // description with nobody in it. The identity of the actor that performed an
  // action is part of the claim.
  const firstPerson = /\b(I|I'm|I've|my|me|we|we're|we've|our)\b/i;
  if (opts?.document !== true && firstPerson.test(proseOf(original)) && !firstPerson.test(proseOf(rewritten.text))) {
    return refusal(
      `the rewrite removed the first person from a message that had it, so who did the thing is gone`,
      rewritten.text,
    );
  }
  // Please provide the section you would like rewritten.
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

