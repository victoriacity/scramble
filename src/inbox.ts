// The inbox ledger records one row per addressed line handed to this agent and
// tracks whether the agent has replied.
//
// The system must guarantee 100% that it replies when addressed, so at least 1
// reply must address each inbox item.
//
// The previous check operated per turn. A turn woken by someone addressing this
// agent had to send a message before ending, but turn boundaries differ from item
// boundaries. Two items arriving together were satisfied by one reply. An item
// arriving after the turn had already sent a message was satisfied by that earlier
// send. Counting items requires recording items.
//
// The delivery path writes the ledger, so an item is open the moment it is handed
// over. The send path closes the entry, so a reply closes the item without anyone
// deciding that it counts. Neither end asks an agent to remember anything.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "./filelock";
import { BROADCAST_NAMES } from "./slack-backend";

/**
 *  One addressed line pairs with the response that answered it.
 */
export interface InboxItem {
  /**
   *  The Slack ts timestamp, or the local backend's seq value as a string,
   *  identifies the item.
   */
  id: string;
  channel: string;
  from: string;
  /**
   *  The line belongs to this thread when it is threaded. A reply posted to the
   *  thread closes it, and a reply posted to the channel also closes it.
   */
  thread?: string;
  /**
   *  The output shows the first 120 characters, so `inbox pending` names what is
   *  unanswered.
   */
  text: string;
  /**
   *  The field stores the time it was recorded as an ISO string to provide the age
   *  in the report.
   */
  at: string;
  /**
   *  The identifier of the message that answered it is recorded once a reply
   *  arrives.
   */
  answeredBy?: string;
  /**
   *  This field stores the names the delivery carried, so `inbox trace` can explain
   *  why a row belongs to this agent. Without it, the ledger records the verdict and
   *  drops the evidence, and two agents spent a round guessing which mention opened
   *  six items. The field is absent on rows written before this field.
   */
  mentions?: string[];
  /**
   *  This field records whether an incoming line addressed this agent and
   *  required an answer.
   *
   *  The ledger records every delivered line, whether addressed or unaddressed,
   *  because whether a line reached the agent and whether it woke the agent are
   *  distinct questions and the ledger is the only place that answers both.
   *  Only `addressed` rows appear in `pending`.
   *
   *  An absent field evaluates to true: every row written before this field
   *  existed was an addressed item, since the system recorded only addressed items
   *  at that time.
   */
  addressed?: boolean;
  /**
   *  The Slack app ID that received this line.
   *
   *  The ledger keys records by agent name, and an operator can repoint a name at a
   *  different Slack app. `xingyu-bot` pointed at one app for an hour and then
   *  received its own app, and its ledger holds 14 rows from a channel the current
   *  app has never entered. Those entries combine two identities reported under one
   *  name in one corpus. Recording the app ID makes this seam visible to anyone who
   *  reads the file.
   */
  app?: string;
}

/**
 *  This field indicates whether the row required an answer. For rows that predate
 *  the field, an absent value means the row required an answer.
 */
function owesAnswer(r: InboxItem): boolean {
  return r.addressed !== false;
}

export function inboxPath(configPath: string, agent: string): string {
  return join(dirname(configPath), "inbox", `${agent}.jsonl`);
}

/**
 *  The system processes every row, starting with the oldest. The parser skips any
 *  malformed line. A half-written row from a killed process must not take down the
 *  entire ledger, since the ledger's job is to remain readable at the moment
 *  something went wrong.
 */
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

/**
 *  The system records an addressed line as OPEN. Appending is idempotent across the
 *  channel and the message id. When a listener and a sweep both encounter the same
 *  message, duplicate delivery yields one item, and every duplicate delivery would
 *  otherwise demand its own reply.
 *
 *  Both halves of the key are required. A Slack ts is unique within a channel and
 *  says nothing across channels, so keying on the id alone drops a real question
 *  from one channel because another channel carried a message at the same instant.
 *  A test verified this failure mode by asserting two channels at one ts.
 */
export function recordInboxItem(path: string, item: InboxItem): void {
  // The deduplication read and the append execute in one step because two processes
  // delivering the same message at once would both read no row and both append.
  withFileLock(path, () => {
    const existing = readInbox(path);
    if (existing.some((r) => r.id === item.id && r.channel === item.channel)) return;
    appendFileSync(path, `${JSON.stringify(item)}\n`);
  });
}

/**
 *  The ledger closes every open item that a reply answers, provided the item was
 *  recorded before the reply arrived.
 *
 *  A channel-level reply closes channel items, because an answer given in the
 *  channel resolves what the channel asked. A threaded reply closes that thread's
 *  items, including an item the ledger recorded against the channel when the
 *  item's own timestamp serves as the thread root.
 *
 *  A threaded reply leaves channel items open. Closing channel items from a thread
 *  previously caused a dropped question: xingyubot asked a question at channel
 *  level, a reply went to a different agent inside a thread half a minute later,
 *  and the ledger marked the channel question answered by that reply. The sender
 *  waited while the item disappeared from the pending list (timestamp
 *  1787664642.769859 closed by 1787664661.695049). Earlier documentation called
 *  the looser rule a missed nag. The consequence is a dropped question, and the
 *  person who asked it never learns that.
 */
export function closeInboxItems(path: string, channel: string, replyId: string, thread?: string): number {
  return withFileLock(path, () => closeInsideLock(path, channel, replyId, thread));
}

