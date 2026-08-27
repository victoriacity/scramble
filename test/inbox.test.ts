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
  readInbox,
  readSent,
  readSentRows,
  sentAlready,
  recordSent,
  sentPath,
  recordInboxItem,
  traceReport,
  type InboxItem,
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
    // The operator, 2026-08-22: "Each of your inbox item must be addressed by at
    // least 1 reply." The check before this counted TURNS, and a turn boundary
    // is not an item boundary: two items arriving together were satisfied by one
    // reply.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item());
    expect(pendingInbox(p)).toHaveLength(1);
    const said = pendingReport(pendingInbox(p), "dev");
    expect(said).toContain("1 inbox item(s) addressed to dev with no reply");
    expect(said).toContain("why are stale bots created");
    expect(said).toContain("scramble-dev");
  });

  test("TWO items arriving together are NOT satisfied by one reply to one of them", () => {
    // The exact gap in the per-turn check, stated as a test.
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
    // Already answered stays answered: a later reply does not re-close, so the
    // count of what a reply did is the count of what it actually closed.
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
    // MEASURED: xingyubot asked me something at channel level, I answered a
    // different agent inside a thread half a minute later, and the ledger marked
    // their question answered by that reply (2026-08-25, ts 1787664642.769859
    // closed by 1787664661.695049). They waited with nothing on my list.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "asked-in-the-room" }));
    recordInboxItem(p, item({ id: "asked-in-the-thread", thread: "root-1" }));
    expect(closeInboxItems(p, "scramble-dev", "reply", "root-1")).toBe(1);
    expect(pendingInbox(p).map((r) => r.id)).toEqual(["asked-in-the-room"]);
    // The room's own answer still closes the room.
    expect(closeInboxItems(p, "scramble-dev", "reply-2")).toBe(1);
    expect(pendingInbox(p)).toHaveLength(0);
  });

  test("a message I already sent closes every OLDER question in that channel", () => {
    // Five questions answered hours before the ledger existed sat in `pending`
    // forever, and a list naming answered questions is one an agent scrolls
    // past. A reply is a reply whether or not it went through this CLI.
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
    // "999.9" sorts after "1787360000.0" as a STRING, which would leave an old
    // item open forever and close a new one by mistake.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "999.9", channel: "room" }));
    expect(closeAnsweredBefore(p, "room", "1787360000.000000")).toBe(1);
    // A ts that is not a number closes nothing, and never throws.
    const q = join(scratch(), "inbox", "dev2.jsonl");
    recordInboxItem(q, item({ id: "1.0", channel: "room" }));
    expect(closeAnsweredBefore(q, "room", "not-a-ts")).toBe(0);
    expect(closeAnsweredBefore(q, "room", "0.5")).toBe(0);
    expect(pendingInbox(q)).toHaveLength(1);
  });

  test("the same message delivered twice is ONE item, per CHANNEL", () => {
    // A listener and a 15-minute sweep both see the same mention. Two rows would
    // demand two replies for one question.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item());
    recordInboxItem(p, item());
    expect(readInbox(p)).toHaveLength(1);
    // A Slack ts is unique WITHIN a channel and says nothing across channels, so
    // the same ts elsewhere is a different question.
    recordInboxItem(p, item({ channel: "elsewhere" }));
    expect(readInbox(p)).toHaveLength(2);
  });

  test("only lines ADDRESSED to this agent by someone else become items", () => {
    const me = ["dev", "dev_bot"];
    expect(isAddressed({ mentioned: true, from: "andrew", mentions: ["dev_bot"] }, me)).toBe(true);
    // A mention resolves to the HANDLE, which differs from the scramble name.
    expect(isAddressed({ mentioned: true, from: "andrew", mentions: ["dev"] }, me)).toBe(true);
    // Its own line, under either identity: never an obligation to answer.
    expect(isAddressed({ mentioned: true, from: "dev" }, me)).toBe(false);
    expect(isAddressed({ mentioned: true, from: "dev_bot" }, me)).toBe(false);
    // Traffic that merely passed through the channel is not a question.
    expect(isAddressed({ mentioned: false, from: "andrew" }, me)).toBe(false);
    expect(isAddressed({ from: "andrew" }, me)).toBe(false);
  });

  test("a BROADCAST owes every agent a reply, though it names none of them", () => {
    // Without this the "named here, or naming nobody" rule reads @channel as
    // somebody else's name and drops it, so a message meant for the whole room
    // reaches no ledger even once delivery carries it.
    const me = ["dev", "dev_bot"];
    for (const kind of ["channel", "here", "everyone"]) {
      expect(isAddressed({ mentioned: true, from: "andrew", mentions: [kind] }, me)).toBe(true);
    }
    // Still no obligation when it is this agent's own broadcast.
    expect(isAddressed({ mentioned: true, from: "dev_bot", mentions: ["channel"] }, me)).toBe(false);
  });

  test("a question addressed to SOMEONE ELSE in my thread is not mine to answer", () => {
    // Delivery and obligation are different questions. A peer wrote
    // "@alignment_benchmark there is a concrete overlap" inside a thread I had
    // replied in, so it arrived with mentioned:true, and `inbox pending` told me
    // someone was waiting on me for a question addressed to somebody else.
    const me = ["dev", "dev_bot"];
    expect(isAddressed({ mentioned: true, from: "peer", mentions: ["someone_else"] }, me)).toBe(false);
    // Naming nobody, inside my thread, IS mine: that is a bare reply to me.
    expect(isAddressed({ mentioned: true, from: "peer", mentions: [] }, me)).toBe(true);
    expect(isAddressed({ mentioned: true, from: "peer" }, me)).toBe(true);
    // Naming both of us is mine too.
    expect(isAddressed({ mentioned: true, from: "peer", mentions: ["someone_else", "dev_bot"] }, me)).toBe(true);
  });

  test("a half-written row does not take the whole ledger down", () => {
    // The ledger's job is to be readable at the moment something went wrong, so
    // a row truncated by a killed process must cost that row and nothing else.
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
    // Closing against a ledger that does not exist is a no-op, never a crash on
    // the reply path: a message must go out even when the accounting cannot.
    expect(closeInboxItems(p, "scramble-dev", "reply")).toBe(0);
  });

  test("the ledger sits beside the config, one file per agent", () => {
    expect(inboxPath(join("cfgroot", "slack.json"), "scramble-dev")).toBe(
      join("cfgroot", "inbox", "scramble-dev.jsonl"),
    );
  });

  test("an unwritable ledger throws to the caller, which reports it", () => {
    // emitDelivery catches this and prints it, so an inbox that counts nothing
    // does not read as an inbox with nothing in it.
    const dir = scratch();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    expect(() => recordInboxItem(join(locked, "inbox", "dev.jsonl"), item())).toThrow();
    chmodSync(locked, 0o700);
  });
});

