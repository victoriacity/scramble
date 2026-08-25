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
import { lengthRefusal, lintLanguage } from "./language";

/** Where the rewrite comes from, and how long it may take. */
export interface RewriteConfig {
  /** The API key. Absent means this whole feature is off. */
  key?: string;
  /** The model id, so a newer one needs no code change. */
  model: string;
  /** Milliseconds before the rewrite is abandoned and the original sent. */
  timeoutMs: number;
}

export const DEFAULT_MODEL = "gemini-flash-latest";
export const DEFAULT_TIMEOUT_MS = 5000;

/** Read the config off the environment. `SCRAMBLE_REWRITE_KEY` turns it on;
 *  `SCRAMBLE_REWRITE_MODEL` and `SCRAMBLE_REWRITE_TIMEOUT_MS` are for a newer
 *  model and a slower link. */
export function rewriteConfig(env: (name: string) => string | undefined): RewriteConfig {
  const raw = Number(env("SCRAMBLE_REWRITE_TIMEOUT_MS"));
  const key = env("SCRAMBLE_REWRITE_KEY") ?? env("GEMINI_API_KEY");
  return {
    ...(key === undefined || key === "" ? {} : { key }),
    model: env("SCRAMBLE_REWRITE_MODEL") ?? DEFAULT_MODEL,
    timeoutMs: Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS,
  };
}

/** The instruction the model gets. Kept here so it is reviewable as text.
 *
 *  It names what must NOT change, because that is the whole risk: a claim is
 *  evidence about what its author measured, and a softened verb makes it a
 *  different claim. */
export function rewritePrompt(text: string): string {
  return [
    "Rewrite the message below to professional product and technical communication standards.",
    "",
    "Keep every claim exactly as strong as it is. Do not soften, hedge, or qualify.",
    "Do not add words like may, might, appears, seems, or likely to a statement of fact.",
    "Keep every number, identifier, file path, command and quoted span byte for byte.",
    "Keep fenced code blocks and backtick spans unchanged.",
    "Keep the message in the language it is written in.",
    "Do not add a greeting, a sign-off, or a sentence about the message itself.",
    "Do not use an em dash or an en dash. Do not write 'not X but Y' or 'rather than'.",
    "Answer with the rewritten message and nothing else.",
    "",
    "---",
    text,
  ].join("\n");
}

/** The Gemini REST call, returning the rewritten text or a reason it is absent.
 *
 *  Every failure is a REASON, never a throw: the caller sends the original and
 *  says why the rewrite is missing. */
export async function rewriteWith(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  cfg: RewriteConfig,
  text: string,
): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  if (cfg.key === undefined) return { ok: false, why: "no rewrite key configured" };
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent` +
    `?key=${encodeURIComponent(cfg.key)}`;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: rewritePrompt(text) }] }] }),
      signal: control.signal,
    });
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
  const out = firstText(body);
  if (out === undefined || out.trim() === "") return { ok: false, why: "the rewrite answer carried no text" };
  return { ok: true, text: out.trim() };
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

/** What the send should post, and what it should say about it.
 *
 *  A rewrite that breaks a language rule is DROPPED: the sender's own words
 *  already passed, and posting prose the repo refuses because a model wrote it
 *  would make the rules mean nothing. */
export function chooseText(
  original: string,
  rewritten: { ok: true; text: string } | { ok: false; why: string },
): { text: string; note: string } {
  if (!rewritten.ok) return { text: original, note: `sent your own words: ${rewritten.why}` };
  if (rewritten.text.trim() === original.trim()) return { text: original, note: "" };
  const over = lengthRefusal(rewritten.text);
  if (over !== "") {
    return { text: original, note: `sent your own words: the rewrite ran over the word limit, and yours did not.` };
  }
  const hits = lintLanguage(rewritten.text);
  if (hits.length > 0) {
    return {
      text: original,
      note:
        `sent your own words: the rewrite broke ${hits.length} language rule(s) ` +
        `(${hits.map((h) => h.label).join(", ")}), and yours did not.`,
    };
  }
  return {
    text: rewritten.text,
    note: `sent a rewrite. Your words were:\n${original}`,
  };
}