/**
 *  Measurements showed that eight processes that each closed one item left two
 *  items open, because every close operation read the entire ledger, modified what
 *  it read, and wrote the ledger back. A lost close prompts an agent about a
 *  question it has already answered, which is how an agent learns to stop reading
 *  its own list.
 */
function closeInsideLock(path: string, channel: string, replyId: string, thread?: string): number {
  const rows = readInbox(path);
  if (rows.length === 0) return 0;
  let closed = 0;
  for (const r of rows) {
    if (r.answeredBy !== undefined || !owesAnswer(r)) continue;
    const inThread = thread !== undefined && thread !== "";
    const sameChannel = r.channel === channel && !inThread;
    const sameThread = inThread && (r.thread === thread || r.id === thread);
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

/**
 *  The command closes every open item older than a message this agent already sent
 *  in that channel, and it returns the number of closed items.
 *
 *  A reply counts as a reply whether or not it went through this CLI while the
 *  ledger existed. Without this check, five questions answered hours before the
 *  ledger was written sat in `pending` forever, and an agent learns to scroll past a
 *  list that names answered questions.
 *
 *  The system compares timestamps as numbers, because a Slack ts is
 *  "1787359081.749909", and string ordering breaks the moment the integer part
 *  changes width.
 */
export function closeAnsweredBefore(path: string, channel: string, ownTs: string): number {
  const cutoff = Number(ownTs);
  if (!Number.isFinite(cutoff)) return 0;
  return withFileLock(path, () => closeBeforeInsideLock(path, channel, ownTs, cutoff));
}

function closeBeforeInsideLock(path: string, channel: string, ownTs: string, cutoff: number): number {
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

/**
 *  Close one open item by identifier with an explanatory reason without sending a
 *  message.
 *
 *  A sender can indicate that a message needs no reply, but the ledger previously
 *  had no way to record that request. The `pending` state kept the item open,
 *  reactions did not clear the item, and only an outgoing message closed it.
 *  Therefore, an agent clearing its ledger answered messages whose senders
 *  requested no response, and the mechanism intended to prevent unhandled messages
 *  generated noise when processing automated messages.
 *
 *  The caller must provide a reason, and the ledger stores it. A close operation
 *  marks an obligation as settled, which a reply does not do, so the system records
 *  the decision where `trace` and the file itself display it. The call returns the
 *  outcome so the caller distinguishes a missing item from one that was already
 *  answered.
 *
 *  This mechanism does not use a sender-side flag because the flag would travel in
 *  the message text, and parsing markers out of prose introduces pattern-matching
 *  defects that this repository removed. Closing an item with a reaction requires
 *  the `reactions:read` scope and the `reaction_added` event, which no agent
 *  subscribes to yet.
 */
export function closeItemById(
  path: string,
  id: string,
  reason: string,
): { ok: true } | { ok: false; why: "unknown" | "answered"; answeredBy?: string } {
  return withFileLock(path, () => closeByIdInsideLock(path, id, reason));
}

function closeByIdInsideLock(
  path: string,
  id: string,
  reason: string,
): { ok: true } | { ok: false; why: "unknown" | "answered"; answeredBy?: string } {
  const rows = readInbox(path);
  const row = rows.find((r) => r.id === id && owesAnswer(r));
  if (row === undefined) return { ok: false, why: "unknown" };
  if (row.answeredBy !== undefined) return { ok: false, why: "answered", answeredBy: row.answeredBy };
  row.answeredBy = `closed with no reply: ${reason}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return { ok: true };
}

/**
 *  This view lists items that have received no answer, ordered oldest first. Rows
 *  recorded as DELIVERED serve as logs that allow `trace` to distinguish between
 *  "never reached me" and "reached me and did not wake me".
 */
export function pendingInbox(path: string): InboxItem[] {
  return readInbox(path).filter((r) => r.answeredBy === undefined && owesAnswer(r));
}

/**
 *  An agent or a gate reads this line. The line is empty when nothing is open.
 */
export function pendingReport(items: InboxItem[], agent: string): string {
  if (items.length === 0) return "";
  const lines = items.map((r) => `  ${r.channel} ${r.id} from ${r.from}: ${r.text}`);
  return (
    `pending: ${items.length} inbox item(s) addressed to ${agent} with no reply:\n${lines.join("\n")}\n` +
    `Every one of them is someone waiting. Answer in the channel it was asked in.`
  );
}

/**
 *  WHAT HAPPENED TO ONE MESSAGE, from this agent's own record.
 *
 *  Four agents on four hosts spent a day determining whether a message reached
 *  them by grepping a `tee` of the listener process. Every custom command was wrong
 *  in one of four ways, which each agent measured directly:
 *
 *  1. A substring grep for a timestamp matches a message that quotes that
 *  timestamp as readily as the delivery entry itself. One agent matched a
 *  message from another agent discussing the timestamp, and the output read as
 *  proof of delivery.
 *  2. The same grep can succeed by luck. A second agent obtained zero matches,
 *  which was the true answer only because nobody had quoted the timestamp yet.
 *  A false negative that happens to be right teaches nothing and leaves the
 *  flawed method in place.
 *  3. Parsing every line as JSON crashes on a wake file that also contains plain
 *  English diagnostics, so the check fails whenever the wake path is broken,
 *  which is the one occasion someone runs it.
 *  4. A bare True/False output lacks a positive control, so a correct absence
 *  and a broken search produce the same result.
 *
 *  This check compares the id field, so a quotation cannot match it. It skips
 *  lines it cannot parse, so a diagnostic line cannot kill it. It always prints
 *  the corpus it searched, so the reader can tell an absence apart from an empty
 *  ledger.
 *
 *  It answers two separate questions that a single presence check conflates:
 *  DELIVERED (whether this line reached the agent at all) and ADDRESSED (whether
 *  the line woke the agent or waited for a sweep). That distinction forms the
 *  entire broadcast defect: `<!channel>` was delivered to four agents and was
 *  addressed to none of them.
 */
export function traceReport(rows: InboxItem[], id: string, agent: string, path: string, app?: string): string {
  // The system counts rows by what each row carries. The first version printed
  // "88 of them addressed to this agent" for a file where 88 rows carry no
  // `addressed` field at all, because the backward-compatibility rule that keeps
  // old items in `pending` was reused as a measurement. The output inferred the
  // count from a missing field and printed it as though measured.
  const addressed = rows.filter((r) => r.addressed === true).length;
  const deliveredOnly = rows.filter((r) => r.addressed === false).length;
  const blind = rows.filter((r) => r.addressed === undefined);
  const foreign = rows.filter((r) => r.app !== undefined && app !== undefined && r.app !== app);
  const corpus =
    rows.length === 0
      ? `The ledger at ${path} holds NO rows, so this absence says nothing about the message: ` +
        `either nothing has been delivered to ${agent} yet, or the ledger is not being written. ` +
        `Run \`scramble doctor\` before reading anything into it.`
      : `Searched ${rows.length} delivered row(s) for ${agent} in ${path}, ` +
        `ids ${rows[0]?.id ?? "?"} to ${rows[rows.length - 1]?.id ?? "?"}: ` +
        `${addressed} addressed to this agent, ${deliveredOnly} delivered without addressing it, ` +
        `${blind.length} written before the ledger recorded unaddressed deliveries.`;
  const seam =
    foreign.length === 0
      ? ""
      : `\n${foreign.length} row(s) here were delivered to app ` +
        `${[...new Set(foreign.map((r) => r.app))].join(", ")}, which is NOT this agent's app ${app}. ` +
        `The ledger is keyed by agent NAME, so repointing a name at a different Slack app inherits ` +
        `the old app's rows and this file holds two identities under one name.`;
  const hits = rows.filter((r) => r.id === id);
  if (hits.length === 0) {
    // Missing entries across rows from that period prove nothing, and reporting them
    // as "NOT delivered" is the exact failure this command exists to prevent. The
    // system wrote those rows when it recorded only addressed lines, so it never
    // wrote an unaddressed delivery during that span. An unaddressed delivery is
    // absent here in the same way a message that never arrived is absent. A broadcast
    // is an example of such a delivery.
    const newest = Number(blind[blind.length - 1]?.id);
    const asked = Number(id);
    const outside = Number.isFinite(newest) && Number.isFinite(asked) && asked > newest;
    const caveat =
      blind.length === 0
        ? ""
        : outside
          ? `\nThose ${blind.length} row(s) end at ${blind[blind.length - 1]?.id}, older than ${id}, ` +
            `so they do not touch this verdict.`
          : `\nTHIS VERDICT IS UNSOUND FOR THIS ID: ${blind.length} row(s), ` +
            `${blind[0]?.id} to ${blind[blind.length - 1]?.id}, were written when the ledger recorded ` +
            `ONLY addressed lines. A delivery in that span that addressed nobody was never written, ` +
            `so it is missing here exactly as a message that never arrived is missing, and a ` +
            `broadcast is precisely that case. Read the channel for this one.`;
    return (
      `${id} was NOT delivered to ${agent}.\n${corpus}${seam}${caveat}\n` +
      `A message can also be absent here and still exist: \`message read\` shows a channel's ` +
      `history without delivering anything, so a line seen there and missing here reached the ` +
      `channel and never reached this agent.`
    );
  }
  const lines = hits.map((r) => {
    // The delivery carried the names that identify why this belongs to this agent.
    // The verdict alone led two agents to guess which mention opened six items, and
    // one guess reached the channel as a cause.
    const why =
      r.mentions === undefined
        ? ``
        : r.mentions.length === 0
          ? ` The line named nobody, so a reply in a thread this agent is in is what could carry it.`
          : ` The line named ${r.mentions.map((m) => `@${m}`).join(", ")}.`;
    const woke =
      r.addressed === undefined
        ? `whether it ADDRESSED ${agent} is UNRECORDED: this row predates that field`
        : r.addressed
          ? `ADDRESSED to ${agent}, so it woke this agent.${why}`
          : `delivered but NOT addressed to ${agent}, so nothing woke: it was visible only to a sweep.${why}`;
    const answer = r.answeredBy === undefined ? "no reply recorded" : `answered by ${r.answeredBy}`;
    return `  ${r.channel} from ${r.from} at ${r.at}: ${woke}, ${answer}\n    ${r.text}`;
  });
  return `${id} WAS delivered to ${agent}, ${hits.length} row(s):\n${lines.join("\n")}\n${corpus}${seam}`;
}

/**
 *  The file records the timestamp values of messages this agent has sent, so a
 *  reply to one of them is recognized as an answer owed to this agent.
 *
 *  The file keeps the newest 500 values, which is far more than any thread where
 *  this agent is still receiving replies, and stops a long-running listener from
 *  growing a file forever.
 */
export function sentPath(configPath: string, agent: string): string {
  return join(dirname(configPath), "sent", `${agent}.jsonl`);
}

/**
 *  This row represents one send by this agent. Rows written before this shape
 *  contain only a timestamp, and they read as a row with no draft on it.
 */
export interface SentRow {
  ts: string;
  /**
   *  When this message was deleted from the channel, if it was.
   *
   *  A DELETED MESSAGE IS NOT IN THE CHANNEL, so it cannot be a duplicate of
   *  anything. An agent posted into the wrong thread, deleted the message, and the
   *  resend was refused as a duplicate of the message they had just removed, naming
   *  the timestamp of a line Slack no longer holds. The row survives with this
   *  field, since the record of what was sent stays true.
   */
  deleted?: string;
  /**
   *  The digest contains the text the author typed before the rewriter processed it.
   *  The rewritten output of a draft differs across runs, so the draft is the part
   *  that repeats when someone submits the same text twice.
   */
  hash?: string;
  channel?: string;
  at?: string;
  /**
   *  A REWORDED retry keeps the draft's content words.
   *
   *  A digest catches a byte-identical resend and nothing else. An agent sent one
   *  end-to-end run twice, 127 seconds apart, at 0.970 word overlap. The second
   *  draft named the same ports and the same three images in different sentences,
   *  and the digest guard passed it.
   */
  words?: string[];
  /**
   *  The record shows how much this draft shared with the closest message this
   *  agent had already sent to the same channel inside the window, and which
   *  timestamp that was.
   *
   *  The tool collects its own calibration data. The threshold rests on three
   *  agents' one-off corpus runs, and the CJK number rests on two synthetic pairs
   *  that disagree by a factor of two. An agent that writes English by the
   *  operator's rule cannot produce Chinese samples on request, and the tool can
   *  gather them. Every send now records what it measured, so the distribution
   *  accumulates in the field for whoever tunes the number.
   */
  near?: { score: number; ts: string; again?: boolean };
}

/**
 *  The system extracts the content words of a draft, converts them to lowercase,
 *  removes duplicates, and sorts them.
 *
 *  Short words carry the grammatical structure that rewording changes, so the
 *  process drops them. The surviving words represent the core topic of the message,
 *  which a retry repeats. The system retains fenced blocks, since an evidence
 *  table is the part that a retry copies verbatim.
 */
/**
 *  The system collects, deduplicates, and sorts every token that a draft carries,
 *  including words of any length, numbers, and CJK character bigrams.
 *
 *  Short drafts require short words. The `contentWords` filter drops tokens under
 *  four characters, which is right for a report and wrong for a one-line status:
 *  a real duplicate that two agents confirmed, with one line sent twice 127 seconds
 *  apart, held 6 and 5 content words and never reached the scorer at all. The
 *  system compares a short pair on the full set.
 */
export function allWords(text: string): string[] {
  // Because CJK text carries no spaces, a word filter written for ASCII reduced a
  // Chinese message to its identifiers: 166 Chinese characters yielded 20 tokens,
  // and every token was a number or a path. Two unrelated Chinese reports then
  // scored 0.500 on shared shas alone. Character bigrams stand in for segmentation
  // without a dictionary, so a shared phrase appears as shared bigrams. A run of
  // one character retains that character.
  //
  // The filter trims edge punctuation from a word while preserving inner dots and
  // slashes, so a path and a version number survive whole. Without that, `fallback.`
  // at the end of a sentence counted as a different word from `fallback`.
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
  const grams: string[] = [];
  for (const run of text.match(cjk) ?? []) {
    if (run.length === 1) grams.push(run);
    for (let i = 0; i + 1 < run.length; i += 1) grams.push(run.slice(i, i + 2));
  }
  const words = text
    .toLowerCase()
    .replace(cjk, " ")
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(" ")
    .map((w) => w.replace(/^[./-]+/, "").replace(/[./-]+$/, ""))
    .filter((w) => w !== "");
  return [...new Set([...words, ...grams])].sort();
}

/**
 *  The subset of a token list that carries the message's subject contains tokens
 *  with four or more characters or any token holding a digit.
 */
export function contentOf(words: string[]): string[] {
  // A CJK bigram is content regardless of its length. Because this filter kept
  // tokens of four characters or more, deriving the content words from the full
  // token set dropped every bigram and reduced a Chinese message to its
  // identifiers. An agent had reported this defect an hour earlier. A refactor
  // reintroduced the defect, and the test written for the defect caught it.
  const cjk = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
  return words.filter((w) => w.length >= 4 || /[0-9]/.test(w) || cjk.test(w));
}

export function contentWords(text: string): string[] {
  // The codebase uses a single tokenizer and a single filter. This component held a
  // duplicate tokenizer for an hour after `allWords` arrived, which created two
  // places to fix whenever a script or punctuation rule changes. The coverage gate
  // found the duplicate copy because its CJK branch was unreached, since every CJK
  // test ran through the other tokenizer.
  return contentOf(allWords(text));
}

/**
 *  THE LABELLED PAIRS THE THRESHOLDS COME FROM, with who measured each one.
 *
 *  An earlier citation used a synthetic pair for the founding incident's score,
 *  though the real pair belonged to a third agent and scored on the other scale.
 *  A claim about a labelled pair now reads from this table.
 *
 *  `ts` is empty where the pair is synthetic, which is what makes a synthetic pair
 *  impossible to cite as a real one.
 */
export const CALIBRATION: Array<{
  what: string;
  measuredBy: string;
  /**
   *  This entry records which of the two cuts evaluates the pair, and when someone
   *  measured it.
   *
   *  The system judges a row at both cuts if the row lacks one. Three byte-identical
   *  pairs arrived from another agent's log as a channel, two timestamps, a score,
   *  and a hash, with no scale. Slack deleted half of each pair, so nothing here can
   *  derive the scale. Writing "content" in that gap would record a measurement
   *  nobody took, which is the error this table exists to stop.
   */
  scale?: "content" | "short";
  score: number;
  label: "duplicate" | "wanted";
  /**
   *  This field records the channel where the two messages were sent. A timestamp
   *  identifier `ts` is unique within a single conversation, so an operator can only
   *  re-measure a row without it by guessing where to search, and `--calibrate` cannot
   *  tell "this agent is not in that channel" apart from "Slack has no such message".
   */
  channel?: string;
  /**
   *  The `measured` label indicates that the pair consists of two messages that
   *  someone sent. The `synthetic` label indicates that someone wrote the pair by
   *  hand, and it decides no threshold.
   *
   *  The system previously checked for the presence of `ts` first, which classified
   *  any corpus measurement without a recorded `ts` as hand-made. Because of this,
   *  the install report at 0.800 originated from another agent's real message
   *  transmissions and counted as synthetic. Provenance is its own field.
   */
  source: "measured" | "synthetic";
  /**
   *  When a message is a reply, it sits under a thread root.
   *
   *  `conversations.history` omits thread replies. The install pair is two replies
   *  under two different roots, so reading the channel history answered "no such
   *  message" for messages that are there. One page of 100 roots in that channel
   *  hides 219 replies behind 43 of them.
   */
  threads?: [string, string];
  /**
   *  The messages no longer exist. The first message in the 0.968 pair was deleted
   *  after the duplicate report that named it, so that row can never be re-measured.
   *  The row stands on the reading taken while both messages existed.
   */
  gone?: true;
  /**
   *  These values contain the first 16 hexadecimal characters of the SHA-256 hash of
   *  each message's delivered payload text, as recorded by the agent that measured
   *  the pair.
   *
   *  The listeners serve as the archive. Slack has already lost four of the five
   *  source messages behind these rows: one was deleted after the report that named
   *  it, and four more were removed in a morning cleanup. Every listener writes each
   *  delivery to disk before any deletion occurs, and nothing prunes a wake file, so
   *  an agent holding the text can confirm it is the same text.
   *
   *  `--calibrate` does not compare these values. It reads the message back through
   *  `storedMessage`, which renders entities and undoes Slack's escapes, so its text
   *  hashes differently from the payload that produced these values. Comparing the
   *  two forms would report a mismatch on every row.
   */
  sha?: [string, string];
  ts?: [string, string];
}> = [
  {
    // The initial evaluation measured the excerpt as the complete message. The quoted
    // lines in the report that named this pair are one-line summaries. The messages
    // hold 93 and 96 content words and score on the content scale. The reading of 6
    // and 5 words came from the quotes, and led to the conclusion that the guard never
    // scored the pair. The agent who found the pair called these functions directly
    // and corrected the measurement.
    what: "one test pass reported twice, 127 seconds apart, 93 and 96 content words",
    measuredBy: "model-failure-research, from another agent's sends",
    source: "measured",
    scale: "content",
    score: 0.968,
    label: "duplicate",
    channel: "a channel this host cannot read",
    gone: true,
    sha: ["cf58e1ca70538915", "7f6bf4854b7834b6"],
    // Slack no longer contains the first message. An agent examined the surrounding
    // span and found 35 lines where that timestamp is absent while its neighbour is
    // present, so this row can never be re-measured. The 0.968 result stands on the
    // reading taken while the message existed.
    ts: ["1787904164.508349", "1787904291.555039"],
  },
  {
    what: "an install report against its neighbour, 159 seconds apart",
    measuredBy: "model-failure-research, from alignment-benchmark's sends",
    source: "measured",
    scale: "content",
    score: 0.8,
    label: "wanted",
    channel: "scramble-dev",
    threads: ["1787660956.066699", "1787661139.135859"],
    sha: ["903349e007124496", "77d4bd402ebeba83"],
    ts: ["1787661004.777419", "1787661164.217229"],
  },
  {
    // This value is synthetic, so it carries no timestamp. A citation used this
    // value as the founding incident's score, and two agents built threshold arguments
    // on that number before the real pair was measured at 0.968.
    what: "a report reworded and sent again, written by hand",
    measuredBy: "scramble-dev",
    source: "synthetic",
    scale: "content",
    score: 0.833,
    label: "duplicate",
  },
  { what: "two status reports on different runs", measuredBy: "scramble-dev", source: "synthetic", scale: "content", score: 0.429, label: "wanted" },
  { what: "an addendum to a one-line report", measuredBy: "scramble-dev", source: "synthetic", scale: "short", score: 0.571, label: "wanted" },
  { what: "two unrelated one-liners", measuredBy: "scramble-dev", source: "synthetic", scale: "short", score: 0.5, label: "wanted" },
  {
    // The score alone cannot show byte-identical content. A score of 1.000 and a
    // heavy reword that shares every content word read the same in this column, and
    // equal hashes distinguish them. Senders deleted half of each pair after the
    // duplicate report, so these rows rely on the log of the agent that read them and
    // carry no scale.
    what: "one report sent twice unchanged, 22 seconds apart",
    measuredBy: "model-failure-research, from a second agent's sends",
    source: "measured",
    score: 1,
    label: "duplicate",
    channel: "scramble-dev",
    gone: true,
    sha: ["721e6b2fff34f1d3", "721e6b2fff34f1d3"],
    ts: ["1787715753.687609", "1787715776.111169"],
  },
  {
    what: "one report sent twice unchanged, 19 seconds apart",
    measuredBy: "model-failure-research, from a second agent's sends",
    source: "measured",
    score: 1,
    label: "duplicate",
    channel: "scramble-dev",
    gone: true,
    sha: ["30cd746759f7fc9e", "30cd746759f7fc9e"],
    ts: ["1787715959.589289", "1787715978.816959"],
  },
  {
    what: "one report sent twice unchanged, 26 seconds apart",
    measuredBy: "model-failure-research, from a second agent's sends",
    source: "measured",
    score: 1,
    label: "duplicate",
    channel: "scramble-dev",
    gone: true,
    sha: ["620a3f0723c55e64", "620a3f0723c55e64"],
    ts: ["1787760243.492319", "1787760270.208519"],
  },
  {
    // The value is 0.285, and this row listed 0.125 until `--calibrate` read the
    // messages. The earlier value came from typed Chinese text used to approximate
    // the messages, recorded as a measurement of the pair. Two agents ran the
    // re-measurement on its first day, and both obtained 0.285 from Slack. This error
    // belongs to the same class as the synthetic pair cited as the founding incident,
    // which the tool caught this time.
    what: "two unrelated Chinese reports",
    measuredBy: "model-failure-research and scramble-dev, from a second agent's sends",
    source: "measured",
    scale: "content",
    score: 0.285,
    label: "wanted",
    channel: "scramble-dev",
    sha: ["f995dff9196a2f74", "b8fc8afb84d80606"],
    ts: ["1787722977.171239", "1787723056.620949"],
  },
];

/**
 *  This section shows which labelled pairs a pair of thresholds misclassifies,
 *  separating real rows from hand-made rows.
 *
 *  A synthetic pair does not decide a threshold. A hand-written pair determined a
 *  threshold for an hour after receiving a score of 0.833 as the founding incident,
 *  and two agents built threshold arguments on that number before someone measured
 *  the real messages at 0.968. A `synthetic` row is one nobody sent.
 */
export function calibrationMisses(threshold: { content: number; short: number }): {
  real: string[];
  synthetic: string[];
} {
  const wrong = CALIBRATION.filter((c) => {
    // A scale-less row constrains both numbers, since either cut may be the one that
    // judges it.
    const cuts = c.scale === undefined ? [threshold.content, threshold.short] : [c.scale === "short" ? threshold.short : threshold.content];
    return cuts.some((cut) => (c.label === "duplicate" ? c.score < cut : c.score >= cut));
  }).map((c) => ({
    real: c.source === "measured",
    line: `${c.label} at ${c.score} on the ${c.scale ?? "unrecorded"} scale: ${c.what} (${c.measuredBy})`,
  }));
  return {
    real: wrong.filter((w) => w.real).map((w) => w.line),
    synthetic: wrong.filter((w) => !w.real).map((w) => w.line),
  };
}

/**
 *  The shorter draft must be comparable in size for containment to mean anything.
 *  Below this ratio, the pair is a fragment against a report.
 */
export const COMPARABLE_SIZE_RATIO = 0.5;

/**
 *  The score measures the share of the smaller set that both items share, from 0 to
 *  1.
 *
 *  The system uses containment after testing intersection over union first. A
 *  rewording that adds a sentence drops a union-based score quickly: the test pair
 *  that prompted this change measured 0.50 under that metric, which no usable
 *  threshold catches. A duplicate guard checks whether the new draft repeats what
 *  the old draft stated, and containment measures that overlap.
 *
 *  Containment alone treats a short follow-up as a full repetition. In one test, an
 *  agent evaluated an 8-word note whose every word appeared in a 22-word report.
 *  That pair produced a containment score of 1.000 and a size ratio of 0.36, so the
 *  guard would have rejected a valid addendum. The reworded retry that this guard
 *  exists for measured a size ratio of 0.80. Below that ratio, the score falls back
 *  to the share of the larger set, which measures 0.36 for that fragment pair.
 */
export function wordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(a);
  let shared = 0;
  for (const w of new Set(b)) if (set.has(w)) shared += 1;
  const smaller = Math.min(new Set(a).size, new Set(b).size);
  const larger = Math.max(new Set(a).size, new Set(b).size);
  if (smaller === 0 || larger === 0) return 0;
  return smaller / larger >= COMPARABLE_SIZE_RATIO ? shared / smaller : shared / larger;
}

function rawSentLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  } catch {
    return [];
  }
}