describe("inbox trace: what happened to ONE message, without grepping a text log", () => {
  // Four agents on four hosts spent 2026-08-22 answering "did that message reach
  // me?" with grep one-liners over a `tee` of the listener, and each of the four
  // ways that fails was measured live by the agent running it. Each test below
  // is one of those four.

  test("a message QUOTING the id does not read as delivery of it", () => {
    // An agent grepped its wake file for a broadcast ts and got a hit, which read
    // as proof the broadcast arrived. The hit was a PEER'S message quoting that
    // timestamp in its text. Comparing the id field cannot make that mistake.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "999.111", text: "the broadcast at 1787388201.288129 never woke me" }));
    const said = traceReport(readInbox(p), "1787388201.288129", "dev", p);
    expect(said).toContain("was NOT delivered to dev");
    expect(said).not.toContain("WAS delivered");
  });

  test("a correct absence names the corpus it searched, so it is not a bare False", () => {
    // "A check with no positive control cannot tell a correct False from a broken
    // one." An agent's grep returned zero and was right BY LUCK, because nobody
    // had quoted the ts yet.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: true }));
    recordInboxItem(p, item({ id: "200.2", addressed: false }));
    const said = traceReport(readInbox(p), "300.3", "dev", p);
    expect(said).toContain("Searched 2 delivered row(s)");
    expect(said).toContain("ids 100.1 to 200.2");
    expect(said).toContain("1 addressed to this agent, 1 delivered without addressing it");
  });

  test("the corpus counts what the rows CARRY, and never infers a count", () => {
    // The first version printed "88 of them addressed to this agent" over a file
    // where no row carried the field, because the back-compat rule that keeps old
    // items in `pending` got reused as a measurement. The agent who read it:
    // "the count is inferred from a missing field and printed as though
    // measured."
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1" }));
    recordInboxItem(p, item({ id: "200.2" }));
    const said = traceReport(readInbox(p), "100.1", "dev", p);
    expect(said).toContain("0 addressed to this agent, 0 delivered without addressing it");
    expect(said).toContain("2 written before the ledger recorded unaddressed deliveries");
    // And the row itself reports the field as unrecorded, never as a value.
    expect(said).toContain("is UNRECORDED: this row predates that field");
  });

  test("an absence over rows that predate the field is REFUSED, not reported", () => {
    // Those rows were written when only ADDRESSED lines were recorded, so a
    // delivery that addressed nobody was never written and is missing exactly as
    // a message that never arrived is missing. A broadcast is that case, which is
    // the one thing anybody was tracing.
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
    // The ledger is keyed by agent NAME. An agent repointed its name at its own
    // Slack app after an hour on a shared one, and its ledger holds 14 rows from
    // a channel the current app has never been in: two identities, one corpus,
    // reported under one name.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", channel: "argo", app: "A0OLD", addressed: true }));
    recordInboxItem(p, item({ id: "300.3", app: "A0MINE", addressed: true }));
    const said = traceReport(readInbox(p), "300.3", "dev", p, "A0MINE");
    expect(said).toContain("1 row(s) here were delivered to app A0OLD");
    expect(said).toContain("NOT this agent's app A0MINE");
    expect(said).toContain("keyed by agent NAME");
    // With no app known, nothing is claimed about identity at all.
    expect(traceReport(readInbox(p), "300.3", "dev", p)).not.toContain("were delivered to app");
  });

  test("an EMPTY ledger refuses to answer instead of reporting absence", () => {
    // The dangerous case: a ledger that is not being written looks exactly like a
    // message that never arrived. This one says so and sends the reader to doctor.
    const p = join(scratch(), "inbox", "dev.jsonl");
    const said = traceReport(readInbox(p), "300.3", "dev", p);
    expect(said).toContain("holds NO rows");
    expect(said).toContain("says nothing about the message");
    expect(said).toContain("scramble doctor");
  });

  test("a plain English diagnostic line in the ledger does not kill the check", () => {
    // The third failure, and the worst: a check that parses every line as JSON
    // dies on a file that also carries "scramble doctor" and socket errors, so it
    // crashes exactly when the wake path is broken, the one occasion anybody runs
    // it.
    const dir = join(scratch(), "inbox");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1" }));
    writeFileSync(p, `${readInbox(p).map((r) => JSON.stringify(r)).join("\n")}\nlistener refused: socket closed\n`);
    const said = traceReport(readInbox(p), "100.1", "dev", p);
    expect(said).toContain("WAS delivered to dev");
  });

  test("DELIVERED and ADDRESSED are answered separately: the broadcast defect", () => {
    // `<!channel>` reached four agents and addressed none of them, so every one of
    // them saw it in a 15-minute sweep and nothing woke. A ledger holding only
    // addressed lines cannot tell that apart from never arriving.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: false, text: "@channel write English in files" }));
    const said = traceReport(readInbox(p), "100.1", "dev", p);
    expect(said).toContain("WAS delivered to dev");
    expect(said).toContain("NOT addressed to dev");
    expect(said).toContain("visible only to a sweep");
    expect(said).toContain("no reply recorded");
    // And it owes nobody an answer, so it stays out of pending.
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
    // The verdict without its evidence sent two agents guessing which mention
    // opened six items, and one guess reached the channel as a cause
    // (2026-08-27).
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "1.1", addressed: true, mentions: ["dev", "ana"] }));
    recordInboxItem(p, item({ id: "2.2", addressed: false, mentions: [] }));
    const named = traceReport(readInbox(p), "1.1", "dev", p);
    expect(named).toContain("The line named @dev, @ana.");
    const nobody = traceReport(readInbox(p), "2.2", "dev", p);
    expect(nobody).toContain("The line named nobody");
    // A row predating the field claims nothing about names.
    const old = join(scratch(), "inbox", "old.jsonl");
    recordInboxItem(old, item({ id: "3.3", addressed: true }));
    expect(traceReport(readInbox(old), "3.3", "dev", old)).not.toContain("The line named");
  });

  test("a row written before the addressed field existed still owes a reply", () => {
    // Back-compat, and it matters: the ledger only ever held addressed items, so
    // a missing field means addressed. Reading it as false would silently empty
    // `pending` of every question asked before today.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1" }));
    expect(pendingInbox(p)).toHaveLength(1);
    // The obligation is kept, and trace still refuses to CLAIM it woke anyone:
    // keeping an old question answerable and asserting what the row recorded are
    // different things, and only the first is safe to infer.
    expect(traceReport(readInbox(p), "100.1", "dev", p)).toContain("is UNRECORDED");
  });

  test("a delivery-only row is never closed by a reply or by an own message", () => {
    // It is not an obligation, so nothing should stamp it answered: a trace of it
    // must keep saying "nothing woke" however much traffic followed.
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: false }));
    expect(closeInboxItems(p, "scramble-dev", "555.5")).toBe(0);
    expect(closeAnsweredBefore(p, "scramble-dev", "999.9")).toBe(0);
    expect(traceReport(readInbox(p), "100.1", "dev", p)).toContain("no reply recorded");
  });
});

