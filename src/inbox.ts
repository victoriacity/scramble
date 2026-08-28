// THE INBOX LEDGER: one row per addressed line handed to this agent, and whether
// anything has been said back.
//
// The operator: "how do you 100% ensure that you guarantee to reply when you
// are addressed? Each of your inbox item must be addressed by at least 1
// reply."
//
// The check that existed was per TURN, where a turn woken by someone addressing
// this agent had to send something before it ended, and a turn boundary is not an
// item boundary. Two items arriving together were satisfied by one reply. An item
// arriving after the turn had already sent something was satisfied by that
// earlier send. Counting items requires recording items.
//
// It is written by the DELIVERY path, so an item is open the moment it is handed
// over, and closed by the SEND path, so a reply closes it without anyone deciding
// that it counts. Neither end asks an agent to remember anything.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "./filelock";
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
  /** The names the delivery carried, so `inbox trace` can say WHY a row is
   * this agent's. Without it the ledger records the verdict and drops the
   * evidence, and two agents spent a round guessing which mention opened six
   * items. Absent on rows written before this field. */
  mentions?: string[];
  /** Was this line ADDRESSED to this agent, and so did it owe an answer?
   *
   *  Every delivered line is recorded, addressed or not, because "did this reach
   *  me" and "did this wake me" are different questions and the ledger is the
   *  only place that can answer both. Only `addressed` rows appear in `pending`.
   *
   *  ABSENT MEANS TRUE: every row written before this field existed was an
   *  addressed item, since nothing else was recorded then. */
  addressed?: boolean;
  /** The Slack app id this line was delivered TO.
   *
   * The ledger is keyed by agent NAME, and a name can be repointed at a
   * different Slack app. `xingyu-bot` pointed at one app for an hour and then
   * got its own, and its ledger holds 14 rows from a channel the current app
   * has never been in: two identities in one corpus, reported under one name.
   * Stamping the app makes the seam visible to whoever reads the file. */
  app?: string;
}

/** Did this row oblige an answer? Absent means yes, for rows predating the field. */
function owesAnswer(r: InboxItem): boolean {
  return r.addressed !== false;
}

export function inboxPath(configPath: string, agent: string): string {
  return join(dirname(configPath), "inbox", `${agent}.jsonl`);
}

/** Every row, oldest first. A malformed line is SKIPPED: a half-written row
 *  from a killed process must not take the whole ledger down,
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
  // The dedup READ and the append are one step: two processes delivering the
  // same message at once would both read no row and both append.
  withFileLock(path, () => {
    const existing = readInbox(path);
    if (existing.some((r) => r.id === item.id && r.channel === item.channel)) return;
    appendFileSync(path, `${JSON.stringify(item)}\n`);
  });
}

/** Close every open item a reply answers, recorded before the reply.
 *
 *  A CHANNEL-LEVEL reply closes channel items, because an answer given in the
 *  room answers what the room asked. A THREADED reply closes that thread's
 *  items, including one the ledger recorded against the channel whose own ts is
 *  the thread root.
 *
 * A threaded reply does NOT close the room. It used to, and it cost a real
 * question: xingyubot asked me something at channel level, I answered a
 * different agent inside a thread half a minute later, and the ledger marked
 * their question answered by that reply. They were left waiting with nothing on
 * my list (ts 1787664642.769859 closed by 1787664661.695049). The comment here
 * used to call the looser direction a missed nag. The cost is a dropped
 * question, and the person who asked it never learns that. */
export function closeInboxItems(path: string, channel: string, replyId: string, thread?: string): number {
  return withFileLock(path, () => closeInsideLock(path, channel, replyId, thread));
}

/** MEASURED: eight processes each closing one item left TWO still open, because
 * every close read the whole ledger, changed what it read, and wrote it back. A
 * lost close nags an agent about a question it has answered, which is how an
 * agent learns to stop reading its own list. */
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

