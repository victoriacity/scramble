import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeAnsweredBefore,
  closeInboxItems,
  inboxPath,
  isAddressed,
  pendingInbox,
  pendingReport,
  closeItemById,
  closestSaid,
  nearReport,
  readInbox,
  readSent,
  readSentRows,
  COMPARABLE_SIZE_RATIO,
  allWords,
  CALIBRATION,
  calibrationMisses,
  contentOf,
  contentWords,
  NEAR_DUPLICATE_FLOOR,
  pairScore,
  saidAlready,
  markSentDeleted,
  reopenAnsweredBy,
  sentAlready,
  wordOverlap,
  recordSent,
  sentPath,
  recordInboxItem,
  traceReport,
  type InboxItem,
  type SentRow,
} from "../src/inbox";

const scratch = (): string => mkdtempSync(join(tmpdir(), "scramble-inbox-"));
const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: "1787359081.7",
  channel: "scramble-dev",
  from: "andrew",
  text: "why are stale bots created",
  at: "2026-08-22T09:00:00.000Z",
  ...over,
});

describe("the inbox ledger: one row per addressed line, one reply owed", () => {
  test("an addressed line is recorded OPEN and reported with what it said", () => {
    // Each inbox item must be addressed by at least 1 reply. The previous check
    // counted turns. Because a turn boundary differs from an item boundary, one reply
    // satisfied two items that arrived together.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item());
    expect(pendingInbox(p)).toHaveLength(1);
    const said = pendingReport(pendingInbox(p), "dev");
    expect(said).toContain("1 inbox item(s) addressed to dev with no reply");
    expect(said).toContain("why are stale bots created");
    expect(said).toContain("scramble-dev");
  });

  test("TWO items arriving together are NOT satisfied by one reply to one of them", () => {
    // The test states the exact gap in the per-turn check.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "1", channel: "alpha" }));
    recordInboxItem(p, item({ id: "2", channel: "beta" }));
    closeInboxItems(p, "alpha", "reply-1");
    const open = pendingInbox(p);
    expect(open.map((r) => r.id)).toEqual(["2"]);
  });

  test("a reply closes every open item in the channel it answers", () => {
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "1" }));
    recordInboxItem(p, item({ id: "2" }));
    expect(closeInboxItems(p, "scramble-dev", "reply-1")).toBe(2);
    expect(pendingInbox(p)).toHaveLength(0);
    // An item that is already answered remains answered. A later reply does not
    // close an item again, so the count of actions a reply performed is the count
    // of items it closed.
    recordInboxItem(p, item({ id: "3" }));
    expect(closeInboxItems(p, "scramble-dev", "reply-2")).toBe(1);
    expect(readInbox(p).map((r) => r.answeredBy)).toEqual(["reply-1", "reply-1", "reply-2"]);
  });

  test("a threaded reply closes the thread's item even from another channel name", () => {
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "child", thread: "root-1", channel: "alpha" }));
    recordInboxItem(p, item({ id: "root-1", channel: "alpha" }));
    expect(closeInboxItems(p, "elsewhere", "reply", "root-1")).toBe(2);
    expect(pendingInbox(p)).toHaveLength(0);
  });

  test("a threaded reply leaves a channel-level question open", () => {
    // When xingyubot posted a question at the channel level, the agent answered a
    // different agent inside a thread half a minute later, and the ledger marked the
    // original question answered by that reply (timestamp 1787664642.769859 closed by
    // 1787664661.695049). xingyubot waited with nothing remaining on the agent's list.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "asked-in-the-room" }));
    recordInboxItem(p, item({ id: "asked-in-the-thread", thread: "root-1" }));
    expect(closeInboxItems(p, "scramble-dev", "reply", "root-1")).toBe(1);
    expect(pendingInbox(p).map((r) => r.id)).toEqual(["asked-in-the-room"]);
    // An answer sent by the room itself still closes the room.
    expect(closeInboxItems(p, "scramble-dev", "reply-2")).toBe(1);
    expect(pendingInbox(p)).toHaveLength(0);
  });

  test("a message I already sent closes every OLDER question in that channel", () => {
    // Five questions answered hours before the ledger existed remained in `pending`
    // indefinitely, and an agent scrolls past a list that contains answered questions.
    // A reply is a reply whether or not it passed through this CLI.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "1787359081.749909", channel: "room" }));
    recordInboxItem(p, item({ id: "1787359443.824399", channel: "room" }));
    recordInboxItem(p, item({ id: "1787999999.000000", channel: "room" }));
    recordInboxItem(p, item({ id: "1787359081.749909", channel: "elsewhere" }));
    expect(closeAnsweredBefore(p, "room", "1787360000.000000")).toBe(2);
    expect(pendingInbox(p).map((r) => `${r.channel}:${r.id}`)).toEqual([
      "room:1787999999.000000",
      "elsewhere:1787359081.749909",
    ]);
    expect(readInbox(p)[0]!.answeredBy).toBe("own message 1787360000.000000");
  });

  test("timestamps compare as NUMBERS, so a width change does not reorder them", () => {
    // String comparison sorts "999.9" after "1787360000.0", which would leave an old
    // item open forever and close a new one by mistake.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "999.9", channel: "room" }));
    expect(closeAnsweredBefore(p, "room", "1787360000.000000")).toBe(1);
    // A non-numeric timestamp closes nothing and never throws.
    const q = join(scratch(), "inbox", "dev2.jsonl");
    recordInboxItem(q, item({ id: "1.0", channel: "room" }));
    expect(closeAnsweredBefore(q, "room", "not-a-ts")).toBe(0);
    expect(closeAnsweredBefore(q, "room", "0.5")).toBe(0);
    expect(pendingInbox(q)).toHaveLength(1);
  });

  test("the same message delivered twice is ONE item, per CHANNEL", () => {
    // Both a listener and a 15-minute sweep detect the same mention. Two rows would
    // require two replies for one question.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item());
    recordInboxItem(p, item());
    expect(readInbox(p)).toHaveLength(1);
    // A Slack timestamp (ts) is unique within a channel and carries no meaning
    // across channels, so the same timestamp elsewhere refers to a different
    // question.
    recordInboxItem(p, item({ channel: "elsewhere" }));
    expect(readInbox(p)).toHaveLength(2);
  });

  test("only lines ADDRESSED to this agent by someone else become items", () => {
    const me = ["dev", "dev_bot"];
    expect(isAddressed({ mentioned: true, from: "andrew", mentions: ["dev_bot"] }, me)).toBe(true);
    // A mention resolves to the handle, which differs from the scramble name.
    expect(isAddressed({ mentioned: true, from: "andrew", mentions: ["dev"] }, me)).toBe(true);
    // It appears on its own line under either identity, and there is never an
    // obligation to answer.
    expect(isAddressed({ mentioned: true, from: "dev" }, me)).toBe(false);
    expect(isAddressed({ mentioned: true, from: "dev_bot" }, me)).toBe(false);
    // Traffic that passes through the channel does not count as a question.
    expect(isAddressed({ mentioned: false, from: "andrew" }, me)).toBe(false);
    expect(isAddressed({ from: "andrew" }, me)).toBe(false);
  });

  test("a BROADCAST owes every agent a reply, though it names none of them", () => {
    // Without this, the "named here, or naming nobody" rule treats `@channel` as
    // another user's name and drops it, so a message meant for the whole room reaches
    // no ledger even once delivery carries it.
    const me = ["dev", "dev_bot"];
    for (const kind of ["channel", "here", "everyone"]) {
      expect(isAddressed({ mentioned: true, from: "andrew", mentions: [kind] }, me)).toBe(true);
    }
    // The agent still has no obligation when it handles its own broadcast.
    expect(isAddressed({ mentioned: true, from: "dev_bot", mentions: ["channel"] }, me)).toBe(false);
  });

  test("a question addressed to SOMEONE ELSE in my thread is not mine to answer", () => {
    // Message delivery differs from user obligation. When a peer posted
    // "@alignment_benchmark there is a concrete overlap" inside a thread containing
    // previous replies, the platform delivered the message with mentioned:true, so
    // `inbox pending` reported an active wait for a question addressed to another
    // recipient.
    const me = ["dev", "dev_bot"];
    expect(isAddressed({ mentioned: true, from: "peer", mentions: ["someone_else"] }, me)).toBe(false);
    // A message that names no recipient inside a thread belongs to the thread owner,
    // because that message is a bare reply.
    expect(isAddressed({ mentioned: true, from: "peer", mentions: [] }, me)).toBe(true);
    expect(isAddressed({ mentioned: true, from: "peer" }, me)).toBe(true);
    // This role also handles naming both entities.
    expect(isAddressed({ mentioned: true, from: "peer", mentions: ["someone_else", "dev_bot"] }, me)).toBe(true);
  });

  test("a half-written row does not take the whole ledger down", () => {
    // The ledger must be readable at the moment something fails, so a row truncated by
    // a killed process must cost that row and nothing else.
    const dir = scratch();
    const p = join(dir, "inbox", "dev.jsonl");
    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeFileSync(p, `${JSON.stringify(item({ id: "1" }))}\n{"id":"2","chan\n${JSON.stringify(item({ id: "3" }))}\n`);
    expect(readInbox(p).map((r) => r.id)).toEqual(["1", "3"]);
  });

  test("a missing ledger is empty, and reports nothing", () => {
    const p = join(scratch(), "inbox", "never-written.jsonl");
    expect(readInbox(p)).toEqual([]);
    expect(pendingInbox(p)).toEqual([]);
    expect(pendingReport([], "dev")).toBe("");
    // Closing against a ledger that does not exist is a no-op and prevents crashes on
    // the reply path. A message must go out even when the accounting cannot.
    expect(closeInboxItems(p, "scramble-dev", "reply")).toBe(0);
  });

  test("the ledger sits beside the config, one file per agent", () => {
    expect(inboxPath(join("cfgroot", "slack.json"), "scramble-dev")).toBe(
      join("cfgroot", "inbox", "scramble-dev.jsonl"),
    );
  });

  test("an unwritable ledger throws to the caller, which reports it", () => {
    // `emitDelivery` catches this and prints it, so an inbox that counts zero does
    // not read as an inbox with nothing in it.
    const dir = scratch();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    expect(() => recordInboxItem(join(locked, "inbox", "dev.jsonl"), item())).toThrow();
    chmodSync(locked, 0o700);
  });
});

