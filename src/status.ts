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

const POST_URL = "https://slack.com/api/chat.postMessage";
const UPDATE_URL = "https://slack.com/api/chat.update";
const DELETE_URL = "https://slack.com/api/chat.delete";
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
  /** Slack ts of the living message that backs the status, when one exists. */
  ts?: string;
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

  private channelId(channel: string): string | undefined {
    return this.cfg.channels?.[channel];
  }

  private report(error: string): void {
    this.cfg.writeErr(`status: ${error}`);
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
  private async postLiving(channelId: string): Promise<string | undefined> {
    const r = await this.call(POST_URL, {
      channel: channelId,
      text: STATUS_TEXT,
      metadata: { event_type: STATUS_METADATA_TYPE, event_payload: {} },
    });
    if (!r.ok) {
      this.report(r.error ?? "post failed");
      return undefined;
    }
    return r.ts;
  }

  /** Update the remembered living message. A failure is reported only. */
  private async updateLiving(channelId: string, ts: string): Promise<void> {
    const r = await this.call(UPDATE_URL, {
      channel: channelId,
      ts,
      text: STATUS_TEXT,
      metadata: { event_type: STATUS_METADATA_TYPE, event_payload: {} },
    });
    if (!r.ok) this.report(r.error ?? "update failed");
  }

  /** Clear a living message: chat.delete it, and when delete is refused, replace
   *  its text content instead so the cleared status still lands. Neither a
   *  refusal nor a failure escalates. */
  private async clearLiving(channelId: string, ts: string): Promise<void> {
    const d = await this.call(DELETE_URL, { channel: channelId, ts });
    if (d.ok) return;
    this.report(`delete refused: ${d.error ?? "unknown"}`);
    const u = await this.call(UPDATE_URL, { channel: channelId, ts, text: "" });
    if (!u.ok) this.report(u.error ?? "replace failed");
  }

  /** Prefer an assistant-thread status when one is known. A failure is reported
   *  and the living message still carries the weight, so the work stays live. */
  private async setThreadStatus(channelId: string, threadTs: string): Promise<void> {
    const r = await this.call(THREAD_STATUS_URL, { channel_id: channelId, thread_ts: threadTs });
    if (!r.ok) this.report(r.error ?? "thread status failed");
  }

  /** Set the status ON for a channel: a fresh status posts one living message
   *  (and prefers an assistant-thread status when a thread is named); an active
   *  status is updated in place, never re-posted. */
  async setOn(channel: string, agent: string, threadTs?: string): Promise<void> {
    const records = this.load();
    const idx = records.findIndex((r) => r.channel === channel);
    if (idx >= 0) {
      const rec = records[idx]!;
      rec.agent = agent;
      rec.expiresAt = this.cfg.now() + this.cfg.ttlMs;
      if (this.cfg.backend === "slack" && rec.ts !== undefined) {
        const cid = this.channelId(channel);
        if (cid !== undefined && rec.ts !== undefined) await this.updateLiving(cid, rec.ts);
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
      const cid = this.channelId(channel);
      if (cid !== undefined) {
        if (threadTs !== undefined) await this.setThreadStatus(cid, threadTs);
        const ts = await this.postLiving(cid);
        if (ts !== undefined) rec.ts = ts;
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
    if (this.cfg.backend === "slack" && rec.ts !== undefined) {
      const cid = this.channelId(channel);
      if (cid !== undefined) await this.clearLiving(cid, rec.ts);
    }
    records.splice(idx, 1);
    this.save(records);
  }

  /** The last message-ts held for a channel (a source of truth for the living
   *  message). */
  livingTs(channel: string): string | undefined {
    return this.load().find((r) => r.channel === channel)?.ts;
  }

  /** Every living-message ts the ledger currently records — the authority the
   *  caller hands a read or a delivery so a status line is left out of history
   *  and never delivered. The authority is the LEDGER (channel + agent + living
   *  ts), never the "working" text, so a human saying the word is not hidden.
   *  A cleared or expired status is already GONE from the ledger (clearOn /
   *  clearExpired splice it out), so its old ts stops being hidden and a message
   *  that outlives its record becomes visible again. That is the safe direction:
   *  an undeletable status left in the channel MUST stay visible so somebody
   *  removes it, while a hidden one would be a line nobody can account for. */
  livingTts(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const r of this.load()) if (r.ts !== undefined) out.add(r.ts);
    return out;
  }

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
      if (this.cfg.backend === "slack" && rec.ts !== undefined) {
        const cid = this.channelId(rec.channel);
        if (cid !== undefined) await this.clearLiving(cid, rec.ts);
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