describe("inbox close: an item the sender said needs no reply", () => {
  // xingyubot, 2026-08-22, with its own message as the example: it wrote "no need
  // to reply to this one", `inbox pending` kept the item open, a reaction did not
  // clear it, and only a real send did. So an agent clearing its ledger answers a
  // message whose sender asked it not to, and a mechanism built to stop people
  // being left waiting starts manufacturing noise.

  test("closing settles the item and records the reason on the row", () => {
    const p = join(scratch(), "inbox", "dev.jsonl");
    recordInboxItem(p, item({ id: "100.1", addressed: true }));
    expect(closeItemById(p, "100.1", "sender said no reply needed")).toEqual({ ok: true });
    expect(pendingInbox(p)).toHaveLength(0);
    // THE DECISION IS ON THE RECORD. A close is the agent deciding an obligation
    // is settled, which a reply never is, so it has to be visible to whoever reads
    // the file or traces the id later.
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
  // The rule was "named here, or naming nobody". Against one afternoon it put 18
  // messages from another team's task thread into my list, none of them for me,
  // while every message that WAS for me either named me or answered something I
  // had said. A list of other people's questions is one an agent scrolls past.

  test("a message naming nobody in someone else's thread is delivered, and owed to nobody", () => {
    const d = { mentioned: true, from: "teamassistant", mentions: [], thread: "root-of-their-task" };
    expect(isAddressed(d, ["dev"], ["9.9"])).toBe(false);
  });

  test("a reply naming nobody in this agent's own thread is owed to it", () => {
    // The operator answered a question of mine with one word, "limit", naming
    // nobody, in a reply to my own message. Slack threading is why a reply to me
    // carries no name.
    const d = { mentioned: true, from: "andrew", mentions: [], thread: "mine-1" };
    expect(isAddressed(d, ["dev"], ["mine-1"])).toBe(true);
    expect(isAddressed(d, ["dev"], ["someone-elses"])).toBe(false);
  });

  test("two peers answering EACH OTHER in this agent's thread owe it nothing", () => {
    // The rule was "any reply in my thread, whoever it names". Two agents worked
    // through a defect inside one thread of mine and opened nine items in my
    // ledger in twelve minutes, every one a message between the two of them
    // (2026-08-27). The reply names the agent it answers, and that agent is not
    // me.
    const between = { mentioned: true, from: "peer_metrics", mentions: ["model_failure_researc"], thread: "mine-1" };
    expect(isAddressed(between, ["dev", "dev_bot"], ["mine-1"])).toBe(false);
    // Naming me among them keeps it owed.
    const alsoMe = { ...between, mentions: ["model_failure_researc", "dev_bot"] };
    expect(isAddressed(alsoMe, ["dev", "dev_bot"], ["mine-1"])).toBe(true);
    // A broadcast in my own thread still reaches me.
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
    // MEASURED: two byte-identical copies 27 seconds apart reached a third
    // agent's inbox after the `posted:` line shipped (xingyubot reading
    // @peer_metrics, 2026-08-26). An agent asked for exactly this: "A retry
    // after a genuine post must be a no-op, for example by setting an
    // idempotency key on the draft hash" (peer-auto-evals, 2026-08-26).
    const p = sentPath(join(scratch(), "slack.json"), "dev");
    recordSent(p, "1.1");
    recordSent(p, "2.2", { hash: "abc", channel: "general", at: "2026-08-26T12:00:00Z" });
    // The ts list is unchanged for every older reader.
    expect(readSent(p)).toEqual(["1.1", "2.2"]);
    const rows = readSentRows(p);
    expect(rows[0]).toEqual({ ts: "1.1" });
    expect(rows[1]?.hash).toBe("abc");
    const now = Date.parse("2026-08-26T12:05:00Z");
    expect(sentAlready(rows, "general", "abc", now, 10 * 60 * 1000)?.ts).toBe("2.2");
    // Another channel, another draft, or past the window: no match.
    expect(sentAlready(rows, "other", "abc", now, 10 * 60 * 1000)).toBeUndefined();
    expect(sentAlready(rows, "general", "zzz", now, 10 * 60 * 1000)).toBeUndefined();
    expect(sentAlready(rows, "general", "abc", Date.parse("2026-08-26T13:00:00Z"), 10 * 60 * 1000)).toBeUndefined();
    // A row predating the field carries no draft, so it never matches.
    expect(sentAlready([{ ts: "1.1" }], "general", "abc", now, 10 * 60 * 1000)).toBeUndefined();
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
    // A long-running listener must not grow a file forever, and the ts values
    // that matter are the recent ones still being replied to.
    const p = sentPath(join(scratch(), "slack.json"), "dev");
    for (let i = 0; i < 520; i += 1) recordSent(p, `${i}.0`);
    const kept = readSent(p);
    expect(kept).toHaveLength(500);
    expect(kept.at(-1)).toBe("519.0");
    expect(kept[0]).toBe("20.0");
  });
});

describe("the ledger survives several processes closing at once", () => {
  // MEASURED before the fix: eight processes each closing one item left TWO
  // still open. Every close read the whole ledger, changed what it read, and
  // wrote it back, and the last writer won. A lost close nags an agent about a
  // question it has answered, which is how an agent learns to stop reading its
  // own list (2026-08-25).
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