describe("inbox trace: what happened to ONE message, without grepping a text log", () => {
  // Four agents on four hosts determined whether messages arrived by running
  // grep one-liners over a `tee` of the listener. Each agent measured live one of
  // the four ways this approach fails. Each test below examines one of those four
  // failure modes.

  test("a message QUOTING the id does not read as delivery of it", () => {
    // An agent searched its wake file for a broadcast timestamp and found a match,
    // which it read as proof that the broadcast arrived. The matching line was a peer
    // message quoting that timestamp in its text. Comparing the id field cannot make
    // that mistake.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "999.111", text: "the broadcast at 1787388201.288129 never woke me" }));
    const said = traceReport(readInbox(p), "1787388201.288129", "dev", p);
    expect(said).toContain("was NOT delivered to dev");
    expect(said).not.toContain("WAS delivered");
  });

  test("a correct absence names the corpus it searched, so it is not a bare False", () => {
    // A check without a positive control cannot distinguish a correct False from a
    // broken check. An agent's grep command returned zero and succeeded by luck,
    // because nobody had quoted the ts yet.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: true }));
    recordInboxItem(p, item({ id: "200.2", addressed: false }));
    const said = traceReport(readInbox(p), "300.3", "dev", p);
    expect(said).toContain("Searched 2 delivered row(s)");
    expect(said).toContain("ids 100.1 to 200.2");
    expect(said).toContain("1 addressed to this agent, 1 delivered without addressing it");
  });

  test("the corpus counts what the rows CARRY, and never infers a count", () => {
    // The first version printed "88 of them addressed to this agent" for a file where
    // no row carried the field, because the backward compatibility rule that keeps
    // old items in `pending` was reused as a measurement. The system inferred the
    // count from a missing field and printed it as though measured.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1" }));
    recordInboxItem(p, item({ id: "200.2" }));
    const said = traceReport(readInbox(p), "100.1", "dev", p);
    expect(said).toContain("0 addressed to this agent, 0 delivered without addressing it");
    expect(said).toContain("2 written before the ledger recorded unaddressed deliveries");
    // The row reports the field as unrecorded without inventing a value.
    expect(said).toContain("is UNRECORDED: this row predates that field");
  });

  test("an absence over rows that predate the field is REFUSED, not reported", () => {
    // The system wrote those rows when it recorded only ADDRESSED lines, so a
    // delivery that addressed nobody was never written and is missing exactly as a
    // message that never arrived is missing. A broadcast is that case, which is the
    // one thing anyone was tracing.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1" }));
    recordInboxItem(p, item({ id: "300.3" }));
    const said = traceReport(readInbox(p), "200.2", "dev", p);
    expect(said).toContain("was NOT delivered to dev");
    expect(said).toContain("THIS VERDICT IS UNSOUND FOR THIS ID");
    expect(said).toContain("100.1 to 300.3");
    expect(said).toContain("Read the channel for this one");
  });

  test("an absence NEWER than every such row stands, and says why", () => {
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1" }));
    recordInboxItem(p, item({ id: "300.3", addressed: true }));
    const said = traceReport(readInbox(p), "400.4", "dev", p);
    expect(said).toContain("was NOT delivered to dev");
    expect(said).toContain("end at 100.1, older than 400.4, so they do not touch this verdict");
    expect(said).not.toContain("UNSOUND");
  });

  test("rows delivered to a DIFFERENT app under the same name are named as such", () => {
    // The ledger keys records by agent name. An agent repointed its name to its own
    // Slack app after an hour on a shared Slack app, so its ledger contains 14 rows
    // from a channel that the current app has never entered. As a result, one corpus
    // from two identities is reported under one name.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", channel: "argo", app: "A0OLD", addressed: true }));
    recordInboxItem(p, item({ id: "300.3", app: "A0MINE", addressed: true }));
    const said = traceReport(readInbox(p), "300.3", "dev", p, "A0MINE");
    expect(said).toContain("1 row(s) here were delivered to app A0OLD");
    expect(said).toContain("NOT this agent's app A0MINE");
    expect(said).toContain("keyed by agent NAME");
    // When no application is known, the system makes no claims about identity.
    expect(traceReport(readInbox(p), "300.3", "dev", p)).not.toContain("were delivered to app");
  });

  test("an EMPTY ledger refuses to answer instead of reporting absence", () => {
    // A ledger that is not being written creates a dangerous condition because it
    // looks identical to a message that never arrived. This section states this
    // condition and directs the reader to doctor.
    const p = join(scratch(), "inbox", "dev.jsonl");
    const said = traceReport(readInbox(p), "300.3", "dev", p);
    expect(said).toContain("holds NO rows");
    expect(said).toContain("says nothing about the message");
    expect(said).toContain("scramble doctor");
  });

  test("a plain English diagnostic line in the ledger does not kill the check", () => {
    // The third failure is the worst. A check parses every line as JSON and fails on
    // any file that also contains "scramble doctor" messages and socket errors, so it
    // crashes exactly when the wake path is broken, which is the only occasion
    // anybody runs it.
    const dir = join(scratch(), "inbox");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1" }));
    writeFileSync(p, `${readInbox(p).map((r) => JSON.stringify(r)).join("\n")}\nlistener refused: socket closed\n`);
    const said = traceReport(readInbox(p), "100.1", "dev", p);
    expect(said).toContain("WAS delivered to dev");
  });

  test("DELIVERED and ADDRESSED are answered separately: the broadcast defect", () => {
    // `<!channel>` reached four agents and addressed none of them, so all four agents
    // saw the message during a 15-minute sweep and no agent woke. A ledger that
    // records only addressed lines cannot distinguish that event from a message that
    // never arrived.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: false, text: "@channel write English in files" }));
    const said = traceReport(readInbox(p), "100.1", "dev", p);
    expect(said).toContain("WAS delivered to dev");
    expect(said).toContain("NOT addressed to dev");
    expect(said).toContain("visible only to a sweep");
    expect(said).toContain("no reply recorded");
    // The unit owes no recipient an answer, so it remains out of pending.
    expect(pendingInbox(p)).toHaveLength(0);
  });

  test("an addressed row reports that it woke the agent, and what answered it", () => {
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: true }));
    closeInboxItems(p, "scramble-dev", "555.5");
    const said = traceReport(readInbox(p), "100.1", "dev", p);
    expect(said).toContain("ADDRESSED to dev, so it woke this agent");
    expect(said).toContain("answered by 555.5");
  });

  test("a trace says WHICH names the line carried", () => {
    // Because the verdict lacked its evidence, two agents guessed which mention
    // opened six items, and one guess reached the channel as a cause.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "1.1", addressed: true, mentions: ["dev", "ana"] }));
    recordInboxItem(p, item({ id: "2.2", addressed: false, mentions: [] }));
    const named = traceReport(readInbox(p), "1.1", "dev", p);
    expect(named).toContain("The line named @dev, @ana.");
    const nobody = traceReport(readInbox(p), "2.2", "dev", p);
    expect(nobody).toContain("The line named nobody");
    // A row created before the field existed makes no claim about names.
    const old = join(scratch(), "inbox", "old.jsonl");
    recordInboxItem(old, item({ id: "3.3", addressed: true }));
    expect(traceReport(readInbox(old), "3.3", "dev", old)).not.toContain("The line named");
  });

  test("a row written before the addressed field existed still owes a reply", () => {
    // Backward compatibility is critical because the ledger only ever recorded
    // addressed items, so a missing field means an item is addressed. Reading a
    // missing field as false would silently empty `pending` of every question asked
    // before today.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1" }));
    expect(pendingInbox(p)).toHaveLength(1);
    // The system keeps the obligation, and the trace still refuses to claim that it
    // woke anyone. Keeping an old question answerable differs from asserting what the
    // row recorded, and an observer can safely infer only the first fact.
    expect(traceReport(readInbox(p), "100.1", "dev", p)).toContain("is UNRECORDED");
  });

  test("a delivery-only row is never closed by a reply or by an own message", () => {
    // The operation is not an obligation, so nothing should mark it answered. A trace
    // of it must keep saying "nothing woke" however much traffic followed.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: false }));
    expect(closeInboxItems(p, "scramble-dev", "555.5")).toBe(0);
    expect(closeAnsweredBefore(p, "scramble-dev", "999.9")).toBe(0);
    expect(traceReport(readInbox(p), "100.1", "dev", p)).toContain("no reply recorded");
  });
});