/** Close ONE open item by id, with a reason, without sending anything.
 *
 * A sender can say a message needs no reply, and the ledger had no way to hear
 * it: `pending` kept the item open, a reaction did not clear it, and only a
 * real send did. So an agent clearing its ledger answers a message whose sender
 * asked it not to, and the mechanism built to stop people being left waiting
 * starts manufacturing noise (reported by xingyubot, with its own message as
 * the example).
 *
 *  THE REASON IS REQUIRED AND STORED. A close is the agent deciding an obligation
 *  is settled, which a reply never is, so the decision goes on the record where
 *  `trace` and the file itself will show it. Returns what happened, so the caller
 *  can tell "no such item" from "already answered".
 *
 *  Not a sender-side flag: that would have to ride in the message TEXT, and a
 *  marker parsed out of prose is the bare-pattern defect this repo spent the day
 *  removing. A reaction closing the item needs `reactions:read` and the
 *  `reaction_added` event, which no agent subscribes to yet. */
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
 * Four agents on four hosts spent a day answering "did that message reach me?"
 * by grepping a `tee` of the listener, and every hand-rolled version was wrong
 * in one of four ways, each measured by the agent who ran it:
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
export function traceReport(rows: InboxItem[], id: string, agent: string, path: string, app?: string): string {
  // COUNTED BY WHAT THE ROW CARRIES. The first version
  // printed "88 of them addressed to this agent" for a file where 88 rows carry
  // no `addressed` field at all, because the back-compat rule that keeps old
  // items in `pending` was reused as a measurement. The agent who read it: "the
  // count is inferred from a missing field and printed as though measured."
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
    // AN ABSENCE OVER BLIND ROWS PROVES NOTHING, and saying "NOT delivered" over
    // them is the exact failure this command exists to kill. Those rows were
    // written when only ADDRESSED lines were recorded, so an unaddressed
    // delivery in that span was never written and is absent here in the same way
    // a message that never arrived is absent. A broadcast is that case.
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
    // WHY IT IS THIS AGENT'S, from the names the delivery carried. The verdict
    // alone sent two agents guessing which mention opened six items, and one
    // guess reached the channel as a cause.
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

/** The ts values of messages THIS agent has sent, so a reply to one of them is
 *  recognised as an answer owed to this agent.
 *
 *  Capped: the file keeps the newest 500, which is far more than any thread this
 *  agent is still being replied in, and stops a long-running listener growing a
 *  file forever. */
export function sentPath(configPath: string, agent: string): string {
  return join(dirname(configPath), "sent", `${agent}.jsonl`);
}

/** One send by this agent. Rows written before this shape are a bare ts, and
 *  they read as a row with no draft on it. */
export interface SentRow {
  ts: string;
  /** Digest of the text the AUTHOR typed, before the rewriter touched it. The
   *  rewrite of one draft differs run to run, so the draft is the part that
   *  repeats when somebody sends the same thing twice. */
  hash?: string;
  channel?: string;
  at?: string;
  /** The draft's content words, which is what a REWORDED retry keeps.
   *
   *  A digest catches a byte-identical resend and nothing else. An agent sent one
   *  end-to-end run twice, 127 seconds apart, at 0.970 word overlap: the second
   *  draft named the same ports and the same three images in different sentences,
   *  and the digest guard passed it. */
  words?: string[];
  /** How much this draft shared with the closest thing this agent had already
   *  sent to the same channel inside the window, and which ts that was.
   *
   *  THE TOOL COLLECTS ITS OWN CALIBRATION DATA. The threshold rests on three
   *  agents' one-off corpus runs, and the CJK number rests on two synthetic
   *  pairs that disagree by a factor of two. An agent who writes English by the
   *  operator's rule cannot produce Chinese samples on request, and they said the
   *  tool can gather them: every send now records what it measured, so the
   *  distribution accumulates in the field for whoever tunes the number. */
  near?: { score: number; ts: string; again?: boolean };
}

/** The content words of a draft, lowercased, deduplicated and sorted.
 *
 *  Short words carry the grammar a rewording changes, so they are dropped: what
 *  survives is what the message is ABOUT, which is what a retry repeats. Fenced
 *  blocks stay in, since an evidence table is the part a retry copies verbatim. */
/** Every token a draft carries, deduplicated and sorted: words of any length,
 *  numbers, and CJK character bigrams.
 *
 *  THE SHORT DRAFTS NEED THE SHORT WORDS. `contentWords` drops tokens under four
 *  characters, which is right for a report and wrong for a one-line status: the
 *  real duplicate two agents confirmed, one line sent twice 127 seconds apart,
 *  held 6 and 5 content words and never reached the scorer at all. The full set
 *  is what a short pair is compared on. */
export function allWords(text: string): string[] {
  // CJK TEXT CARRIES NO SPACES, so a word filter written for ASCII reduced a
  // Chinese message to its identifiers: 166 Chinese characters left 20 tokens,
  // every one of them a number or a path. Two unrelated Chinese reports then
  // scored 0.500 on shared shas alone. CHARACTER BIGRAMS stand in for
  // segmentation: no dictionary, and a shared phrase shows up as shared bigrams.
  // A run of one character keeps the character.
  //
  // EDGE PUNCTUATION IS NOT PART OF A WORD, and an inner dot or slash is: a path
  // and a version number survive whole. Without that, `fallback.` at the end of a
  // sentence counted as a different word from `fallback`.
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

/** The subset of a token list that carries the message's subject: four characters
 *  or more, or anything holding a digit. */
export function contentOf(words: string[]): string[] {
  // A CJK BIGRAM IS CONTENT, whatever its length. This filter kept tokens of four
  // characters or more, so deriving the content words from the full token set
  // dropped every bigram and put a Chinese message back to its identifiers: the
  // defect an agent had reported an hour earlier, reintroduced by a refactor and
  // caught by the test written for it.
  const cjk = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
  return words.filter((w) => w.length >= 4 || /[0-9]/.test(w) || cjk.test(w));
}

export function contentWords(text: string): string[] {
  // ONE TOKENIZER, ONE FILTER. This held its own copy of the tokenizer for an
  // hour after `allWords` arrived, which is two places to fix the day a script or
  // a punctuation rule changes. The coverage gate found the copy: its CJK branch
  // was unreached, since every CJK test went through the other one.
  return contentOf(allWords(text));
}

/** THE LABELLED PAIRS THE THRESHOLDS COME FROM, with who measured each one.
 *
 *  I cited a synthetic pair of my own as the founding incident's score, and the
 *  agent I quoted had to correct me: the real pair belonged to a third agent and
 *  scored on the other scale. A claim about a labelled pair now reads from this
 *  table.
 *
 *  `ts` is empty where the pair is synthetic, which is what makes a synthetic
 *  pair impossible to cite as a real one. */
export const CALIBRATION: Array<{
  what: string;
  measuredBy: string;
  /** Which of the two cuts the pair is judged against, when somebody measured it.
   *
   *  A ROW WITHOUT ONE IS JUDGED AT BOTH. Three byte-identical pairs arrived from
   *  another agent's log as a channel, two timestamps, a score and a hash, with no
   *  scale, and half of each pair is deleted from Slack so nothing here can derive
   *  it. Writing "content" in that gap would record a measurement nobody took,
   *  which is the error this table exists to stop. */
  scale?: "content" | "short";
  score: number;
  label: "duplicate" | "wanted";
  /** The channel the two messages were sent in. A ts is unique inside one
   *  conversation, so a row without it can only be re-measured by guessing where
   *  to look, and `--calibrate` cannot tell "this agent is not in that channel"
   *  apart from "Slack has no such message". */
  channel?: string;
  /** `measured` means the pair is two messages somebody sent. `synthetic` means
   *  somebody wrote it by hand, and it decides no threshold.
   *
   *  THIS WAS `ts` PRESENCE FIRST, and that read a corpus measurement with no
   *  recorded ts as hand-made: the install report at 0.800 came out of another
   *  agent's real sends and counted as synthetic. Provenance is its own field. */
  source: "measured" | "synthetic";
  /** The thread root each message sits under, when it is a reply.
   *
   *  `conversations.history` OMITS THREAD REPLIES. The install pair is two replies
   *  under two different roots, so a read of the channel's history answered "no
   *  such message" for messages that are there. One page of 100 roots in that
   *  channel hides 219 replies behind 43 of them. */
  threads?: [string, string];
  /** The messages no longer exist. The first message of the 0.968 pair was
   *  deleted after the duplicate report that named it, so that row can never be
   *  re-measured: it stands on the reading taken while both messages lived. */
  gone?: true;
  /** sha256 of each message's DELIVERED PAYLOAD TEXT, first 16 hex, as recorded
   *  by the agent who measured the pair.
   *
   *  THE LISTENERS ARE THE ARCHIVE. Slack has already lost four of the five
   *  source messages behind these rows: one was deleted after the report that
   *  named it, four more went in a morning's cleanup. Every listener writes each
   *  delivery to disk before any of that, and nothing prunes a wake file, so an
   *  agent holding the text can confirm it is the same text.
   *
   *  `--calibrate` does NOT compare these. It reads the message back through
   *  `storedMessage`, which renders entities and undoes Slack's escapes, so its
   *  text hashes differently from the payload these values came from. Comparing
   *  the two forms would report a mismatch on every row. */
  sha?: [string, string];
  ts?: [string, string];
}> = [
  {
    // I MEASURED THE EXCERPT AND CALLED IT THE MESSAGE. The quoted lines in the
    // report that named this pair are one-line summaries; the messages hold 93
    // and 96 content words and score on the content scale. My reading of 6 and 5
    // words came from the quotes, and I concluded the guard never scored the pair.
    // The agent who found it called these functions directly and corrected me.
    what: "one test pass reported twice, 127 seconds apart, 93 and 96 content words",
    measuredBy: "model-failure-research, from peer-auto-evals's sends",
    source: "measured",
    scale: "content",
    score: 0.968,
    label: "duplicate",
    channel: "scramble-partner-dev",
    gone: true,
    sha: ["cf58e1ca70538915", "7f6bf4854b7834b6"],
    // THE FIRST MESSAGE IS GONE FROM SLACK. An agent read the span around it and
    // found 35 lines with that ts absent while its neighbour is present, so this
    // row can never be re-measured: the 0.968 stands on their reading of it while
    // it existed.
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
    // SYNTHETIC, and it carries no ts for that reason. I cited it as the founding
    // incident's score, and two agents built threshold arguments on that number
    // before the real pair was measured at 0.968.
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
    // BYTE-IDENTICAL, WHICH THE SCORE ALONE CANNOT SHOW. A 1.000 and a heavy
    // reword that happens to share every content word read the same in this
    // column; the two hashes being equal is what separates them. Half of each
    // pair was deleted by its sender after the duplicate report, so these rows
    // stand on the log of the agent who read them and carry no scale.
    what: "one report sent twice unchanged, 22 seconds apart",
    measuredBy: "model-failure-research, from peer-metrics's sends",
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
    measuredBy: "model-failure-research, from peer-metrics's sends",
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
    measuredBy: "model-failure-research, from peer-metrics's sends",
    source: "measured",
    score: 1,
    label: "duplicate",
    channel: "scramble-dev",
    gone: true,
    sha: ["620a3f0723c55e64", "620a3f0723c55e64"],
    ts: ["1787760243.492319", "1787760270.208519"],
  },
  {
    // 0.285, AND THIS ROW SAID 0.125 UNTIL `--calibrate` READ THE MESSAGES. My
    // number came from Chinese text I typed to approximate them, recorded as a
    // measurement of the pair. Two agents ran the re-measure on its first day and
    // both got 0.285 from Slack. The same error class as the synthetic pair I
    // cited as the founding incident, caught this time by the tool.
    what: "two unrelated Chinese reports",
    measuredBy: "model-failure-research and scramble-dev, from peer-metrics's sends",
    source: "measured",
    scale: "content",
    score: 0.285,
    label: "wanted",
    channel: "scramble-dev",
    sha: ["f995dff9196a2f74", "b8fc8afb84d80606"],
    ts: ["1787722977.171239", "1787723056.620949"],
  },
];

/** Which labelled pairs a pair of thresholds gets wrong, REAL rows apart from
 *  hand-made ones.
 *
 *  A SYNTHETIC PAIR DOES NOT DECIDE A THRESHOLD. Mine did for an hour: I wrote a
 *  pair by hand, scored it 0.833, cited it as the founding incident, and two
 *  agents built threshold arguments on that number before anybody measured the
 *  real messages at 0.968. A `synthetic` row is one nobody sent. */
export function calibrationMisses(threshold: { content: number; short: number }): {
  real: string[];
  synthetic: string[];
} {
  const wrong = CALIBRATION.filter((c) => {
    // A SCALE-LESS ROW CONSTRAINS BOTH NUMBERS, since either cut may be the one
    // that judges it.
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

/** THE SHORTER DRAFT MUST BE COMPARABLE IN SIZE for containment to mean
 *  anything: below this ratio the pair is a fragment against a report. */
export const COMPARABLE_SIZE_RATIO = 0.5;

/** How much of the SMALLER set the two share, 0 to 1.
 *
 *  CONTAINMENT, and union-over-intersection was tried first. A rewording that
 *  adds a sentence drops a union-based score fast: the pair that prompted this
 *  measured 0.50 that way, which no usable threshold catches. The question a
 *  duplicate guard asks is whether the new draft SAYS WHAT THE OLD ONE SAID, and
 *  that is containment.
 *
 *  A SHORT FOLLOW-UP IS NOT A RE-TELLING, and containment alone called it one. An
 *  agent measured an 8-word note whose every word appeared in a 22-word report:
 *  containment 1.000, size ratio 0.36, and the guard would have refused a
 *  legitimate addendum. The reworded retry that this guard exists for measured a
 *  ratio of 0.80. Below the ratio the score falls back to the share of the LARGER
 *  set, which is what the fragment is: 0.36 for that pair. */
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

/** The ts of a send of this same draft into this same channel inside the window,
 *  or undefined.
 *
 * A RETRY AFTER A GENUINE POST MUST BE A NO-OP. Asked for in those terms by an
 * agent that posted a reply twice: "A retry after a genuine post must be a
 * no-op, for example by setting an idempotency key on the draft hash." Two
 * byte-identical copies 27 seconds apart reached a third agent's inbox after
 * the `posted:` line had already shipped, so the sender still had a reason to
 * send twice and the tool still let them. */
export function sentAlready(
  rows: SentRow[],
  channel: string,
  hash: string,
  nowMs: number,
  windowMs: number,
): SentRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.hash !== hash || r.channel !== channel || r.at === undefined) continue;
    const at = Date.parse(r.at);
    if (Number.isFinite(at) && nowMs - at <= windowMs) return r;
  }
  return undefined;
}

/** A draft this agent already sent to this channel under different wording,
 *  inside the window, with how much of it repeats.
 *
 *  THE SECOND TELLING OF ONE THING is the duplicate the digest misses. An agent
 *  reported one end-to-end run twice, 127 seconds apart, naming the same ports
 *  and the same three images in different sentences: 0.970 word overlap, and the
 *  digest passed it because no two bytes lined up. The reader of the channel
 *  cannot tell that from a resend.
 *
 *  Newest first, so the refusal names the closest thing the sender said.
 *
 *  A SHORT DRAFT IS NEVER A NEAR-DUPLICATE. Containment over a handful of words
 *  reaches 1.0 on two unrelated one-liners: `the line as drafted` and `a second
 *  line, drafted separately` share both their content words, and this refused the
 *  second one in the suite. Below the floor the digest is the only guard, which
 *  is the right trade for a message somebody can reread in a second. */
export const NEAR_DUPLICATE_FLOOR = 8;

/** A short pair is scored on its FULL token set, and only while the two drafts
 *  are close in size. */
export const SHORT_SIZE_RATIO = 0.75;

/** The score for one pair, and which scale it came from.
 *
 *  TWO SCALES, PICKED BY LENGTH. A report is scored on content words, which drops
 *  the grammar a rewording changes. A one-line status has too few content words
 *  for that: the real duplicate two agents confirmed held 6 and 5 of them and was
 *  never scored, while the debate ran on a threshold that never applied to it.
 *  Short drafts are scored on every token, with a tighter size requirement, since
 *  containment over a handful of words reaches 1.0 on an addendum. */
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
    if (r.channel !== channel || r.at === undefined || r.words === undefined) continue;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || nowMs - at > windowMs) continue;
    const scored = pairScore(words, r.words);
    if (best === undefined || scored.overlap > best.overlap) best = { row: r, ...scored };
  }
  return best;
}

