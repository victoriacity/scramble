// src/status.ts — scramble's AUTOMATIC working-status surface.
//
// Status is NOT an agent-invoked verb. It is set and cleared by scramble from
// events scramble already sees:
//
//   delivery of a message addressed to this agent ->  status ON for that channel
//   a post by this agent to that channel          ->  status OFF
//   no post within the TTL                        ->  status OFF
//
// An agent that has to remember to set a status would forget; the lifecycle is
// bracketed by the delivery verbs (next / listen / message check) on one side
// and the post verbs (post / message send) on the other. `SCRAMBLE_STATUS=off`
// is the one switch for an operator who wants silence.
//
// Status is never a message: it has no seq, it is absent from history, and it
// is never delivered to a listener. A status line waking a peer agent would
// turn progress into traffic. A failed status call NEVER fails the work it
// brackets: it is reported on stderr and the underlying verb carries on.
//
// The active statuses are recorded in `.scramble/status.json` as channel,
// agent, the Slack ts of a living message that backs the status, and an expiry.
// A second status set on one channel updates the living message instead of
// posting again: one living message per channel, never a second. Slack calls go
// through an injected `fetch` seam so tests need no token and no network.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** The fixed, short text a status carries. Agent-authored progress prose is a
 *  message pretending to be a status, so the text is scramble's, not the
 *  agent's. */
export const STATUS_TEXT = "working";

/** Slack message metadata marking a line as a scramble status. It rides on the
 *  message itself, so ANY agent can recognise ANY agent's status: the ts ledger
 *  only ever knew about its own, which let a peer's `working` line arrive in
 *  this agent's transcript as if someone had said it. Metadata rather than the
 *  text, because a human, or an agent, is allowed to say "working". */
export const STATUS_METADATA_TYPE = "scramble_status";

const THREAD_STATUS_URL = "https://slack.com/api/assistant.threads.setStatus";

/** Backend-selection answers the CLI already knows: the local daemon records
 *  the status so a test (or a reader) can see it; the slack backend talks to
 *  Slack through the injected fetch seam. */
export type StatusBackend = "local" | "slack";

/** One active status: channel + agent + the living-message ts (when one backs
 *  it) + the moment the status expires and is cleared. */
export interface StatusRecord {
  channel: string;
  agent: string;
  /** The thread whose Slack status this agent set, cleared by setting it back
   *  to empty. */
  thread?: string;
  /** epoch ms after which the status is stale and must be cleared. */
  expiresAt: number;
}

/** Mounted seams for the status manager. `fetch` is injected so a test needs no
 *  token and no network; `now` and `ttlMs` drive the expiry clock. */
export interface StatusConfig {
  /** path of the `.scramble/status.json` ledger. */
  file: string;
  /** which backend the status rides on. */
  backend: StatusBackend;
  /** injected clock. */
  now: () => number;
  /** how long an unbracketed status lives, in ms. */
  ttlMs: number;
  /** injected network seam (Slack backend only). */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** diagnostics channel: a failed status is REPORTED here, never escalated. */
  writeErr(line: string): void;
  /** Slack channel name -> Slack channel id. */
  channels?: Record<string, string>;
  /** LIVE resolution for a channel the map does not hold, which is every channel
   *  an agent was invited into without a config edit. The map stays as the fast
   *  path; this is what makes the answer true. */
  resolve?: (channel: string) => Promise<string | undefined>;
  /** the Slack bot token. */
  token?: string;
}

/** One Slack REST answer, morally the same triangle as the backend: `ok:true`
 *  carries the message ts when the call returned one; `ok:false` carries Slack
 *  error text. A transport failure is surfaced as `ok:false`, never read as
 *  work. */
interface SlackAnswer {
  ok: boolean;
  error?: string;
  ts?: string;
}

/** Read the ledger. A missing or unparseable ledger is a fresh (empty) one — a
 *  corrupt status file must not take an underlying verb down with it. */