describe("inbox close: an item the sender said needs no reply", () => {
  // When xingyubot posted "no need to reply to this one", `inbox pending` kept the
  // item open. A reaction did not clear the item, and only a real send resolved it.
  // So an agent clearing its ledger answers a message whose sender asked it not to,
  // and a mechanism built to stop people being left waiting starts manufacturing
  // noise.

  test("closing settles the item and records the reason on the row", () => {
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: true }));
    expect(closeItemById(p, "100.1", "sender said no reply needed")).toEqual({ ok: true });
    expect(pendingInbox(p)).toHaveLength(0);
    // The record preserves the decision. When an agent closes an obligation, the agent
    // decides that the obligation is settled. A reply never settles an obligation, so
    // the close must remain visible to anyone who reads the file or traces the id
    // later.
    const said = traceReport(readInbox(p), "100.1", "dev", p);
    expect(said).toContain("closed with no reply: sender said no reply needed");
  });

  test("an unknown id is a refusal, never a silent success", () => {
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: true }));
    expect(closeItemById(p, "999.9", "typo")).toEqual({ ok: false, why: "unknown" });
    expect(pendingInbox(p)).toHaveLength(1);
  });

  test("an already answered item reports what answered it", () => {
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: true }));
    closeInboxItems(p, "scramble-dev", "555.5");
    expect(closeItemById(p, "100.1", "again")).toEqual({ ok: false, why: "answered", answeredBy: "555.5" });
  });

  test("a delivery-only row is not an item, so there is nothing to close", () => {
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: false }));
    expect(closeItemById(p, "100.1", "why not")).toEqual({ ok: false, why: "unknown" });
  });
});

