// src/raft.ts — the raft backend. scramble talks to the raft CLI by shelling
// out through an INJECTED `run(cmd, args, stdin)` seam, so tests pass a fake
// and need no raft binary, no network, and no credential. The real process
// spawn lives in src/bin.ts (which no test imports), keeping the coverage gate
// green. raft's wire shape is not in our contract, so a line that does not
// parse is REPORTED, never dropped.
import type { Delivery, Message } from "./types";
import { DM_PREFIX } from "./types";

/** What one shelled-out call produced. `exit` 0 means the raft command
 *  reported success; anything else is surfaced as a failure with what raft
 *  printed. */
export interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

/** The process seam. raft.ts never spawns a process — it only ever calls this.
 *  The real implementation (a Bun.spawn wrapper) lives in src/bin.ts so no test
 *  needs a raft binary, a network, or a credential. */
export type RunFn = (cmd: string, args: string[], stdin: string) => Promise<RunResult>;

/** Raft backend knobs. `intervalMs`, `now` and `sleep` are injectable so the
 *  next()/listen() poll loops run instantly under test; `maxPolls` bounds a
 *  listen loop so a test can let it finish. */
export interface RaftBackendOptions {
  run: RunFn;
  /** `raft --profile <slug>` / RAFT_PROFILE selects a saved credential. */
  profile?: string;
  /** Drain poll period in ms (default 100). */
  intervalMs?: number;
  /** Injectable clock for a next() deadline and a listen() horizon. */
  now?: () => number;
  /** Injectable wait for a poll loop (default a real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Bounds a listen loop; default Infinity (listen runs until interrupted). */
  maxPolls?: number;
}

/** Result of a non-blocking drain of the agent inbox. */
export interface DrainResult {
  deliveries: Delivery[];
  /** Lines raft produced that we could not turn into a Delivery, REPORTED. */
  problems: string[];
}

/** Prefix `raft --profile` before the verb when a profile is selected. */
function raftArgs(profile: string | undefined, rest: string[]): string[] {
  return profile ? ["--profile", profile, ...rest] : rest;
}

/** Map a scramble room name to the raft target it addresses: a group room maps
 *  to `#room`; a `dm/<a>/<b>` room maps to `dm:@peer`, the member that is not
 *  the acting `from`. */
export function toTarget(room: string, from: string): string {
  if (!room.startsWith(DM_PREFIX)) return `#${room}`;
  const segs = room.split("/");
  const a = segs[1] ?? "";
  const b = segs[2] ?? "";
  const peers = [a, b].filter((s) => s && s !== from);
  const peer = peers[0] !== undefined ? peers[0] : from;
  return `dm:@${peer}`;
}

/** Derive the scramble room the raft target refers to, for the subscribing
 *  agent: `#channel` -> `channel`; `dm:@peer` -> `dm/<agent>/<peer>`. */
export function roomFromTarget(target: string, agent: string): string {
  if (target.startsWith("dm:")) {
    const peer = target.slice(3).replace(/^@/, "");
    return `${DM_PREFIX}${agent}/${peer}`;
  }
  if (target.startsWith("#")) return target.slice(1);
  return target;
}

/** The members a message addresses. A dm/ room addresses its peers (everyone
 *  but the sender); a group room addresses the @-tokens in the text. */
function computeMentions(room: string, text: string, sender: string): string[] {
  const out = new Set<string>();
  if (room.startsWith(DM_PREFIX)) {
    for (const seg of room.split("/").slice(1)) {
      if (seg && seg !== sender) out.add(seg);
    }
  } else {
    for (const tok of text.split(/\s+/)) {
      if (!tok.startsWith("@")) continue;
      out.add(tok.slice(1).replace(/^\W+/, "").replace(/\W+$/, ""));
    }
  }
  return [...out];
}

/** Parse ONE line of raft output into the same Delivery shape the local backend
 *  emits. Returns the raw line (unparseable, to be REPORTED), or "" for blank. */
export function parseDelivery(line: string, agent: string, seq: number): Delivery | string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (typeof obj !== "object" || obj === null) return trimmed;
  const o = obj as Record<string, unknown>;
  const text =
    typeof o.text === "string" ? o.text : typeof o.content === "string" ? o.content : "";
  const target =
    typeof o.channel === "string" ? o.channel
    : typeof o.target === "string" ? o.target
    : typeof o.room === "string" ? o.room : "";
  if (text === "" || target === "") return trimmed;
  const from =
    typeof o.from === "string" ? o.from
    : typeof o.sender === "string" ? o.sender
    : typeof o.author === "string" ? o.author
    : typeof o.user === "string" ? o.user : "";
  const ts =
    typeof o.ts === "string" ? o.ts
    : typeof o.timestamp === "string" ? o.timestamp
    : typeof o.time === "string" ? o.time
    : new Date().toISOString();
  const id = typeof o.id === "string" ? o.id : typeof o.uuid === "string" ? o.uuid : `raft-${seq}`;
  const room = roomFromTarget(target, agent);
  const mentions = computeMentions(room, text, from);
  return { seq, ts, room, from, text, id, mentions, mentioned: mentions.includes(agent) };
}