export function readRecords(file: string): StatusRecord[] {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
    if (Array.isArray(j.entries)) return j.entries as StatusRecord[];
  } catch {
    /* absent or corrupt ledger: fresh */
  }
  return [];
}

/** Persist the ledger, creating `.scramble/` when needed. */
export function writeStatus(file: string, entries: StatusRecord[]): void {
  const dir = file.slice(0, file.lastIndexOf("/"));
  if (dir.length > 0) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ entries }));
}

/** The automatic working-status manager: records active statuses and drives the
 *  Slack backend. Every method reports Slack failures on `writeErr` and never
 *  throws, so a failed status can never fail the work it describes. */
export class StatusManager {
  private readonly cfg: StatusConfig;

  constructor(cfg: StatusConfig) {
    this.cfg = cfg;
  }

  private load(): StatusRecord[] {
    return readRecords(this.cfg.file);
  }

  private save(records: StatusRecord[]): void {
    writeStatus(this.cfg.file, records);
  }

  private async channelId(channel: string): Promise<string | undefined> {
    const mapped = this.cfg.channels?.[channel];
    if (mapped !== undefined) return mapped;
    if (this.cfg.resolve === undefined) return undefined;
    try {
      return await this.cfg.resolve(channel);
    } catch (e) {
      this.report(`resolving ${channel} failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  /** A status failure is REPORTED and never escalated, so the report is the only
   *  trace it leaves: it names the channel it was acting on. `channel_not_found`
   *  alone said which error Slack returned and nothing about what was asked. */
  private report(error: string, channel?: string): void {
    this.cfg.writeErr(channel === undefined ? `status: ${error}` : `status in ${channel}: ${error}`);
  }

  /** One Slack REST edit, normalized to the ok/error/ts triangle. */
  private async call(url: string, body: Record<string, unknown>): Promise<SlackAnswer> {
    if (this.cfg.token === undefined) return { ok: false, error: "status needs a Slack token" };
    let res: Response;
    try {
      res = await this.cfg.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.token}` },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, error: `slack status request failed: ${url}` };
    }
    let j: unknown;
    try {
      j = await res.json();
    } catch {
      return { ok: false, error: `slack status answered non-JSON: ${url}` };
    }
    if (typeof j !== "object" || j === null)
      return { ok: false, error: `slack status answered non-object: ${url}` };
    const o = j as Record<string, unknown>;
    if (o.ok !== true) return { ok: false, error: (o.error as string) ?? "slack status call failed" };
    return { ok: true, ts: typeof o.ts === "string" ? o.ts : undefined };
  }

  /** Post the living-message status into a channel. Captures the new ts so the
   *  update/delete/expire paths can address it. Returns the ts, or undefined on
   *  a failure (reported, never escalated). */
  // THERE IS NO LIVING MESSAGE. A status is Slack's own status on a thread and
  // nothing else: no post, no edit, no delete, and no `ts` on the record
  // (operator, 2026-08-21: "we don't need living messages, only assistant
  // status"). Nothing here writes a message into a channel.


  /** Set Slack's own status on a thread. Reports a failure and answers whether
   *  it took, so the caller records the thread only when Slack accepted it. */
  private async setThreadStatus(
    channelId: string,
    threadTs: string,
    status: string,
    channel?: string,
  ): Promise<boolean> {
    const r = await this.call(THREAD_STATUS_URL, { channel_id: channelId, thread_ts: threadTs, status });
    if (!r.ok) {
      this.report(`${r.error ?? "thread status failed"} (channel_id ${channelId}, thread ${threadTs})`, channel);
      return false;
    }
    return true;
  }

  /** Set the status ON: Slack's OWN status where Slack has one, and nothing at
   *  all where it does not.
   *
   *  `assistant.threads.setStatus` works on an ordinary channel thread, which I
   *  had assumed needed an assistant DM: probed on a real channel thread it
   *  answers ok:true. That is the whole reason the living message existed, and a
   *  status is not a message, so posting one into the channel was the wrong
   *  shape (operator, 2026-08-21: "why did you send a working text to the
   *  channel? this should be implemented in slack assistant status, not
   *  message").
   *
   *  With no thread there is no native status, and the answer there is silence
   *  rather than a message pretending to be one. */
  async setOn(channel: string, agent: string, threadTs?: string): Promise<void> {
    const records = this.load();
    const idx = records.findIndex((r) => r.channel === channel);
    if (idx >= 0) {
      const rec = records[idx]!;
      rec.agent = agent;
      rec.expiresAt = this.cfg.now() + this.cfg.ttlMs;
      // Re-assert Slack's own status rather than editing a message: setting it
      // again on the same thread is how it stays up while the agent works.
      if (this.cfg.backend === "slack" && rec.thread !== undefined) {
        const cid = await this.channelId(channel);
        if (cid !== undefined) await this.setThreadStatus(cid, rec.thread, STATUS_TEXT, channel);
      }
      this.save(records);
      return;
    }
    const rec: StatusRecord = {
      channel,
      agent,
      expiresAt: this.cfg.now() + this.cfg.ttlMs,
    };
    if (this.cfg.backend === "slack") {
      const cid = await this.channelId(channel);
      if (cid !== undefined && threadTs !== undefined) {
        rec.thread = (await this.setThreadStatus(cid, threadTs, STATUS_TEXT, channel)) ? threadTs : undefined;
      }
    }
    records.push(rec);
    this.save(records);
  }

  /** Clear the status OFF for a channel by deleting (or replacing the text of)
   *  the living message, then dropping the record. Nothing when no active
   *  status exists. */
  async clearOn(channel: string, _agent: string): Promise<void> {
    const records = this.load();
    const idx = records.findIndex((r) => r.channel === channel);
    if (idx < 0) return;
    const rec = records[idx]!;
    if (this.cfg.backend === "slack") {
      const cid = await this.channelId(channel);
      // An EMPTY status is how Slack is told the agent stopped working.
      if (cid !== undefined && rec.thread !== undefined) await this.setThreadStatus(cid, rec.thread, "", channel);
    }
    records.splice(idx, 1);
    this.save(records);
  }

  // livingTs and livingTts are GONE with the living message. They existed so a
  // read could hide a status LINE from history; a status is no longer a line, so
  // there is nothing to hide and no ts to hide it by. A peer's status from an
  // older build is recognised by its metadata marker instead (isStatusLine).

  /** True when a channel has an active, unexpired status. */
  isActive(channel: string): boolean {
    const now = this.cfg.now();
    return this.load().some((r) => r.channel === channel && r.expiresAt > now);
  }

  /** Every scramble invocation clears whatever has expired before its own work.
   *  An expired status's living message is deleted (or text-replaced) and the
   *  record is dropped. Returns the number of entries cleared so a listen loop
   *  can report on the sweep. */
  async clearExpired(): Promise<number> {
    const records = this.load();
    const now = this.cfg.now();
    const kept = records.filter((r) => r.expiresAt > now);
    if (kept.length === records.length) return 0;
    for (const rec of records) {
      if (rec.expiresAt > now) continue;
      if (this.cfg.backend === "slack") {
        const cid = await this.channelId(rec.channel);
        // Slack's own status is what an expiry takes down.
        if (cid !== undefined && rec.thread !== undefined) await this.setThreadStatus(cid, rec.thread, "", rec.channel);
        }
    }
    this.save(kept);
    return records.length - kept.length;
  }

  /** Long-lived listeners clear on expiry while they run: a ticker that calls
   *  clearExpired on an interval until the returned stop is called. `sleep` is
   *  injectable so a test drives it without a real delay. */
  startExpiryTicker(
    intervalMs: number,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ): () => void {
    let stopped = false;
    void (async () => {
      while (!stopped) {
        await sleep(intervalMs);
        if (stopped) break;
        void this.clearExpired();
      }
    })();
    return () => {
      stopped = true;
    };
  }
}