describe("what counts as owed, measured against one afternoon", () => {
  // The routing rule accepted messages that named the recipient or named nobody.
  // Over one afternoon, this rule placed 18 messages from another team's task
  // thread into the recipient's list, none of which were meant for that recipient,
  // while every message intended for the recipient either named them or answered
  // something they had said. An agent scrolls past a list of other people's
  // questions.

  test("a message naming nobody in someone else's thread is delivered, and owed to nobody", () => {
    const d = { mentioned: true, from: "teamassistant", mentions: [], thread: "root-of-their-task" };
    expect(isAddressed(d, ["dev"], ["9.9"])).toBe(false);
  });

  test("a reply naming nobody in this agent's own thread is owed to it", () => {
    // The operator responded to the question with the single word limit, naming
    // nobody in the reply to the message. A reply carries no name because Slack uses
    // threading.
    const d = { mentioned: true, from: "andrew", mentions: [], thread: "mine-1" };
    expect(isAddressed(d, ["dev"], ["mine-1"])).toBe(true);
    expect(isAddressed(d, ["dev"], ["someone-elses"])).toBe(false);
  });

  test("two peers answering EACH OTHER in this agent's thread owe it nothing", () => {
    // The previous rule captured every reply in my thread, regardless of the recipient
    // named. Two agents worked through a defect inside one of my threads and opened
    // nine items in my ledger in twelve minutes, where every item was a message
    // exchanged between the two agents. The reply identifies the agent it answers,
    // which designates a different agent.
    const between = { mentioned: true, from: "metrics_bot", mentions: ["model_failure_researc"], thread: "mine-1" };
    expect(isAddressed(between, ["dev", "dev_bot"], ["mine-1"])).toBe(false);
    // Listing the author among them keeps the debt owed.
    const alsoMe = { ...between, mentions: ["model_failure_researc", "dev_bot"] };
    expect(isAddressed(alsoMe, ["dev", "dev_bot"], ["mine-1"])).toBe(true);
    // A thread that broadcasts a message still receives its own broadcast.
    const shout = { ...between, mentions: ["channel"] };
    expect(isAddressed(shout, ["dev", "dev_bot"], ["mine-1"])).toBe(true);
  });

  test("a top-level line naming nobody is still owed: it is the room asking", () => {
    expect(isAddressed({ mentioned: true, from: "andrew", mentions: [] }, ["dev"])).toBe(true);
    expect(isAddressed({ mentioned: true, from: "andrew", mentions: [], thread: "" }, ["dev"])).toBe(true);
  });

  test("being named still counts inside anyone's thread", () => {
    const d = { mentioned: true, from: "andrew", mentions: ["dev"], thread: "their-root" };
    expect(isAddressed(d, ["dev"])).toBe(true);
  });

  test("a broadcast still reaches every agent, in a thread or out of one", () => {
    const d = { mentioned: true, from: "andrew", mentions: ["channel"], thread: "their-root" };
    expect(isAddressed(d, ["dev"])).toBe(true);
  });
});

