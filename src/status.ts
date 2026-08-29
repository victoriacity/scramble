// src/status.ts: scramble's automatic working-status surface.
//
// Agents do not invoke status as a verb. Scramble sets and clears status
// from events it already sees:
//
// delivery of a message addressed to this agent -> status ON for that channel
// a post by this agent to that channel -> status OFF
// no post within the TTL -> status OFF
//
// An agent that has to remember to set a status would forget. The delivery
// verbs (next, listen, message check) open the lifecycle on one side, and the
// post verbs (post, message send) close it on the other. `SCRAMBLE_STATUS=off` is
// the single switch for an operator who wants silence.
//
// Status is never a message: it has no seq, it is absent from history, and
// scramble never delivers it to a listener. A status line waking a peer agent
// would turn progress into traffic. A failed status call never fails the work
// it brackets: scramble reports the error on stderr, and the underlying verb
// carries on.
//
// Scramble records active statuses in `.scramble/status.json` as the channel, the
// agent, the Slack ts of the living message backing the status, and an expiry.
// Setting a second status on a channel updates the living message it already
// has, maintaining one living message per channel. Slack calls pass through an
// injected `fetch` seam so tests need no token and no network.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { withFileLock } from "./filelock";

/**
 *  A status carries short, fixed text. Agent-authored progress prose acts as a
 *  message pretending to be a status, so scramble owns this text.
 */
export const STATUS_TEXT = "working";

/**
 *  Slack message metadata marks a line as a scramble status. The metadata travels
 *  on the message itself, so any agent can recognize any agent's status. The
 *  timestamp ledger only ever tracked its own messages, which let a peer's
 *  `working` line arrive in an agent's transcript as if someone had said it. The
 *  agent keys on the metadata, because a human, or an agent, is allowed to say
 *  "working".
 */
export const STATUS_METADATA_TYPE = "scramble_status";

const THREAD_STATUS_URL = "https://slack.com/api/assistant.threads.setStatus";
/**
 *  Slack's answers for a thread that no longer exists. A status record naming one
 *  of these can only fail again, so the record drops the reference.
 */
const GONE_THREAD_ERRORS = new Set(["invalid_thread_ts", "thread_not_found", "message_not_found"]);

/**
 *  The CLI already knows the backend-selection answers. The local daemon records
 *  the status so a test (or a reader) can see it, and the slack backend talks to
 *  Slack through the injected fetch seam.
 */
export type StatusBackend = "local" | "slack";

/**
 *  An active status records the channel, the agent, the timestamp of the living
 *  message when one backs it, and the moment the status expires and is cleared.
 */
export interface StatusRecord {
  channel: string;
  agent: string;
  /**
   *  The agent clears the Slack status it set on the thread by setting it back
   *  to empty.
   */
  thread?: string;
  /**
   *  The status is stale and must be cleared after this timestamp in epoch
   *  milliseconds.
   */
  expiresAt: number;
}

/**
 *  The status manager provides mounted seams. A caller injects `fetch` so a test
 *  needs no token and no network, while `now` and `ttlMs` drive the expiry clock.
 */
export interface StatusConfig {
  /**
   *  The ledger resides at the `.scramble/status.json` path.
   */
  file: string;
  /**
   *  The backend that carries the status.
   */
  backend: StatusBackend;
  /**
   *  A clock is injected.
   */
  now: () => number;
  /**
   *  An unbracketed status lives for this duration, in milliseconds.
   */
  ttlMs: number;
  /**
   *  The system provides an injected network seam for the Slack backend only.
   */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   *  The diagnostics channel reports a failed status.
   */
  writeErr(line: string): void;
  /**
   *  A Slack channel name maps to a Slack channel ID.
   */
  channels?: Record<string, string>;
  /**
   *  The system performs live resolution for any channel the map does not hold,
   *  which is every channel an agent was invited into without a configuration edit.
   *  The map stays as the direct path, and live resolution makes the answer true.
   */
  resolve?: (channel: string) => Promise<string | undefined>;
  /**
   *  The token for the Slack bot.
   */
  token?: string;
  /**
   *  This field identifies which agent is acting. An expiry sweep can only take down
   *  a status through the credential that set it, and this manager holds one token,
   *  so it sweeps its own rows and leaves other agents' rows to the processes that
   *  own them. An absent value means the manager sweeps everything, which is right
   *  for the local backend and for a workspace with one agent.
   */
  agent?: string;
}

/**
 *  A Slack REST response follows the same structure as the backend. An `ok:true`
 *  response carries the message timestamp when the call returned one, and an
 *  `ok:false` response carries Slack error text. A transport failure surfaces as
 *  `ok:false` and is never read as work.
 */
interface SlackAnswer {
  ok: boolean;
  error?: string;
  ts?: string;
}

