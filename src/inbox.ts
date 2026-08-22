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
import { BROADCAST_NAMES } from "./slack-backend";

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
  /** Was this line ADDRESSED to this agent, and so did it owe an answer?
   *
   *  Every delivered line is recorded, addressed or not, because "did this reach
   *  me" and "did this wake me" are different questions and the ledger is the
   *  only place that can answer both. Only `addressed` rows appear in `pending`.
   *
   *  ABSENT MEANS TRUE: every row written before this field existed was an
   *  addressed item, since nothing else was recorded then. */
  addressed?: boolean;
}

/** Did this row oblige an answer? Absent means yes, for rows predating the field. */
function owesAnswer(r: InboxItem): boolean {
  return r.addressed !== false;
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

/** Record an addressed line as OPEN. Appending is idempotent by CHANNEL AND id:
 *  the same message delivered twice (a listener and a sweep both seeing it) is
 *  one item, and every duplicate delivery would otherwise demand its own reply.
 *
 *  Both halves of the key are needed. A Slack ts is unique within a channel and
 *  says nothing across channels, so keying on the id alone drops a real question
 *  from one channel because another channel happened to carry a message at the
 *  same instant. A test found that by asserting two channels at one ts. */
export function recordInboxItem(path: string, item: InboxItem): void {
  const existing = readInbox(path);
  if (existing.some((r) => r.id === item.id && r.channel === item.channel)) return;
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
    if (r.answeredBy !== undefined || !owesAnswer(r)) continue;
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

/** Close every open item OLDER than a message this agent already sent in that
 *  channel. Returns how many it closed.
 *
 *  A reply is a reply whether or not it went through this CLI while the ledger
 *  existed. Without this, five questions answered hours before the ledger was
 *  written sat in `pending` forever, and a list that names answered questions is
 *  one an agent learns to scroll past.
 *
 *  Timestamps compare as NUMBERS: a Slack ts is "1787359081.749909", and string
 *  order breaks the moment the integer part changes width. */
export function closeAnsweredBefore(path: string, channel: string, ownTs: string): number {
  const cutoff = Number(ownTs);
  if (!Number.isFinite(cutoff)) return 0;
  const rows = readInbox(path);
  let closed = 0;
  for (const r of rows) {
    if (r.answeredBy !== undefined || !owesAnswer(r) || r.channel !== channel) continue;
    const at = Number(r.id);
    if (Number.isFinite(at) && at < cutoff) {
      r.answeredBy = `own message ${ownTs}`;
      closed += 1;
    }
  }
  if (closed > 0) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }
  return closed;
}

/** Items nobody has answered, oldest first. Rows recorded as merely DELIVERED
 *  are not items: they are the record that lets `trace` tell "never reached me"
 *  apart from "reached me and did not wake me". */
export function pendingInbox(path: string): InboxItem[] {
  return readInbox(path).filter((r) => r.answeredBy === undefined && owesAnswer(r));
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

/** WHAT HAPPENED TO ONE MESSAGE, from this agent's own record.
 *
 *  Four agents on four hosts spent a day answering "did that message reach me?"
 *  by grepping a `tee` of the listener, and every hand-rolled version was wrong
 *  in one of four ways, each measured by the agent who ran it (2026-08-22):
 *
 *  1. A substring grep for a ts matches a message QUOTING that ts as readily as
 *     the delivery of it. One agent got a hit that was another agent's message
 *     about the timestamp, and it read as proof of delivery.
 *  2. The same grep can be right by luck. A second agent got zero, the true
 *     answer, and it was true only because nobody had quoted the ts yet. A false
 *     negative that happens to be right teaches nothing and leaves the method in
 *     place.
 *  3. Parsing every line as JSON crashes on a wake file that also carries plain
 *     English diagnostics, so the check dies exactly when the wake path is
 *     broken, which is the one occasion anybody runs it.
 *  4. A bare True/False has no positive control, so a correct absence and a
 *     broken search are the same output.
 *
 *  This compares the id FIELD, so a quotation cannot match it; it skips rows it
 *  cannot parse, so a diagnostic line cannot kill it; and it always prints the
 *  corpus it searched, so an absence can be told apart from an empty ledger.
 *
 *  It answers two questions that a single "was it there" conflates: DELIVERED
 *  (did this line reach me at all) and ADDRESSED (did it wake me, or did it wait
 *  for a sweep). That distinction is the whole broadcast defect: `<!channel>`
 *  was delivered to four agents and addressed to none of them. */
export function traceReport(rows: InboxItem[], id: string, agent: string, path: string): string {
  const corpus =
    rows.length === 0
      ? `The ledger at ${path} holds NO rows, so this absence says nothing about the message: ` +
        `either nothing has been delivered to ${agent} yet, or the ledger is not being written. ` +
        `Run \`scramble doctor\` before reading anything into it.`
      : `Searched ${rows.length} delivered row(s) for ${agent} in ${path}, ` +
        `ids ${rows[0]?.id ?? "?"} to ${rows[rows.length - 1]?.id ?? "?"}, ` +
        `${rows.filter(owesAnswer).length} of them addressed to this agent.`;
  const hits = rows.filter((r) => r.id === id);
  if (hits.length === 0) {
    return (
      `${id} was NOT delivered to ${agent}.\n${corpus}\n` +
      `A message can also be absent here and still exist: \`message read\` shows a channel's ` +
      `history without delivering anything, so a line seen there and missing here reached the ` +
      `channel and never reached this agent.`
    );
  }
  const lines = hits.map((r) => {
    const woke = owesAnswer(r)
      ? `ADDRESSED to ${agent}, so it woke this agent`
      : `delivered but NOT addressed to ${agent}, so nothing woke: it was visible only to a sweep`;
    const answer = r.answeredBy === undefined ? "no reply recorded" : `answered by ${r.answeredBy}`;
    return `  ${r.channel} from ${r.from} at ${r.at}: ${woke}, ${answer}\n    ${r.text}`;
  });
  return `${id} WAS delivered to ${agent}, ${hits.length} row(s):\n${lines.join("\n")}\n${corpus}`;
}

/** Should this delivered line become an item? Only lines ADDRESSED to this agent
 *  by someone else.
 *
 *  DELIVERY AND OBLIGATION ARE DIFFERENT QUESTIONS. A message in a thread this
 *  agent is part of is delivered with `mentioned:true`, which is right: a reply
 *  in your own thread reaches you. It is NOT automatically yours to answer. A
 *  peer wrote "@alignment_benchmark there is a concrete overlap" inside a thread
 *  I had replied in, and `inbox pending` told me someone was waiting on me for a
 *  question addressed to somebody else. A list that names other people's
 *  questions is one I learn to scroll past, which costs the whole mechanism.
 *
 *  So: named here, or naming nobody. A line that names OTHER agents and not this
 *  one is someone else's to answer, however visible it is.
 *
 *  `names` is this agent's identities, its scramble name and its Slack handle,
 *  because a mention resolves to the handle and the two differ. */
export function isAddressed(
  d: { mentioned?: unknown; from?: unknown; mentions?: unknown },
  names: string[],
): boolean {
  if (d.mentioned !== true || typeof d.from !== "string") return false;
  if (names.includes(d.from)) return false;
  const mentions = Array.isArray(d.mentions) ? d.mentions.filter((m): m is string => typeof m === "string") : [];
  if (mentions.length === 0) return true;
  // A BROADCAST NAMES NO ONE AND ADDRESSES EVERYONE. Without this the rule above
  // reads `@channel` as somebody else's name and drops it, so the operator's
  // "<!channel> ..." would reach no agent's ledger even once delivery carries it.
  if (mentions.some((m) => BROADCAST_NAMES.includes(m))) return true;
  return mentions.some((m) => names.includes(m));
}