describe("the record of what this agent said", () => {
  test("a sent ts is kept and read back", () => {
    const p = sentPath(join(scratch(), "slack.json"), "dev");
    recordSent(p, "1.1");
    recordSent(p, "2.2");
    expect(readSent(p)).toEqual(["1.1", "2.2"]);
  });

  test("a draft rides with the ts, and a repeat of it inside the window is found", () => {
    // A third agent's inbox received two byte-identical copies 27 seconds apart after
    // the `posted:` line shipped. A retry after a genuine post must be a no-op, for
    // example by setting an idempotency key on the draft hash.
    const p = sentPath(join(scratch(), "slack.json"), "dev");
    recordSent(p, "1.1");
    recordSent(p, "2.2", { hash: "abc", channel: "general", at: "2026-08-26T12:00:00Z" });
    // The timestamp list remains unchanged for all older readers.
    expect(readSent(p)).toEqual(["1.1", "2.2"]);
    const rows = readSentRows(p);
    expect(rows[0]).toEqual({ ts: "1.1" });
    expect(rows[1]?.hash).toBe("abc");
    const now = Date.parse("2026-08-26T12:05:00Z");
    expect(sentAlready(rows, "general", "abc", now, 10 * 60 * 1000)?.ts).toBe("2.2");
    // The system finds no match if the item appears in another channel, belongs to
    // another draft, or falls past the window.
    expect(sentAlready(rows, "other", "abc", now, 10 * 60 * 1000)).toBeUndefined();
    expect(sentAlready(rows, "general", "zzz", now, 10 * 60 * 1000)).toBeUndefined();
    expect(sentAlready(rows, "general", "abc", Date.parse("2026-08-26T13:00:00Z"), 10 * 60 * 1000)).toBeUndefined();
    // A row created before the field existed contains no draft, so it never matches.
    expect(sentAlready([{ ts: "1.1" }], "general", "abc", now, 10 * 60 * 1000)).toBeUndefined();
  });

  test("deleting an answer opens the question it answered", () => {
    // The same disagreement, one record over: a reply closes an item by naming its
    // timestamp, and deleting that reply left the item closed while the question was
    // still in the channel with nothing answering it.
    const p = inboxPath(join(scratch(), "slack.json"), "dev");
    recordInboxItem(p, {
      id: "5.5",
      channel: "general",
      from: "peer",
      text: "@dev what did the gate say",
      at: "2026-08-26T12:00:00Z",
      mentions: ["dev"],
      addressed: true,
    });
    expect(pendingInbox(p).map((r) => r.id)).toEqual(["5.5"]);
    expect(closeInboxItems(p, "general", "6.6")).toBe(1);
    expect(pendingInbox(p)).toEqual([]);

    // The answer leaves the channel, so the question is owed again and the delete
    // says which ones came back.
    expect(reopenAnsweredBy(p, "6.6")).toEqual(["5.5"]);
    expect(pendingInbox(p).map((r) => r.id)).toEqual(["5.5"]);
    // A timestamp that answered nothing reopens nothing.
    expect(reopenAnsweredBy(p, "9.9")).toEqual([]);
  });

  test("a message deleted from the channel stops being a duplicate of anything", () => {
    // An agent posted into the wrong thread, deleted the message, and their resend was
    // refused as a duplicate of the line they had just removed, naming a timestamp
    // Slack no longer held. The delete and the duplicate guard read one record, and
    // only one of them was writing to it.
    const p = sentPath(join(scratch(), "slack.json"), "dev");
    recordSent(p, "2.2", { hash: "abc", channel: "general", at: "2026-08-26T12:00:00Z", words: ["gate", "green", "again"] });
    const now = Date.parse("2026-08-26T12:05:00Z");
    expect(sentAlready(readSentRows(p), "general", "abc", now, 10 * 60 * 1000)?.ts).toBe("2.2");

    expect(markSentDeleted(p, "2.2", "2026-08-26T12:04:00Z")).toBe(true);
    const after = readSentRows(p);
    // THE ROW SURVIVES. The record of what was sent stays whole, and it now carries
    // when the message left the channel.
    expect(after[0]?.ts).toBe("2.2");
    expect(after[0]?.deleted).toBe("2026-08-26T12:04:00Z");
    expect(after[0]?.hash).toBe("abc");
    expect(sentAlready(after, "general", "abc", now, 10 * 60 * 1000)).toBeUndefined();
    // The near-duplicate reader skips it too: a reader cannot see a deleted message,
    // so a message that resembles it repeats nothing they have read.
    expect(closestSaid(after, "general", ["gate", "green", "again"], now, 10 * 60 * 1000)).toBeUndefined();

    // A SECOND DELETE OF THE SAME TS CHANGES NOTHING, and a delete of a timestamp the
    // window no longer holds says so, since the caller's resend can still be refused
    // for a different reason.
    expect(markSentDeleted(p, "2.2", "2026-08-26T12:06:00Z")).toBe(false);
    expect(readSentRows(p)[0]?.deleted).toBe("2026-08-26T12:04:00Z");
    expect(markSentDeleted(p, "9.9", "2026-08-26T12:06:00Z")).toBe(false);
  });

  test("THE SAME THING IN OTHER WORDS is refused, and a different report is not", () => {
    // An agent reported one end-to-end run twice, 127 seconds apart. The reports named
    // the same ports and the same three images in different sentences, producing 0.970
    // word overlap, and the digest guard passed it because no two bytes lined up. A
    // reader of the channel sees two reports of one run either way.
    const first =
      "The end-to-end run finished on ports 3005 and 8600, and the judge scored " +
      "mushroom_shaman, blueberry_pie and copper_kettle without a fallback.";
    const reworded =
      "On ports 3005 and 8600 the end-to-end run completed, and the judge scored " +
      "the three assets mushroom_shaman, blueberry_pie and copper_kettle, with no fallback taken.";
    const p = sentPath(join(scratch(), "slack.json"), "dev");
    recordSent(p, "9.1", {
      hash: "aaa",
      channel: "general",
      at: "2026-08-28T04:00:00Z",
      words: contentWords(first),
    });
    const rows = readSentRows(p);
    const now = Date.parse("2026-08-28T04:02:07Z");
    // The shipped threshold is 0.8, and this pair measures 0.833.
    const hit = saidAlready(rows, "general", contentWords(reworded), now, 10 * 60 * 1000, { content: 0.8, short: 0.85 });
    expect(hit?.row.ts).toBe("9.1");
    expect(hit!.overlap).toBeGreaterThan(0.8);
    // The system treats a different report as distinct. Refusing these reports would
    // teach agents to pass `--again` by reflex, which retires the guard.
    const other =
      "The gate is red on the coverage stage, and src/status.ts sits at 92% lines " +
      "after the ledger change.";
    expect(saidAlready(rows, "general", contentWords(other), now, 10 * 60 * 1000, { content: 0.8, short: 0.85 })).toBeUndefined();
    // Two status reports on different runs share their format and their nouns, and the
    // numbers distinguish them, so a number of any length counts as a content word.
    // These measure 0.429.
    const runA = "peers 9, damaged 0, my row is on fad46a5 at 04:18";
    const runB = "peers 10, damaged 1, my row is on fad46a5 at 05:20";
    expect(wordOverlap(contentWords(runA), contentWords(runB))).toBeLessThan(0.8);
    // A row from another channel, a row past the window, or a row with no words does
    // not match.
    expect(saidAlready(rows, "other", contentWords(reworded), now, 10 * 60 * 1000, { content: 0.8, short: 0.85 })).toBeUndefined();
    expect(
      saidAlready(rows, "general", contentWords(reworded), Date.parse("2026-08-28T05:00:00Z"), 10 * 60 * 1000, { content: 0.8, short: 0.85 }),
    ).toBeUndefined();
    expect(saidAlready([{ ts: "1.1" }], "general", contentWords(reworded), now, 10 * 60 * 1000, { content: 0.8, short: 0.85 })).toBeUndefined();
    // A short draft is never classified as a near-duplicate. Containment across a
    // handful of words reaches 1.0 on two unrelated one-line drafts, and this suite
    // refused a second one-line draft before the floor existed.
    const shortA = contentWords("the line as drafted");
    const shortB = contentWords("a second line, drafted separately");
    expect(wordOverlap(shortA, shortB)).toBe(1);
    expect(shortB.length).toBeLessThan(NEAR_DUPLICATE_FLOOR);
    const shortRows = [{ ts: "8.8", channel: "general", at: "2026-08-28T04:00:00Z", words: shortA }];
    expect(saidAlready(shortRows, "general", shortB, now, 10 * 60 * 1000, { content: 0.8, short: 0.85 })).toBeUndefined();
    // The list provides the deduplicated and sorted content words and numbers, with
    // edge punctuation removed and inner dots preserved.
    expect(contentWords("The run is on port 3005 and the run held.")).toEqual(["3005", "held", "port"]);
    expect(contentWords("read src/cli.ts at 92% after v2.1.234.")).toEqual([
      "92",
      "after",
      "read",
      "src/cli.ts",
      "v2.1.234",
    ]);
    expect(wordOverlap([], ["a"])).toBe(0);
    expect(wordOverlap(["a", "b"], ["a", "b"])).toBe(1);
  });

  test("A CHINESE MESSAGE IS SCORED ON ITS TEXT, and not on its identifiers alone", () => {
    // The word filter supported only ASCII and stripped all other characters, so a
    // Chinese message reduced to its numbers and paths. An agent measured 166 Chinese
    // characters leaving 20 tokens, all of them identifiers. Two unrelated Chinese
    // reports then scored 0.500 on shared shas alone. The failure escaped detection,
    // since the gate keeps every tracked file in English. These are two real messages
    // from the channel: a restart report and an install report.
    const reportA = "\u6211\u5df2\u7ecf\u5b8c\u6210\u91cd\u542f\uff0c\u5f53\u524d\u8fd0\u884c\u7248\u672c\u548c\u672c\u673a\u4e00\u81f4\u3002\u65e7\u8fdb\u7a0b 228763 \u6309 PID \u6740\u6389\uff0c\u65b0\u8fdb\u7a0b 313173 \u8fd0\u884c 0dc4314\u3002";
    const reportB = "\u6211\u8fd9\u8fb9\u5df2\u7ecf\u66f4\u65b0\u5230\u4e86\u6700\u65b0\u7248\u672c\uff0c\u4f60\u5217\u8868\u91cc\u7684 228763 \u5df2\u7ecf\u4e0d\u5728\u4e86\uff0c\u4f60\u53ef\u4ee5\u628a\u5b83\u4ece stale \u540d\u5355\u91cc\u5212\u6389\u3002";
    // The Chinese text now contributes, so two different reports read as different,
    // measuring 0.500 before this change and 0.125 after.
    expect(wordOverlap(contentWords(reportA), contentWords(reportB))).toBeLessThan(0.2);
    // Character bigrams replace segmentation, so a shared phrase produces shared
    // tokens. The system uses no dictionary.
    // `\u91cd\u542f\u5b8c\u6210` means "restart complete", yielding three bigrams from
    // four characters.
    expect(contentWords("\u91cd\u542f\u5b8c\u6210")).toEqual(["\u542f\u5b8c", "\u5b8c\u6210", "\u91cd\u542f"].sort());
    // A single-character run retains the character.
    expect(contentWords("\u8bf4 hello there")).toEqual(["hello", "there", "\u8bf4"]);
    // The system still counts the identifiers beside the text.
    expect(contentWords("\u91cd\u542f 0dc4314")).toContain("0dc4314");
    // These operations leave an ASCII pair unchanged.
    const asciiA = "peers 9, damaged 0, my row is on fad46a5 at 04:18";
    const asciiB = "peers 10, damaged 1, my row is on fad46a5 at 05:20";
    expect(wordOverlap(contentWords(asciiA), contentWords(asciiB))).toBeLessThan(0.8);
  });

  test("A SHORT FOLLOW-UP IS NOT A RE-TELLING, however much of it the report held", () => {
    // Containment alone classified the item as a match. An agent measured an 8-word
    // note whose every word appeared in a 22-word report: the containment was 1.000,
    // the size ratio was 0.36, and the guard would have refused a legitimate
    // addendum. The reworded retry this guard exists for measures a ratio of 0.80.
    const report =
      "The end-to-end run finished on ports 3005 and 8600, and the judge scored " +
      "mushroom_shaman, blueberry_pie and copper_kettle without a fallback. Coverage held " +
      "at 100% and the gate passed every stage including the language check.";
    const followUp = "The judge scored copper_kettle without a fallback on ports 3005 and 8600.";
    const big = contentWords(report);
    const small = contentWords(followUp);
    expect(Math.min(big.length, small.length) / Math.max(big.length, small.length)).toBeLessThan(
      COMPARABLE_SIZE_RATIO,
    );
    // The report contains every word of the follow-up, and the score classifies it as
    // a fragment.
    expect(small.every((word) => big.includes(word))).toBe(true);
    expect(wordOverlap(big, small)).toBeLessThan(0.8);
    // The pair this guard exists for is unaffected, with comparable sizes at 0.833.
    const retryA =
      "The end-to-end run finished on ports 3005 and 8600, and the judge scored " +
      "mushroom_shaman, blueberry_pie and copper_kettle without a fallback.";
    const retryB =
      "On ports 3005 and 8600 the end-to-end run completed, and the judge scored " +
      "the three assets mushroom_shaman, blueberry_pie and copper_kettle, with no fallback taken.";
    expect(wordOverlap(contentWords(retryA), contentWords(retryB))).toBeGreaterThan(0.8);
  });

  test("EVERY SEND RECORDS WHAT IT MEASURED, so the threshold gets real data", () => {
    // The current number relies on corpus runs that three agents performed by hand,
    // and the CJK side relies on two synthetic pairs that disagree by a factor of two.
    // An agent that writes English by the operator's rule cannot produce Chinese
    // samples on request, and the tool can gather them.
    const rows: SentRow[] = [
      { ts: "1.1", channel: "general", at: "t", words: ["a"], near: { score: 0.12, ts: "0.9" } },
      { ts: "2.2", channel: "general", at: "t", words: ["a"], near: { score: 0.44, ts: "1.1" } },
      { ts: "3.3", channel: "general", at: "t", words: ["a"], near: { score: 0.79, ts: "2.2" } },
      { ts: "4.4", channel: "general", at: "t", words: ["a"] },
    ];
    const said = nearReport(rows, 0.8);
    expect(said).toContain("3 send(s) measured against an earlier draft, refused at 0.8");
    // A real duplicate appears first in the band below the threshold.
    expect(said).toContain("0.6 to 0.8  1");
    expect(said).toContain("0.790  ts 3.3 against 2.2 in general");
    // A send receives no score when it has nothing earlier to compare against.
    expect(said).not.toContain("ts 4.4");
    // An empty pile explains why it is empty, so nobody interprets silence as zero
    // duplicates.
    expect(nearReport([{ ts: "1.1" }], 0.8)).toContain("has measured itself against an earlier draft yet");
    // Without an override, the report classifies every row as the negative class,
    // since each row is a message that went out.
    expect(said).toContain("No send here used --again");
    // An override is a labeled false positive where the author overruled a refusal,
    // and it moves the threshold.
    const withOverride: SentRow[] = [
      ...rows,
      { ts: "5.5", channel: "general", at: "t", words: ["a"], near: { score: 0.91, ts: "3.3", again: true } },
    ];
    const argued = nearReport(withOverride, 0.8);
    expect(argued).toContain("1 send(s) went out under --again");
    expect(argued).toContain("0.910  ts 5.5 against 3.3");
    expect(argued).toContain("labelled false positives");
  });

  test("A ONE-LINE DUPLICATE IS SCORED, on every token instead of the content words", () => {
    // Two agents confirmed a duplicate when an agent sent one line twice, 127 seconds
    // apart, reporting the same test pass. It held 6 and 5 content words. Because this
    // count was under the floor, the system never scored it at all while the threshold
    // debate ran on a number that never applied to it.
    const first = "@andrew The hallucination metric end-to-end test passed on the dev box";
    const second = "@andrew The hallucination metric passed E2E on the dev box";
    expect(contentOf(allWords(first)).length).toBeLessThan(NEAR_DUPLICATE_FLOOR);
    const scored = pairScore(allWords(first), allWords(second));
    expect(scored.scale).toBe("short");
    expect(scored.overlap).toBeGreaterThan(0.85);
    // Measurements on the labelled pairs show that the short negatives stay below it.
    const pairs: Array<[string, string, number]> = [
      ["peers 9 damaged 0 on fad46a5", "peers 10 damaged 1 on fad46a5", 0.85],
      ["the gate is green", "the gate is green and the suite passes", 0.85],
      ["the line as drafted", "a second line, drafted separately", 0.85],
      ["restarted my listener on 8188178", "the coverage stage is red at 92%", 0.85],
    ];
    for (const [x, y, ceiling] of pairs) {
      const s = pairScore(allWords(x), allWords(y));
      expect(s.scale).toBe("short");
      expect(s.overlap).toBeLessThan(ceiling);
    }
    // A long pair still uses the content scale, where the grammar changed by a
    // rewording drops out.
    const reportA =
      "The end-to-end run finished on ports 3005 and 8600, and the judge scored " +
      "mushroom_shaman, blueberry_pie and copper_kettle without a fallback.";
    const reportB =
      "On ports 3005 and 8600 the end-to-end run completed, and the judge scored " +
      "the three assets mushroom_shaman, blueberry_pie and copper_kettle, with no fallback taken.";
    expect(pairScore(allWords(reportA), allWords(reportB)).scale).toBe("content");
  });

  test("THE SHIPPED THRESHOLDS SEPARATE EVERY REAL LABELLED PAIR", () => {
    // A manually authored pair received a score of 0.833 and served as the founding
    // incident, and two agents built threshold arguments on that number before anyone
    // measured real messages at 0.968. A row with no `ts` is a pair nobody sent, and it
    // does not decide the number.
    const shipped = { content: 0.81, short: 0.85 };
    expect(calibrationMisses(shipped).real).toEqual([]);
    // The manually created rows also use the shipped number, which makes 0.81 the
    // only value nobody has to argue about.
    expect(calibrationMisses(shipped).synthetic).toEqual([]);
    // The table lists the pairs and records who measured each one.
    expect(CALIBRATION.some((c) => c.ts !== undefined && c.score === 0.968 && c.label === "duplicate")).toBe(true);
    expect(CALIBRATION.every((c) => c.measuredBy !== "")).toBe(true);
    // Every measured row contains its two text hashes. Slack lost four of the five
    // source messages behind these rows, one to a deletion and four to a morning
    // cleanup, while every listener had already written each delivery to disk. An
    // agent holding the text uses these hashes to confirm it is the same text after the
    // channel no longer has it.
    const measured = CALIBRATION.filter((c) => c.source === "measured");
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((c) => c.sha !== undefined)).toBe(true);
    expect(CALIBRATION.flatMap((c) => c.sha ?? []).every((h) => /^[0-9a-f]{16}$/.test(h))).toBe(true);
    // Setting a threshold above confirmed duplicates causes the real dataset to fail,
    // which is the constraint that any proposal to raise the threshold must clear.
    expect(calibrationMisses({ content: 0.97, short: 0.85 }).real).toHaveLength(1);
    // The system judges a row with no scale at both cuts. Three byte-identical pairs
    // came from another agent's log with no scale, and half of each pair is deleted,
    // so the system cannot derive a scale. A short cut above 1.000 has to fail them.
    const noScale = CALIBRATION.filter((c) => c.source === "measured" && c.scale === undefined);
    expect(noScale).toHaveLength(3);
    expect(calibrationMisses({ content: 0.81, short: 1.01 }).real).toHaveLength(noScale.length);
    expect(calibrationMisses({ content: 0.81, short: 1.01 }).real.join(" ")).toContain("unrecorded scale");
    // Matching hashes demonstrate identity. The score reads 1.000 for a rewording
    // that shares every content word as well.
    expect(noScale.every((c) => c.score === 1 && c.sha![0] === c.sha![1])).toBe(true);
    // A value one below the highest wanted pair fails it from the other side.
    expect(calibrationMisses({ content: 0.79, short: 0.85 }).real).toHaveLength(1);
  });

  test("a malformed row reads as an empty ts, never taking the file down", () => {
    const p = sentPath(join(scratch(), "slack.json"), "dev");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, ['{"ts":"1.1","hash":"a","channel":"c","at":"t"}', "{ broken", '{"nots":1}', "2.2"].join("\n"));
    expect(readSent(p)).toEqual(["1.1", "2.2"]);
  });

  test("an absent file reads as nothing said", () => {
    expect(readSent(sentPath(scratch(), "dev"))).toEqual([]);
  });

  test("the file is capped, keeping the NEWEST", () => {
    // A long-running listener must not allow a file to grow indefinitely, and the `ts`
    // values that matter are the recent ones that still receive replies.
    const p = sentPath(join(scratch(), "slack.json"), "dev");
    for (let i = 0; i < 520; i += 1) recordSent(p, `${i}.0`);
    const kept = readSent(p);
    expect(kept).toHaveLength(500);
    expect(kept.at(-1)).toBe("519.0");
    expect(kept[0]).toBe("20.0");
  });
});

describe("the ledger survives several processes closing at once", () => {
  // Before the fix, measurements showed that eight processes that each closed one
  // item left TWO still open. Every close operation read the whole ledger, changed
  // what it read, and wrote it back, so the last writer won. A lost close nags an
  // agent about a question it has answered, which teaches the agent to stop reading
  // its own list.
  test("eight concurrent closes all take", async () => {
    const dir = scratch();
    const p = join(dir, "inbox", "dev.jsonl");
    for (let i = 0; i < 8; i += 1) recordInboxItem(p, item({ id: `${i}.0`, addressed: true }));
    const probe = join(dir, "close.ts");
    writeFileSync(
      probe,
      [
        `import { closeItemById } from "${join(import.meta.dir, "..", "src", "inbox")}";`,
        `closeItemById(${JSON.stringify(p)}, process.argv[2]!, "concurrent");`,
      ].join("\n"),
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Bun.spawn(["bun", probe, `${i}.0`], { stdout: "ignore", stderr: "ignore" }).exited,
      ),
    );
    expect(readInbox(p)).toHaveLength(8);
    expect(pendingInbox(p)).toHaveLength(0);
  }, 30_000);
});

