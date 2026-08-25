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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lengthRefusal, lintLanguage } from "./language";

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