/** The closest earlier draft when it crosses the threshold, which is the refusal
 *  the send prints. */
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

/** What every send measured against the closest thing that agent had already
 *  said, as the data a threshold should come from.
 *
 *  The number in use rests on corpus runs three agents did by hand, and the CJK
 *  side rests on two synthetic pairs that disagree by a factor of two. An agent
 *  who writes English by the operator's rule cannot produce Chinese samples on
 *  request, and they pointed out the tool can gather them. Every send records
 *  what it measured, and this reads the pile back. */
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
  // THE TWO CLASSES, SEPARATELY. Every row here is a message that went out, so
  // the plain rows are the negative class by construction. The `--again` rows are
  // refusals their author overruled, which is the labelled false positive and the
  // only field evidence that the threshold sits too low.
  const overridden = scored.filter((r) => r.near.again === true);
  return (
    `${scored.length} send(s) measured against an earlier draft, refused at ${threshold}:\n` +
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
  d: { mentioned?: unknown; from?: unknown; mentions?: unknown; thread?: unknown },
  names: string[],
  ownSent: string[] = [],
): boolean {
  if (d.mentioned !== true || typeof d.from !== "string") return false;
  if (names.includes(d.from)) return false;
  const mentions = Array.isArray(d.mentions) ? d.mentions.filter((m): m is string => typeof m === "string") : [];
  // A BROADCAST NAMES NO ONE AND ADDRESSES EVERYONE. Without this the
  // naming-nobody rule below reads `@channel` as somebody else's name and drops
  // it, so the operator's "<!channel> ..." would reach no agent's ledger even
  // once delivery carries it.
  if (mentions.some((m) => BROADCAST_NAMES.includes(m))) return true;
  if (mentions.some((m) => names.includes(m))) return true;
  // A REPLY TO SOMETHING THIS AGENT SAID is for this agent WHEN IT NAMES
  // NOBODY. The operator answered a question of mine with one word, "limit",
  // naming nobody, in a reply to my own message, and Slack threading is why
  // such a reply carries no name.
  //
  // A reply that names ANOTHER agent answers that agent, and my thread is where
  // the conversation happens to sit. The rule was "any reply in my thread,
  // whoever it names", and one thread of two agents working through a defect
  // opened nine items in my ledger inside twelve minutes, every one of them a
  // message between the two of them. Nine debts I did not owe cost the list its
  // meaning, which is the same harm the 18-message case below names.
  if (mentions.length === 0 && typeof d.thread === "string" && ownSent.includes(d.thread)) return true;
  // NAMING NOBODY IN SOMEONE ELSE'S THREAD IS NOT AN OBLIGATION. The rule was
  // "named here, or naming nobody", and measured against one afternoon it put 18
  // messages from another team's task thread into my list, none of them for me,
  // while every message that WAS for me named me or answered something I said.
  // A list of other people's questions is one an agent learns to scroll past,
  // which costs the whole mechanism.
  //
  // Such a line is still DELIVERED and still shows in a drain. What it stops
  // being is a debt.
  if (mentions.length === 0) return typeof d.thread !== "string" || d.thread === "";
  return false;
}
