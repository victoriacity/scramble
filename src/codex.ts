// src/codex.ts — the codex driver (driver-attach).
// Drives an existing headless codex session: subscribe to the participant's
// agent-scoped stream, deliver every message as an injected turn via
// `codex exec` (concerned serialized per session), harvest the last assistant
// reply from the JSON stdout, and post it back to the room as that participant.
// The spawn seam is injected so tests never touch a real `codex` binary.
import type { Delivery, PostResult } from "./types";

/** What the spawned codex process produced. */
export interface SpawnResult {
  stdout: string;
  exitCode: number;
}

/** The injected process seam that runs one `codex exec` invocation. */
export interface Spawn {
  (argv: string[], prompt: string): SpawnResult | Promise<SpawnResult>;
}

/** Seams a driver needs, all injectable so the driver is pure orchestration. */
export interface CodexConfig {
  /** The room participant this driver answers as (used for nothing but clarity). */
  name: string;
  /** Adopt an existing thread; when unset, the first turn bootstraps one. */
  resumeId?: string;
  /** The agent-scoped subscription feeding deliveries to answer. */
  stream: () => AsyncIterable<Delivery>;
  /** Post a reply into the given room as this participant. */
  post: (room: string, text: string) => Promise<PostResult>;
}

/** A completed driver run: resolves once the stream ends and the queue drains. */
export interface CodexDriver {
  done: Promise<void>;
}

/** Pull an assistant message block out of one codex JSON event.
 *  Returns null for anything that is not an assistant message event. */
function assistantEvent(ev: Record<string, unknown>): { sessionId?: string; text: string } | null {
  const payload = ev.payload as Record<string, unknown> | undefined;
  const message = payload?.message as Record<string, unknown> | undefined;
  if (message?.role !== "assistant") return null;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((c) => (c as Record<string, unknown>)?.type === "output_text")
    .map((c) => (c as { text?: string }).text ?? "")
    .join("\n");
  const sessionId = typeof message.session === "string" ? message.session : undefined;
  return { sessionId, text };
}

/** Parse `codex exec`'s newline-delimited JSON stdout. Non-JSON lines and
 *  non-assistant events are skipped; across multiple assistant events the
 *  LAST assistant text wins (it is the reply to post) while the first
 *  session id sighted is remembered for resume. */
export function parseCodex(stdout: string): { sessionId?: string; text: string } {
  let sessionId: string | undefined;
  let text = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const asst = assistantEvent(ev);
    if (!asst) continue;
    if (asst.sessionId) sessionId = asst.sessionId;
    if (asst.text) text = asst.text;
  }
  return { sessionId, text };
}

/** Build the codex driver. A codex failure (non-zero exit or an output with no
 *  assistant message) is POSTED to the room as an error line — never swallowed
 *  and never retried silently. Turns are serialized per session: the stream's
 *  messages are processed one at a time in arrival order, so a session never
 *  has two turns in flight. */
export function createDriver(cfg: CodexConfig, spawn: Spawn): CodexDriver {
  let sessionId: string | undefined = cfg.resumeId;
  const queue: Delivery[] = [];

  async function drain(): Promise<void> {
    while (queue.length) {
      const d = queue.shift()!;
      const turn = sessionId
        ? ["exec", "resume", sessionId, "--json"]
        : ["exec", "--json"];
      const r = await spawn(turn, d.text);
      if (r.exitCode !== 0) {
        await cfg.post(d.room, `error: codex exec failed (exit ${r.exitCode})`);
        continue;
      }
      const parsed = parseCodex(r.stdout);
      if (parsed.sessionId) sessionId = parsed.sessionId;
      if (!parsed.text) {
        await cfg.post(d.room, "error: codex exec returned no assistant message");
        continue;
      }
      await cfg.post(d.room, parsed.text);
    }
  }

  async function run(): Promise<void> {
    for await (const d of cfg.stream()) {
      queue.push(d);
      await drain();
    }
    await drain();
  }

  return { done: run() };
}