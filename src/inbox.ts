// THE INBOX LEDGER: one row per addressed line handed to this agent, and whether
// anything has been said back.
//
// The operator, 2026-08-22: "how do you 100% ensure that you guarantee to reply
// when you are addressed? Each of your inbox item must be addressed by at least 1
// reply."
//
// The check that existed was per TURN — a turn woken by someone addressing this
// agent had to send something before it ended — and a turn boundary is not an
// item boundary. Two items arriving together were satisfied by one reply. An item
// arriving after the turn had already sent something was satisfied by that
// earlier send. Counting items requires recording items.
//
// It is written by the DELIVERY path, so an item is open the moment it is handed
// over, and closed by the SEND path, so a reply closes it without anyone deciding
// that it counts. Neither end asks an agent to remember anything.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One addressed line, and what has answered it. */
export interface InboxItem {
  /** Slack ts (or the local backend's seq as a string): the item's identity. */
  id: string;
  channel: string;
  from: string;
  /** The thread this line sits in, when it is threaded. A reply into the thread
   *  closes it; so does a reply into the channel. */
  thread?: string;
  /** First 120 characters, so `inbox pending` names what is unanswered rather
   *  than printing an id nobody can place. */
  text: string;
  /** When it was recorded, as an ISO string, for the age in the report. */
  at: string;
  /** The id of the message that answered it, once one has. */
  answeredBy?: string;
}

export function inboxPath(configPath: string, agent: string): string {
  return join(dirname(configPath), "inbox", `${agent}.jsonl`);
}

/** Every row, oldest first. A malformed line is SKIPPED rather than fatal: a
 *  half-written row from a killed process must not take the whole ledger down,
 *  since the ledger's job is to be readable at the moment something went wrong. */
export function readInbox(path: string): InboxItem[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: InboxItem[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as InboxItem;
      if (typeof row.id === "string" && typeof row.channel === "string") out.push(row);
    } catch {
      continue;
    }
  }
  return out;
}

/** Record an addressed line as OPEN. Appending is idempotent by id: the same
 *  message delivered twice (a listener and a sweep both seeing it) is one item,
 *  not two, or every duplicate delivery would demand its own reply. */
export function recordInboxItem(path: string, item: InboxItem): void {
  const existing = readInbox(path);
  if (existing.some((r) => r.id === item.id)) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(item)}\n`);
}

/** Close every open item a reply answers: same channel, recorded before the
 *  reply. A threaded reply also closes the thread's items even when the ledger
 *  recorded them against the channel.
 *
 *  CHANNEL-WIDE ON PURPOSE. A narrower rule (close only the exact thread) would
 *  leave an item open after it had been answered in the room, and a gate that
 *  cries wolf is one I stop reading. The looser direction costs a missed nag; the
 *  tighter one costs the whole mechanism. */
export function closeInboxItems(path: string, channel: string, replyId: string, thread?: string): number {
  const rows = readInbox(path);
  if (rows.length === 0) return 0;
  let closed = 0;
  for (const r of rows) {
    if (r.answeredBy !== undefined) continue;
    const sameChannel = r.channel === channel;
    const sameThread = thread !== undefined && thread !== "" && (r.thread === thread || r.id === thread);
    if (sameChannel || sameThread) {
      r.answeredBy = replyId;
      closed += 1;
    }
  }
  if (closed > 0) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }
  return closed;
}

/** Items nobody has answered, oldest first. */
export function pendingInbox(path: string): InboxItem[] {
  return readInbox(path).filter((r) => r.answeredBy === undefined);
}

/** The line an agent (or a gate) reads. Empty when nothing is open. */
export function pendingReport(items: InboxItem[], agent: string): string {
  if (items.length === 0) return "";
  const lines = items.map((r) => `  ${r.channel} ${r.id} from ${r.from}: ${r.text}`);
  return (
    `${items.length} inbox item(s) addressed to ${agent} with no reply:\n${lines.join("\n")}\n` +
    `Every one of them is someone waiting. Answer in the channel it was asked in.`
  );
}

/** Should this delivered line become an item? Only lines ADDRESSED to this agent
 *  by someone else. An agent's own line never reaches the delivery path, and a
 *  line that merely passed through a channel is not a question. */
export function isAddressed(d: { mentioned?: unknown; from?: unknown }, agent: string): boolean {
  return d.mentioned === true && typeof d.from === "string" && d.from !== agent;
}
