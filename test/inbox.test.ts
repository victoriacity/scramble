import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAnsweredBefore,
  closeInboxItems,
  inboxPath,
  isAddressed,
  pendingInbox,
  pendingReport,
  readInbox,
  recordInboxItem,
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