/** True when a raft result is a failure we must surface: a non-zero exit, or a
 *  well-formed output that carries an `error` payload. */
function isErrorRun(res: RunResult): boolean {
  if (res.exit !== 0) return true;
  try {
    const j = JSON.parse(res.stdout) as { error?: unknown };
    if (j && typeof j === "object" && typeof j.error === "string") return true;
  } catch {
    /* non-JSON output on exit 0 is not an error by itself */
  }
  return false;
}

/** The raft backend: send / drain / next / history / listen over the seam. */
export class RaftBackend {
  private readonly run: RunFn;
  private readonly profile?: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxPolls: number;

  constructor(opts: RaftBackendOptions) {
    this.run = opts.run;
    this.profile = opts.profile;
    this.intervalMs = opts.intervalMs ?? 100;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.maxPolls = opts.maxPolls ?? Number.POSITIVE_INFINITY;
  }

  /** What raft printed on a failed run. | nothing matching a silent failure. */
  private errorText(res: RunResult): string {
    return res.stderr || res.stdout || "raft returned no output";
  }

  /** Send a post: maps the room to a raft target, pipes text on stdin. A
   *  non-zero exit or an error payload is surfaced, never swallowed. */
  async send(room: string, text: string, from: string): Promise<{ ok: boolean; code: 0 | 1; error?: string }> {
    const target = toTarget(room, from);
    const res = await this.run("raft", raftArgs(this.profile, ["message", "send", "--target", target]), text);
    if (isErrorRun(res)) return { ok: false, code: 1, error: this.errorText(res) };
    return { ok: true, code: 0 };
  }

  /** Non-blocking drain of the agent inbox (`raft message check`); each output
   *  line parsed into a Delivery; unparseable lines REPORTED, not dropped. */
  async drain(agent: string): Promise<DrainResult> {
    const res = await this.run("raft", raftArgs(this.profile, ["message", "check"]), "");
    const problems: string[] = [];
    const deliveries: Delivery[] = [];
    if (res.exit !== 0) {
      problems.push(`raft message check failed (exit ${res.exit}): ${this.errorText(res)}`);
      return { deliveries, problems };
    }
    let seq = 0;
    for (const line of res.stdout.split("\n")) {
      const parsed = parseDelivery(line, agent, ++seq);
      if (parsed === "") continue;
      if (typeof parsed === "string") problems.push(parsed);
      else deliveries.push(parsed);
    }
    return { deliveries, problems };
  }

  /** Blocking read built on the non-blocking drain: poll until a message
   *  arrives or the timeout expires (exit 64 semantics preserved). */
  async next(agent: string, timeoutSecs: number): Promise<{ code: 0 | 64; line?: Delivery; problems: string[] }> {
    const deadline = this.now() + timeoutSecs * 1000;
    const problems: string[] = [];
    while (this.now() < deadline) {
      const d = await this.drain(agent);
      problems.push(...d.problems);
      if (d.deliveries.length) return { code: 0, line: d.deliveries[0]!, problems };
      await this.sleep(this.intervalMs);
    }
    return { code: 64, problems };
  }

  /** The listen poll loop: emit every Delivery as it arrives until the loop is
   *  bounded (maxPolls, for tests). Problems are REPORTED via onProblem. */
  async listen(agent: string, onLine: (d: Delivery) => void, onProblem: (p: string) => void): Promise<void> {
    let polls = 0;
    while (polls < this.maxPolls) {
      polls++;
      const d = await this.drain(agent);
      for (const p of d.problems) onProblem(p);
      for (const m of d.deliveries) onLine(m);
      if (polls >= this.maxPolls) break;
      await this.sleep(this.intervalMs);
    }
  }

  /** Read room history from raft. Unparseable lines are REPORTED, not dropped. */
  async history(room: string, from: string): Promise<{ code: 0 | 1; error?: string; messages: Message[]; problems: string[] }> {
    const target = toTarget(room, from);
    const res = await this.run("raft", raftArgs(this.profile, ["message", "read", "--target", target]), "");
    if (isErrorRun(res)) return { code: 1, error: this.errorText(res), messages: [], problems: [] };
    const messages: Message[] = [];
    const problems: string[] = [];
    let seq = 0;
    for (const line of res.stdout.split("\n")) {
      const parsed = parseDelivery(line, from, ++seq);
      if (parsed === "") continue;
      if (typeof parsed === "string") {
        problems.push(parsed);
        continue;
      }
      messages.push({
        seq: parsed.seq,
        ts: parsed.ts,
        room: parsed.room,
        from: parsed.from,
        text: parsed.text,
        id: parsed.id,
        mentions: parsed.mentions,
      });
    }
    return { code: 0, messages, problems };
  }
}