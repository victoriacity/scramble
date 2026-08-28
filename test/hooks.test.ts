// The test/hooks.test.ts test serves as a positive control for the decision logic
// in .scramble/hooks.
//
// The test runs each hook's decide function against known-bad input, which must
// block, and known-good input, which must pass. The Stop hook must let an
// unaddressed, silent case pass untouched. This test exists to catch any hook that
// never blocks.
import { describe, expect, test } from "bun:test";
import { postGate, type PostGateDecision } from "../.scramble/hooks/post_gate";
import { stopBackstop, type StopDecision } from "../.scramble/hooks/stop_backstop";

describe("postGate", () => {
  test("blocks a self-reply: posting again while you hold the floor", () => {
    const d = postGate({
      command: `scramble post general "bump" --as ana`,
      sender: "ana",
      lastSender: "ana",
    });
    expectPost(d).blocked();
  });

  test("passes a reply to another sender", () => {
    const d = postGate({
      command: `scramble post general "pushing a fix" --as ana`,
      sender: "ana",
      lastSender: "dev",
    });
    expectPost(d).allowed();
  });

  test("passes when the sender identity is unknown (no self-reply possible)", () => {
    const d = postGate({
      command: `scramble post general "hello" --as ana`,
    });
    expectPost(d).allowed();
  });

  test("blocks a status-report shape", () => {
    const d = postGate({ command: `scramble post general "here is the status report: done" --as ana` });
    expectPost(d).blocked();
  });

  test("blocks a WIP-log with code-fence markers", () => {
    const d = postGate({
      command: `scramble post general "// update: about to land the migration" --as ana`,
    });
    expectPost(d).blocked();
  });

  test("blocks a multi-line colon docket", () => {
    const d = postGate({
      command: `scramble post general "todo:\nwire the tests:\nmerge:" --as ana`,
    });
    expectPost(d).blocked();
  });

  test("passes ordinary chat prose", () => {
    const d = postGate({
      command: `scramble post general "@dev the summary is in the PR, want me to file it?" --as ana`,
    });
    expectPost(d).allowed();
  });

  test("blocks a mention-free bare ack", () => {
    const d = postGate({ command: `scramble post general "ok" --as ana` });
    expectPost(d).blocked();
  });

  test("passes a bare ack that is addressed to someone", () => {
    const d = postGate({ command: `scramble post general "ok @dev will do" --as ana` });
    expectPost(d).allowed();
  });

  test("passes a mention-free substantive update", () => {
    const d = postGate({
      command: `scramble post general "the retry now backs off five times before failing" --as ana`,
    });
    expectPost(d).allowed();
  });

  test("passes a command that trim strips flags and quotes cleanly", () => {
    const d = postGate({
      command: `scramble post general "next step is to vendor typescript" --as ana`,
    });
    expectPost(d).allowed();
  });
});

describe("stopBackstop", () => {
  test("blocks when a delivered seq is beyond the handled cursor (pending)", () => {
    const d = stopBackstop({
      handledSeq: 3,
      delivered: [
        { channel: "general", seq: 6, mentioned: false },
        { channel: "general", seq: 4, mentioned: false },
      ],
      posted: [],
    });
    expectStop(d).blocked();
  });

  test("blocks an addressed message that got no reply", () => {
    const d = stopBackstop({
      handledSeq: 5,
      delivered: [{ channel: "general", seq: 5, mentioned: true, from: "human" }],
      posted: [],
    });
    expectStop(d).blocked();
  });

  test("passes addressed-and-answered", () => {
    const d = stopBackstop({
      handledSeq: 5,
      delivered: [{ channel: "general", seq: 5, mentioned: true }],
      posted: ["general"],
    });
    expectStop(d).allowed();
  });

  test("passes not-addressed-and-silent — the untouched case", () => {
    const d = stopBackstop({
      handledSeq: 5,
      delivered: [{ channel: "general", seq: 5, mentioned: false }],
      posted: [],
    });
    expectStop(d).allowed();
  });

  test("passes when nothing was delivered", () => {
    expect(stopBackstop({ handledSeq: 0, delivered: [], posted: [] }).block).toBe(false);
  });
});

function expectPost(d: PostGateDecision) {
  return {
    blocked() {
      expect(d.block).toBe(true);
      expect(d.reason).toContain("SKILL.md");
    },
    allowed() {
      expect(d.block).toBe(false);
      expect(d.reason).toBeUndefined();
    },
  };
}

function expectStop(d: StopDecision) {
  return {
    blocked() {
      expect(d.block).toBe(true);
      expect(typeof d.reason).toBe("string");
    },
    allowed() {
      expect(d.block).toBe(false);
    },
  };
}