export function readSentRows(path: string): SentRow[] {
  return rawSentLines(path).map((l) => {
    if (!l.startsWith("{")) return { ts: l };
    try {
      const row = JSON.parse(l) as SentRow;
      return typeof row.ts === "string" ? row : { ts: "" };
    } catch {
      return { ts: "" };
    }
  });
}

export function readSent(path: string): string[] {
  return readSentRows(path)
    .map((r) => r.ts)
    .filter((t) => t !== "");
}

export function recordSent(
  path: string,
  ts: string,
  draft?: { hash: string; channel: string; at: string; words?: string[] },
): void {
  const line = draft === undefined ? ts : JSON.stringify({ ts, ...draft });
  const kept = [...rawSentLines(path), line].slice(-500);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${kept.join("\n")}\n`);
}

/** Record that a message this agent sent has been deleted from the channel.
 *
 *  The row keeps every field it had and gains the time of the delete, so the record
 *  of what was sent stays whole while the duplicate guards stop counting a line the
 *  channel no longer holds. Returns whether a row matched, which the caller prints:
 *  a delete whose row is already gone from the 500-row window is a fact the agent
 *  needs, since their resend can still be refused for a different reason. */
export function markSentDeleted(path: string, ts: string, at: string): boolean {
  const rows = readSentRows(path);
  let found = false;
  for (const r of rows) {
    if (r.ts === ts && r.deleted === undefined) {
      r.deleted = at;
      found = true;
    }
  }
  if (!found) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return true;
}

/**
 *  The timestamp of a send of this same draft into this same channel inside the
 *  window, or undefined.
 *
 *  A retry after a genuine post must be a no-op, for example by setting an
 *  idempotency key on the draft hash. Two byte-identical copies 27 seconds apart
 *  reached a third agent's inbox after the `posted:` line had already shipped, so
 *  the sender still had a reason to send twice and the tool still let them.
 */
export function sentAlready(
  rows: SentRow[],
  channel: string,
  hash: string,
  nowMs: number,
  windowMs: number,
): SentRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    // A row for a message that was deleted names nothing the channel still holds.
    if (r.deleted !== undefined) continue;
    if (r.hash !== hash || r.channel !== channel || r.at === undefined) continue;
    const at = Date.parse(r.at);
    if (Number.isFinite(at) && nowMs - at <= windowMs) return r;
  }
  return undefined;
}

/**
 *  The system records any draft that this agent already sent to this channel under
 *  different wording inside the window, along with the fraction that repeats.
 *
 *  A digest misses duplicate messages that restate the same information in
 *  different words. For example, an agent reported one end-to-end run twice, 127
 *  seconds apart, naming the same ports and the same three images across different
 *  sentences. That run produced a 0.970 word overlap, and the digest passed the
 *  duplicate because no two bytes lined up. The reader of the channel cannot tell
 *  that from a resend.
 *
 *  The check sorts entries newest first, so the refusal names the closest thing the
 *  sender said.
 *
 *  A short draft never qualifies as a near-duplicate. Containment calculations over
 *  a handful of words reach 1.0 on two unrelated one-liners. For instance,
 *  `the line as drafted` and `a second line, drafted separately` share both their
 *  content words, and this check refused the second one in the suite. Below the
 *  floor, the digest is the only guard, which is the right trade for a message
 *  somebody can reread in a second.
 */
export const NEAR_DUPLICATE_FLOOR = 8;

/**
 *  The system scores a short pair across its entire token set, and does so only
 *  while the two drafts are close in size.
 */
export const SHORT_SIZE_RATIO = 0.75;

/**
 *  The system records the score for one pair and identifies the scale that
 *  produced it.
 *
 *  The system selects between two scales by text length. It scores a report on
 *  content words, which drops grammatical variations introduced by rewording.
 *  A one-line status contains too few content words for that method. A duplicate
 *  that two agents confirmed held 6 and 5 content words and was never scored,
 *  while the debate ran on a threshold that never applied to it. The system scores
 *  short drafts on every token with a tighter size requirement, since containment
 *  over a handful of words reaches 1.0 on an addendum.
 */
export function pairScore(
  aTokens: string[],
  bTokens: string[],
): { overlap: number; scale: "content" | "short" } {
  const aContent = contentOf(aTokens);
  const bContent = contentOf(bTokens);
  if (aContent.length >= NEAR_DUPLICATE_FLOOR && bContent.length >= NEAR_DUPLICATE_FLOOR) {
    return { overlap: wordOverlap(aContent, bContent), scale: "content" };
  }
  const smaller = Math.min(aTokens.length, bTokens.length);
  const larger = Math.max(aTokens.length, bTokens.length);
  if (smaller === 0) return { overlap: 0, scale: "short" };
  const set = new Set(aTokens);
  let shared = 0;
  for (const w of new Set(bTokens)) if (set.has(w)) shared += 1;
  return {
    overlap: smaller / larger >= SHORT_SIZE_RATIO ? shared / smaller : shared / larger,
    scale: "short",
  };
}

export function closestSaid(
  rows: SentRow[],
  channel: string,
  words: string[],
  nowMs: number,
  windowMs: number,
): { row: SentRow; overlap: number; scale: "content" | "short" } | undefined {
  let best: { row: SentRow; overlap: number; scale: "content" | "short" } | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.deleted !== undefined) continue;
    if (r.channel !== channel || r.at === undefined || r.words === undefined) continue;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || nowMs - at > windowMs) continue;
    const scored = pairScore(words, r.words);
    if (best === undefined || scored.overlap > best.overlap) best = { row: r, ...scored };
  }
  return best;
}

/**
 *  When it crosses the threshold, the send prints the refusal from the closest
 *  earlier draft.
 */
export function saidAlready(
  rows: SentRow[],
  channel: string,
  words: string[],
  nowMs: number,
  windowMs: number,
  threshold: { content: number; short: number },
): { row: SentRow; overlap: number; scale: "content" | "short" } | undefined {
  const best = closestSaid(rows, channel, words, nowMs, windowMs);
  if (best === undefined) return undefined;
  return best.overlap >= (best.scale === "short" ? threshold.short : threshold.content) ? best : undefined;
}

/**
 *  Threshold data should come from measuring every send against the closest
 *  statement that the agent has already produced.
 *
 *  The number in use rests on corpus runs that three agents performed by hand,
 *  and the CJK side rests on two synthetic pairs that disagree by a factor of
 *  two. An agent who writes English by the operator's rule cannot produce
 *  Chinese samples on request, and the tool can gather them. Every send records
 *  what it measured, and this tool reads the recorded data back.
 */
export function nearReport(rows: SentRow[], threshold: number): string {
  const scored = rows.filter((r): r is SentRow & { near: { score: number; ts: string } } => r.near !== undefined);
  if (scored.length === 0) {
    return (
      `No send on this host has measured itself against an earlier draft yet. A row is written per ` +
      `send once one earlier draft sits in the same channel inside the window, so an empty answer ` +
      `means every send so far was the first thing said in its channel.`
    );
  }
  const bands = [0, 0.2, 0.4, 0.6, 0.8, 1.01];
  const lines: string[] = [];
  for (let i = 0; i + 1 < bands.length; i += 1) {
    const lo = bands[i]!;
    const hi = bands[i + 1]!;
    const n = scored.filter((r) => r.near.score >= lo && r.near.score < hi).length;
    lines.push(`  ${lo.toFixed(1)} to ${Math.min(hi, 1).toFixed(1)}  ${n}`);
  }
  const top = [...scored].sort((a, b) => b.near.score - a.near.score).slice(0, 5);
  // This section analyzes the two classes separately. Every row here represents a
  // message that went out, so the plain rows form the negative class by
  // construction. The `--again` rows record refusals that their author overruled,
  // which serve as the labelled false positives and provide the only field evidence
  // that the threshold sits too low.
  const overridden = scored.filter((r) => r.near.again === true);
  return (
    `near: ${scored.length} send(s) measured against an earlier draft, refused at ${threshold}:\n` +
    `${lines.join("\n")}\n` +
    `The closest five, each one a message that WENT OUT:\n` +
    `${top.map((r) => `  ${r.near.score.toFixed(3)}  ts ${r.ts} against ${r.near.ts} in ${r.channel ?? "?"}`).join("\n")}\n` +
    (overridden.length === 0
      ? `No send here used --again, so every row is a message nobody had to argue with: the negative ` +
        `class. A refusal the author overrules would appear here as the labelled false positive.`
      : `${overridden.length} send(s) went out under --again, each one a refusal the author overruled:\n` +
        `${overridden
          .map((r) => `  ${r.near.score.toFixed(3)}  ts ${r.ts} against ${r.near.ts}`)
          .join("\n")}\n` +
        `Those are the labelled false positives, and they are what moves the threshold.`)
  );
}

/**
 *  The system turns a delivered line into an item only when another user addresses
 *  that line to this agent.
 *
 *  Delivery and obligation remain distinct concerns. A message in a thread that
 *  includes this agent arrives with `mentioned:true`, which ensures that replies
 *  within an active thread reach the participant. The agent does not automatically
 *  hold the responsibility to answer. In one instance, a peer wrote
 *  "@alignment_benchmark there is a concrete overlap" inside a thread this agent
 *  had joined, and `inbox pending` indicated a pending response for a question
 *  directed to another recipient. A list that presents tasks belonging to others
 *  teaches users to ignore notifications, which degrades the entire mechanism.
 *
 *  An incoming line therefore qualifies if it names this agent or names nobody.
 *  When a line addresses other agents without mentioning this one, another agent
 *  must answer it, regardless of its visibility.
 *
 *  The property `names` defines the identities of this agent, containing both its
 *  scramble name and its Slack handle, because mentions resolve to the Slack handle
 *  and the two values differ.
 */
export function isAddressed(
  d: { mentioned?: unknown; from?: unknown; mentions?: unknown; thread?: unknown },
  names: string[],
  ownSent: string[] = [],
): boolean {
  if (d.mentioned !== true || typeof d.from !== "string") return false;
  if (names.includes(d.from)) return false;
  const mentions = Array.isArray(d.mentions) ? d.mentions.filter((m): m is string => typeof m === "string") : [];
  // A broadcast names no individual recipient and addresses everyone. Without this
  // definition, the addressing rule below reads `@channel` as another recipient's
  // name and drops it, so the operator's "<!channel> ..." would reach no agent's
  // ledger even once delivery carries it.
  if (mentions.some((m) => BROADCAST_NAMES.includes(m))) return true;
  if (mentions.some((m) => names.includes(m))) return true;
  // A reply to a message from this agent is directed to this agent when the reply
  // names nobody. The operator answered a question from this agent with one word,
  // "limit", naming nobody in a reply to the agent's message, and Slack threading is
  // why such a reply carries no name.
  //
  // A reply that names another agent answers that agent, while this agent's thread
  // is where the conversation happens to sit. Under the rule that captured every
  // reply in the thread regardless of whom it named, one thread of two agents
  // working through a defect opened nine items in this agent's ledger inside twelve
  // minutes, and every item was a message between the two of them. Nine debts this
  // agent did not owe cost the list its meaning, which is the same harm the
  // 18-message case below names.
  if (mentions.length === 0 && typeof d.thread === "string" && ownSent.includes(d.thread)) return true;
  // A message that names nobody in someone else's thread does not create an
  // obligation. The rule assigned work if a message named the recipient or named
  // nobody. Measured across one afternoon, that rule placed 18 messages from another
  // team's task thread into a recipient's list, with none of them intended for that
  // recipient, while every message that was intended for them named them or answered
  // something they said. An agent learns to scroll past a list of other people's
  // questions, which ruins the whole mechanism.
  //
  // The system still delivers such a line, and the line still appears in a drain.
  // The line no longer constitutes a debt.
  if (mentions.length === 0) return typeof d.thread !== "string" || d.thread === "";
  return false;
}

