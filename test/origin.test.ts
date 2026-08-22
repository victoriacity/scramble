// test/origin.test.ts — WHERE AN AGENT RUNS, published on the message itself.
//
// The operator, 2026-08-22: "Does each agent record its hostname and working
// directory on scramble and an agent may know its same directory peers?" It did
// not, and the absence cost two round trips that afternoon.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORIGIN_METADATA_TYPE,
  currentPeers,
  originMetadata,
  originOf,
  peersPath,
  peersReport,
  readOrigin,
  readPeers,
  recordPeer,
  type Origin,
} from "../src/origin";

const scratch = (): string => mkdtempSync(join(tmpdir(), "scramble-origin-"));
const HERE: Origin = { host: "host-two", dir: "/srv/dev-work", commit: "abc1234" };

describe("an origin is built from what this process can read", () => {
  test("a commit is carried when the install knows one", () => {
    expect(originOf("h1", "/w", "abc1234")).toEqual({ host: "h1", dir: "/w", commit: "abc1234" });
  });

  test("an unknown commit is ABSENT, never a placeholder", () => {
    // A checkout has no installed sha. An absent field is honest; a made-up one
    // would be read by a peer as a fact about which code is running.
    expect(originOf("h1", "/w")).toEqual({ host: "h1", dir: "/w" });
    expect(originOf("h1", "/w", "")).toEqual({ host: "h1", dir: "/w" });
  });
});

describe("it rides on Slack message metadata", () => {
  test("the metadata block carries host, dir and commit", () => {
    expect(originMetadata(HERE)).toEqual({
      event_type: ORIGIN_METADATA_TYPE,
      event_payload: { host: "host-two", dir: "/srv/dev-work", commit: "abc1234" },
    });
  });

  test("a commitless origin makes a payload with no commit key", () => {
    expect(originMetadata({ host: "h", dir: "/w" }).event_payload).toEqual({ host: "h", dir: "/w" });
  });

  test("a round trip returns exactly what was sent", () => {
    expect(readOrigin(originMetadata(HERE))).toEqual(HERE);
    expect(readOrigin(originMetadata({ host: "h", dir: "/w" }))).toEqual({ host: "h", dir: "/w" });
  });

  test("anything that is not an origin reads as none, and never throws", () => {
    // The payload is written by ANOTHER agent, on a build older or newer than
    // this one. A message whose metadata is malformed must still be delivered.
    for (const bad of [
      undefined,
      null,
      "a string",
      42,
      {},
      { event_type: "scramble_status" },
      { event_type: ORIGIN_METADATA_TYPE },
      { event_type: ORIGIN_METADATA_TYPE, event_payload: null },
      { event_type: ORIGIN_METADATA_TYPE, event_payload: "text" },
      { event_type: ORIGIN_METADATA_TYPE, event_payload: { dir: "/w" } },
      { event_type: ORIGIN_METADATA_TYPE, event_payload: { host: "h" } },
      { event_type: ORIGIN_METADATA_TYPE, event_payload: { host: "", dir: "/w" } },
      { event_type: ORIGIN_METADATA_TYPE, event_payload: { host: "h", dir: "" } },
      { event_type: ORIGIN_METADATA_TYPE, event_payload: { host: 1, dir: 2 } },
    ]) {
      expect(readOrigin(bad)).toBeUndefined();
    }
  });

  test("a commit of the wrong shape is dropped while the origin survives", () => {
    expect(readOrigin({ event_type: ORIGIN_METADATA_TYPE, event_payload: { host: "h", dir: "/w", commit: 7 } })).toEqual(
      { host: "h", dir: "/w" },
    );
  });
});