/**
 *  The command reads the ledger. If the ledger is missing or unparseable, the
 *  command reads it as a fresh empty ledger, because a corrupt status file must
 *  not take down an underlying command.
 */
export function readRecords(file: string): StatusRecord[] {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
    if (Array.isArray(j.entries)) return j.entries as StatusRecord[];
  } catch {
    /**
     *  The system creates a fresh ledger if the ledger is absent or corrupt.
     */
  }
  return [];
}

/**
 *  The system persists the ledger and creates `.scramble/` when needed.
 */
export function writeStatus(file: string, entries: StatusRecord[]): void {
  const dir = file.slice(0, file.lastIndexOf("/"));
  if (dir.length > 0) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ entries }));
}

/**
 *  The automatic working-status manager records active statuses and drives the
 *  Slack backend. Each method reports Slack failures on `writeErr` and never
 *  throws an exception, so a failed status can never fail the work it describes.
 */
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

  /**
   *  The process reads, changes, and writes the ledger as one step across processes
   *  through the shared file lock. The Slack call remains outside the lock, because
   *  holding a lock across a network request would stall every other process for as
   *  long as Slack takes.
   */
  private locked<T>(change: (records: StatusRecord[]) => T, onFailure: T): T {
    // The system reports a ledger write that fails, and the failure never reaches the
    // caller. The class above promises this behavior, but the implementation failed
    // to maintain it. In that version, `save` calls `mkdirSync` and `writeFileSync`
    // without handling errors, and `withFileLock` calls `mkdirSync` before either
    // function. On a host whose writes returned `EIO`, that thrown error left
    // `startExpiryTicker` holding a rejected promise that nobody awaits, which takes
    // the listener down. An agent read the source and reported it against the
    // comment.
    //
    // The change is lost when the write fails, which is right for accounting: a
    // status is a courtesy to the room, and the work it describes carries on.
    try {
      return withFileLock(
        this.cfg.file,
        () => {
          const records = this.load();
          const out = change(records);
          this.save(records);
          return out;
        },
        (note) => this.report(note),
      );
    } catch (e) {
      this.report(`the status ledger could not be written: ${e instanceof Error ? e.message : String(e)}`);
      return onFailure;
    }
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

  /**
   *  The system reports a status failure and never escalates it, so the report is the
   *  only trace it leaves. The report names the channel that the operation acted on.
   *  The `channel_not_found` code alone indicated which error Slack returned, omitting
   *  the details of what was requested.
   */
  private report(error: string, channel?: string): void {
    this.cfg.writeErr(channel === undefined ? `status: ${error}` : `status in ${channel}: ${error}`);
  }

  /**
   *  One Slack REST edit is normalized to the `ok`, `error`, and `ts` fields.
   */
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

  /**
   *  This function posts the living-message status into a channel and captures the
   *  new `ts` so the update, delete, and expire paths can address it. It returns the
   *  `ts`, or `undefined` on a failure, which is reported here.
   */
  // Living messages do not exist in this system. A status is Slack's own status on a
  // thread, with no post, no edit, and no delete, and the record contains no `ts`.
  // The system needs only assistant status. Nothing here writes a message into a
  // channel.


  /**
   *  This call sets Slack's status on a thread. The call reports a failure and
   *  returns whether the update succeeded, so the caller records the thread only
   *  when Slack accepted it.
   */
  private async setThreadStatus(
    channelId: string,
    threadTs: string,
    status: string,
    channel?: string,
  ): Promise<{ ok: boolean; gone: boolean }> {
    const r = await this.call(THREAD_STATUS_URL, { channel_id: channelId, thread_ts: threadTs, status });
    if (!r.ok) {
      this.report(`${r.error ?? "thread status failed"} (channel_id ${channelId}, thread ${threadTs})`, channel);
      // A THREAD SLACK NO LONGER HAS IS NEVER COMING BACK. Its root was deleted, and
      // an agent's every status write then fails with the same error and prints it:
      // one deleted message produced that line on every send for as long as the
      // record kept pointing at it. The caller drops the reference.
      return { ok: false, gone: GONE_THREAD_ERRORS.has(r.error ?? "") };
    }
    return { ok: true, gone: false };
  }

  /**
   *  Set status on Slack's native status surface where one exists, and display
   *  nothing where one does not.
   *
   *  `assistant.threads.setStatus` functions on standard channel threads, returning
   *  ok:true when called on a live channel thread without requiring an assistant
   *  direct message. The living message existed solely under that earlier
   *  assumption. Status belongs on Slack's native status surface, so posting working
   *  text into the channel creates the wrong layout. The system must implement status
   *  within Slack assistant status.
   *
   *  When no thread exists, Slack provides no native status surface, and the system
   *  emits silence.
   */
  async setOn(channel: string, agent: string, threadTs?: string): Promise<void> {
    // The ledger keys entries by channel and agent. Several agents work in one
    // channel, and this ledger held one record per channel, so one agent's status
    // overwrote another's, and any agent's reply cleared it. The live smoke test
    // caught this behavior when a peer's message in the channel removed the status
    // the listener had set for itself.
    const existing = this.load().find((r) => r.channel === channel && r.agent === agent);
    const thread = existing?.thread ?? threadTs;
    let took = existing?.thread !== undefined;
    let gone = false;
    if (this.cfg.backend === "slack" && thread !== undefined) {
      const cid = await this.channelId(channel);
      const set = cid === undefined ? { ok: false, gone: false } : await this.setThreadStatus(cid, thread, STATUS_TEXT, channel);
      took = set.ok;
      gone = set.gone;
    }
    if (gone) {
      this.report(
        `the thread this status pointed at is gone from Slack, so the record stops naming it and this ` +
          `agent shows no status here until a new thread arrives (thread ${thread})`,
        channel,
      );
    }
    this.locked((records) => {
      const idx = records.findIndex((r) => r.channel === channel && r.agent === agent);
      const expiresAt = this.cfg.now() + this.cfg.ttlMs;
      if (idx >= 0) {
        const rec = records[idx]!;
        rec.agent = agent;
        rec.expiresAt = expiresAt;
        // The reference goes with the thread it named, so the next write stops
        // asking Slack about a message nobody has.
        if (gone) delete rec.thread;
        return;
      }
      records.push({ channel, agent, expiresAt, ...(took && thread !== undefined ? { thread } : {}) });
    }, undefined);
  }

  /**
   *  The system clears a channel's status by deleting the active message or
   *  replacing its text, and then dropping the record. It takes no action when no
   *  active status exists.
   */
  async clearOn(channel: string, agent: string): Promise<void> {
    // The system applies changes only to this agent's own status. The system ignored
    // the parameter, so a message from any agent cleared whatever status the channel
    // held, including a status another agent had set while it was still working.
    const rec = this.load().find((r) => r.channel === channel && r.agent === agent);
    if (rec === undefined) return;
    if (this.cfg.backend === "slack") {
      const cid = await this.channelId(channel);
      // An EMPTY status notifies Slack that the agent stopped working.
      if (cid !== undefined && rec.thread !== undefined) await this.setThreadStatus(cid, rec.thread, "", channel);
    }
    this.locked((records) => {
      const idx = records.findIndex((r) => r.channel === channel && r.agent === agent);
      if (idx >= 0) records.splice(idx, 1);
    }, undefined);
  }

  // The living message has been removed, taking livingTs and livingTts with it.
  // They existed so a read could hide a status line from history. A status is no
  // longer a line, so there is nothing to hide and no timestamp to hide it by.
  // The system recognizes a peer's status from an older build by its isStatusLine
  // metadata marker.

  /**
   *  The value is true when a channel has an active, unexpired status.
   */
  isActive(channel: string): boolean {
    const now = this.cfg.now();
    return this.load().some((r) => r.channel === channel && r.expiresAt > now);
  }

  /**
   *  Each invocation of scramble removes all expired items before it executes its
   *  own work. The process deletes or replaces the text of an active message for an
   *  expired status and drops the record. The call returns the number of cleared
   *  entries so a listen loop can report on the sweep.
   */
  async clearExpired(): Promise<number> {
    const records = this.load();
    const now = this.cfg.now();
    const mine = (r: StatusRecord): boolean => this.cfg.agent === undefined || r.agent === this.cfg.agent;
    // An agent sweeps only its own rows. Sweeping every row meant querying Slack about
    // another agent's status under this agent's token, in a channel this agent may not
    // even be in. This was measured as
    // `status in team: channel_not_found (channel_id C0EXAMPLE006)` for a row
    // belonging to a different agent. A row whose owner never runs again sits expired
    // and inert, which `isActive` already ignores.
    const stale = records.filter((r) => r.expiresAt <= now && mine(r));
    if (stale.length === 0) return 0;
    for (const rec of stale) {
      if (this.cfg.backend === "slack") {
        const cid = await this.channelId(rec.channel);
        // An expiry removes Slack's own status.
        if (cid !== undefined && rec.thread !== undefined) await this.setThreadStatus(cid, rec.thread, "", rec.channel);
      }
    }
    // The process drops only what is still expired when the lock is held. Writing
    // the `kept` list computed before the Slack calls would delete every entry
    // another process added while they were in flight.
    return this.locked((current) => {
      const cutoff = this.cfg.now();
      let dropped = 0;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        if (current[i]!.expiresAt <= cutoff && mine(current[i]!)) {
          current.splice(i, 1);
          dropped += 1;
        }
      }
      return dropped;
    }, 0);
  }

  /**
   *  Long-lived listeners clear expired entries while they run. A ticker calls
   *  clearExpired on an interval until the returned stop is called. `sleep` is
   *  injectable so a test drives it without a real delay.
   */
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