describe("the peers record", () => {
  test("a peer is written once, and again only when it MOVED", () => {
    // Appending per message would grow the file with a busy channel; writing
    // nothing on a change would lose the move. The newest row wins on read, and
    // the older one stays, so "it used to run there" is answerable.
    const p = peersPath(join(scratch(), "slack.json"));
    expect(recordPeer(p, "dev", HERE, "2026-08-22T10:00:00Z")).toBe(true);
    expect(recordPeer(p, "dev", HERE, "2026-08-22T10:05:00Z")).toBe(false);
    expect(recordPeer(p, "dev", { ...HERE, dir: "/srv/other-work" }, "2026-08-22T10:10:00Z")).toBe(true);
    expect(recordPeer(p, "dev", { ...HERE, dir: "/srv/other-work", commit: "def5678" }, "2026-08-22T10:15:00Z")).toBe(
      true,
    );
    expect(readPeers(p)).toHaveLength(3);
    expect(currentPeers(readPeers(p))).toHaveLength(1);
    expect(currentPeers(readPeers(p))[0]).toMatchObject({ dir: "/srv/other-work", commit: "def5678" });
  });

  test("an unreadable or damaged file is skipped, never fatal", () => {
    const dir = scratch();
    expect(readPeers(join(dir, "nothing.jsonl"))).toEqual([]);
    const p = join(dir, "peers.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, `${JSON.stringify({ agent: "a", host: "h", dir: "/w", at: "t" })}\n\nnot json\n{"agent":"b"}\n`);
    expect(readPeers(p).map((r) => r.agent)).toEqual(["a"]);
  });

  test("the newest row per agent wins, sorted by name", () => {
    const rows = [
      { agent: "zed", host: "h1", dir: "/a", at: "t1" },
      { agent: "ana", host: "h1", dir: "/a", at: "t2" },
      { agent: "zed", host: "h2", dir: "/b", at: "t3" },
    ];
    expect(currentPeers(rows).map((r) => `${r.agent}:${r.host}`)).toEqual(["ana:h1", "zed:h2"]);
  });
});

describe("the peers report", () => {
  const rows = [
    { agent: "ana", host: "host-two", dir: "/srv/dev-work", commit: "abc1234", at: "2026-08-22T10:00:00Z" },
    { agent: "bo", host: "DESKTOP-STBCRML", dir: "C:\\xingyu-agent", at: "2026-08-22T10:01:00Z" },
  ];

  test("every peer is named with host, directory and commit", () => {
    const said = peersReport(rows, HERE, false);
    expect(said).toContain("2 peer(s)");
    expect(said).toContain("ana  host-two  /srv/dev-work  (abc1234)");
    expect(said).toContain("bo  DESKTOP-STBCRML  C:\\xingyu-agent");
  });

  test("--same-dir matches HOST AND directory, never the path alone", () => {
    // Two agents measured the SAME absolute path on two machines, backed by
    // different filesystems, and could not see each other's files (2026-08-22).
    // Grouping by path would have told them they shared a directory when they
    // shared a string.
    const sameString = [{ agent: "cy", host: "other-host", dir: "/srv/dev-work", at: "t" }, ...rows];
    const said = peersReport(sameString, HERE, true);
    expect(said).toContain("1 peer(s)");
    expect(said).toContain("ana");
    expect(said).not.toContain("cy");
  });

  test("no peers says WHY the answer can be empty", () => {
    // An empty list looks the same whether nobody is out there or nobody has
    // spoken, and only one of those means anything.
    const said = peersReport([], HERE, false);
    expect(said).toContain("No peers have been seen yet");
    expect(said).toContain("learned from a message it SENT");
    expect(said).toContain("too\nold to stamp it".replace("\n", " "));
  });

  test("no same-dir peers names the directory it looked in", () => {
    const said = peersReport(rows, { host: "h9", dir: "/elsewhere" }, true);
    expect(said).toContain("No peers running in /elsewhere on h9 have been seen yet");
  });

  test("without a known origin, --same-dir reports everyone and hides nothing", () => {
    // This build has no hostname seam, so it cannot know its own directory. It
    // says what it knows about others instead of filtering against a guess.
    expect(peersReport(rows, undefined, true)).toContain("2 peer(s)");
  });
});
