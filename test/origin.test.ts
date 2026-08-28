// test/origin.test.ts: WHERE AN AGENT RUNS, published on the message itself.
//
// The operator: "Does each agent record its hostname and working directory on
// scramble and an agent may know its same directory peers?" It did not, and the
// absence cost two round trips that afternoon.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ORIGIN_METADATA_TYPE,
  currentPeers,
  originMetadata,
  originOf,
  peerFileFor,
  peersDir,
  peersPath,
  peersOnOtherCommits,
  peersReport,
  readOrigin,
  readPeerFile,
  readPeers,
  recordPeer,
  runtimeOf,
  sameOrigin,
  type Origin,
} from "../src/origin";

const scratch = (): string => mkdtempSync(join(tmpdir(), "scramble-origin-"));
const HERE: Origin = { host: "host-two", dir: "/srv/dev-work", commit: "abc1234" };
const RUNNING: Origin = {
  ...HERE,
  runtime: { name: "claude-code", version: "2.1.234", session: "6a41d6cd", pid: "14027" },
};

describe("an origin is built from what this process can read", () => {
  test("a commit is carried when the install knows one", () => {
    expect(originOf("h1", "/w", "abc1234")).toEqual({ host: "h1", dir: "/w", commit: "abc1234" });
  });

  test("an unknown commit is ABSENT, never a placeholder", () => {
    // A checkout has no installed sha. An absent field claims nothing, and a
    // made-up one would be read by a peer as a fact about which code is running.
    expect(originOf("h1", "/w")).toEqual({ host: "h1", dir: "/w" });
    expect(originOf("h1", "/w", "")).toEqual({ host: "h1", dir: "/w" });
  });

  test("THE RUNTIME AND THE SESSION come out of the environment, and are never guessed", () => {
    // The operator: "Scramble should store the agent runtime, work dir and
    // session ids for each agent in case of a system restart or crash." A host
    // and a directory survive a crash on their own. The session id says which
    // conversation was interrupted, and nobody can reconstruct it once the
    // process is gone.
    const claude = runtimeOf((n) =>
      ({
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "6a41d6cd-13fa-430a-954b-69132f9d5a5c",
        CLAUDE_PID: "14027",
        AI_AGENT: "claude-code_2-1-234_agent",
      })[n],
    );
    expect(claude).toEqual({
      name: "claude-code",
      version: "2.1.234",
      session: "6a41d6cd-13fa-430a-954b-69132f9d5a5c",
      pid: "14027",
    });
    // An akari worker names its instance.
    expect(runtimeOf((n) => ({ AKARI_INSTANCE_ID: "lane-3", AKARI_BUILD_COMMIT: "9291bdd" })[n])).toEqual({
      name: "akari",
      version: "9291bdd",
      session: "lane-3",
    });
    // A runtime this code has never heard of publishes itself through the
    // override, so a new harness needs no change here.
    expect(runtimeOf((n) => ({ SCRAMBLE_RUNTIME: "hark", SCRAMBLE_SESSION_ID: "s-9" })[n])).toEqual({
      name: "hark",
      session: "s-9",
    });
    // AN ENVIRONMENT THAT NAMES NOTHING YIELDS NOTHING. A guessed runtime would
    // be read as fact by every peer and by whoever is restarting the fleet.
    expect(runtimeOf(() => undefined)).toBeUndefined();
    expect(runtimeOf(() => "")).toBeUndefined();
    // A version that is not a version is left out, and the name still arrives.
    expect(runtimeOf((n) => ({ CLAUDECODE: "1", AI_AGENT: "claude-code_dev_agent" })[n])).toEqual({
      name: "claude-code",
    });
    // NO SECRET IS RECORDED. The messaging token sits beside these variables.
    const withToken = runtimeOf((n) =>
      ({ CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_TOKEN: "ced8f224523aa8846bccadaecd5a769f" })[n],
    );
    expect(JSON.stringify(withToken)).not.toContain("ced8f224");
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

  test("the runtime and the session round trip on the message", () => {
    // A peer learns where an agent runs from a message that agent sent, so the
    // session id has to ride the same way the host does. Slack's payload holds
    // strings, and the runtime rides as flat keys.
    expect(originMetadata(RUNNING).event_payload).toEqual({
      host: "host-two",
      dir: "/srv/dev-work",
      commit: "abc1234",
      runtime: "claude-code",
      runtime_version: "2.1.234",
      session: "6a41d6cd",
      pid: "14027",
    });
    expect(readOrigin(originMetadata(RUNNING))).toEqual(RUNNING);
    // A SESSION WITH NO RUNTIME NAME IS NO RUNTIME. Two runtimes' ids look alike
    // and mean different things, so the name is what makes the id readable.
    expect(
      readOrigin({ event_type: ORIGIN_METADATA_TYPE, event_payload: { host: "h", dir: "/w", session: "s1" } }),
    ).toEqual({ host: "h", dir: "/w" });
    // A partial runtime keeps what it has.
    expect(
      readOrigin({ event_type: ORIGIN_METADATA_TYPE, event_payload: { host: "h", dir: "/w", runtime: "akari" } }),
    ).toEqual({ host: "h", dir: "/w", runtime: { name: "akari" } });
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

  test("A NEW SESSION IS NEWS, so a restart does not leave a dead session on the record", () => {
    // The record exists for a crash: the row has to name the session that is
    // alive now. A key of host, dir and commit kept the FIRST session an agent
    // ever published and dropped every later one, so the file pointed at a
    // session that had died.
    const p = peersPath(join(scratch(), "slack.json"));
    expect(recordPeer(p, "dev", RUNNING, "2026-08-28T10:00:00Z")).toBe(true);
    expect(recordPeer(p, "dev", RUNNING, "2026-08-28T10:01:00Z")).toBe(false);
    const restarted: Origin = { ...RUNNING, runtime: { ...RUNNING.runtime!, session: "b71d0e2", pid: "22110" } };
    expect(recordPeer(p, "dev", restarted, "2026-08-28T10:02:00Z")).toBe(true);
    expect(currentPeers(readPeers(p))[0]?.runtime).toEqual({
      name: "claude-code",
      version: "2.1.234",
      session: "b71d0e2",
      pid: "22110",
    });
    // The dead session stays on the record, which is what makes "which session
    // was it before the crash" answerable.
    expect(readPeers(p).map((r) => r.runtime?.session)).toEqual(["6a41d6cd", "b71d0e2"]);
    // The comparison reads fields, and a row from disk lists its keys in another
    // order than a fresh origin does.
    expect(sameOrigin(readPeers(p)[1]!, restarted)).toBe(true);
    expect(sameOrigin(readPeers(p)[0]!, restarted)).toBe(false);
  });

  test("ONE AGENT, ONE ROW: the name it publishes beats the name a line arrived under", () => {
    // A delivered line names its sender by Slack handle and an agent's own row
    // names itself by scramble name, and those differ: one agent held two rows
    // carrying the same host, directory, commit and session, one under
    // `model_failure_researc` and one under `model-failure-research`. The agent it
    // belongs to is the authority on which name is its own.
    const p = peersPath(join(scratch(), "slack.json"));
    // The row it wrote about itself.
    expect(recordPeer(p, "model-failure-research", { ...RUNNING, agent: "model-failure-research" }, "t1")).toBe(true);
    // A message from it, arriving under its Slack handle, carrying the same name.
    expect(
      recordPeer(p, "model_failure_researc", { ...RUNNING, agent: "model-failure-research" }, "t2"),
    ).toBe(true);
    expect(currentPeers(readPeers(p)).map((r) => r.agent)).toEqual(["model-failure-research"]);
    // The handle it arrived under is kept on the row, which is what retires a row
    // written under that handle before agents published their names.
    const withHandle = peersPath(join(scratch(), "slack.json"));
    expect(recordPeer(withHandle, "model_failure_researc", RUNNING, "t0")).toBe(true);
    expect(
      recordPeer(withHandle, "model_failure_researc", { ...RUNNING, agent: "model-failure-research" }, "t1"),
    ).toBe(true);
    expect(currentPeers(readPeers(withHandle)).map((r) => r.agent)).toEqual(["model-failure-research"]);
    // Both rows stay in the file: the record of what was seen is never rewritten.
    expect(readPeers(withHandle)).toHaveLength(2);
  });

  test("A DAMAGED LINE IS COUNTED AND NAMED, and the rows around it survive", () => {
    // Six agents append to one file on a shared filesystem. An agent reported a
    // line no parser could read there, along with EIO on the write, and every
    // reader had been stepping over that line in silence: the surface said
    // `here are the peers` and never `one line of the record is damaged`.
    const dir = scratch();
    const p = join(dir, "peers.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      p,
      `${JSON.stringify({ agent: "ana", host: "h", dir: "/w", at: "t1" })}\n` +
        `{"agent":"bo","host":"h","di\n` +
        `{"agent":"cy"}\n` +
        `${JSON.stringify({ agent: "zed", host: "h", dir: "/w", at: "t2" })}\n`,
    );
    const read = readPeerFile(p);
    expect(read.rows.map((r) => r.agent)).toEqual(["ana", "zed"]);
    expect(read.damaged).toBe(2);
    // The count reaches the reader, in both shapes of the report.
    expect(peersReport(read.rows, HERE, false, read.damaged)).toContain("2 line(s) in the record could not be parsed");
    expect(peersReport([], HERE, false, read.damaged)).toContain("2 line(s) in the record could not be parsed");
    // A clean file says nothing about damage.
    expect(peersReport(read.rows, HERE, false, 0)).not.toContain("could not be parsed");
  });

  test("CONCURRENT WRITERS EACH LAND ONE ROW, and no line is torn", async () => {
    // The read that decides whether to write sat outside any lock, so two agents
    // starting together each wrote the row the other was about to write, and two
    // appends at once on a network filesystem tear a line. This is the lock
    // status.json and the inbox ledger already use.
    const p = peersPath(join(scratch(), "slack.json"));
    const writers = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() =>
        recordPeer(p, `agent-${i}`, { host: "h", dir: "/w", commit: "abc1234", agent: `agent-${i}` }, `t${i}`),
      ),
    );
    expect((await Promise.all(writers)).filter(Boolean)).toHaveLength(8);
    const read = readPeerFile(p);
    expect(read.damaged).toBe(0);
    expect(read.rows).toHaveLength(8);
    // And a repeat from every one of them adds nothing.
    for (let i = 0; i < 8; i += 1) {
      expect(recordPeer(p, `agent-${i}`, { host: "h", dir: "/w", commit: "abc1234", agent: `agent-${i}` }, "t9")).toBe(
        false,
      );
    }
    expect(readPeerFile(p).rows).toHaveLength(8);
  });

  test("EACH WRITER OWNS ITS FILE, and the reader merges every one it finds", () => {
    // Six agents shared one file on a host whose filesystem stalled under an
    // orphaned `du` walking 1.3PB for 81 hours: writes returned EIO, eight
    // processes sat in D-state, and the shared file ended with a line no parser
    // could read. A lock degrades on that filesystem, since `withFileLock` breaks
    // a lock it cannot take within a second and writes anyway. A writer that owns
    // its file needs no agreement with anybody.
    const cfg = join(scratch(), "slack.json");
    const p = peersPath(cfg);
    expect(recordPeer(p, "ana", { host: "h", dir: "/a", agent: "ana" }, "2026-08-28T01:00:00Z")).toBe(true);
    expect(recordPeer(p, "bo", { host: "h", dir: "/b", agent: "bo" }, "2026-08-28T01:00:01Z")).toBe(true);
    // Two files, one per writer, and the shared file untouched by either.
    expect(readdirSync(peersDir(p)).sort()).toEqual(["ana.jsonl", "bo.jsonl"]);
    expect(existsSync(p)).toBe(false);
    // The reader merges them, oldest first, so the newest row per agent wins.
    expect(readPeerFile(p).rows.map((r) => r.agent)).toEqual(["ana", "bo"]);
    // A NAME THAT IS A PATH stays inside the record directory, since an agent name
    // comes from a config a person edits. The property is what matters here: the
    // file sits in peers.d, its name carries no separator and no leading dot.
    for (const name of ["../../etc/passwd", ".hidden", "", "a/b", "..", "with space"]) {
      const file = peerFileFor(cfg, name);
      expect(dirname(file)).toBe(peersDir(cfg));
      const base = file.slice(peersDir(cfg).length + 1);
      expect(base.startsWith(".")).toBe(false);
      expect(base).toMatch(/^[A-Za-z0-9._-]+\.jsonl$/);
    }
  });

  test("THE SHARED FILE IS STILL READ, so no row written before this change is lost", () => {
    const cfg = join(scratch(), "slack.json");
    const p = peersPath(cfg);
    mkdirSync(dirname(p), { recursive: true });
    // What every build wrote up to this change.
    writeFileSync(
      p,
      `${JSON.stringify({ agent: "old", host: "h", dir: "/legacy", at: "2026-08-27T10:00:00Z" })}\n` +
        `{"agent":"torn","ho\n`,
    );
    // And one row from a writer that owns its file, newer than the legacy row.
    expect(recordPeer(p, "old", { host: "h", dir: "/now", agent: "old" }, "2026-08-28T10:00:00Z")).toBe(true);
    const read = readPeerFile(p);
    expect(read.damaged).toBe(1);
    // Newest wins across the two files, and the older row stays readable.
    expect(currentPeers(read.rows).map((r) => r.dir)).toEqual(["/now"]);
    expect(read.rows.map((r) => r.dir)).toEqual(["/legacy", "/now"]);
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

  test("the report names the runtime and the session a restart needs", () => {
    // A host and a directory say where to look. The session id says which
    // conversation was interrupted, and it is the field nobody can reconstruct
    // once the process is gone, so the surface an agent reads has to print it.
    const said = peersReport(
      [{ agent: "ana", ...RUNNING, at: "2026-08-28T10:00:00Z" }],
      HERE,
      false,
    );
    expect(said).toContain("claude-code 2.1.234 session 6a41d6cd pid 14027");
    // A row from a build that published no runtime prints as it always did.
    expect(peersReport(rows, HERE, false)).not.toContain("session");
  });

  test("every peer is named with host, directory and commit", () => {
    const said = peersReport(rows, HERE, false);
    expect(said).toContain("2 peer(s)");
    expect(said).toContain("ana  host-two  /srv/dev-work  (abc1234)");
    expect(said).toContain("bo  DESKTOP-STBCRML  C:\\xingyu-agent");
  });

  test("peersOnOtherCommits names a version disagreement across hosts", () => {
    // THE HOST THAT STOPS UPDATING SENDS NO SIGNAL: the staleness notice
    // compares a listener to the install beside it, so a machine nobody
    // installs on stays quiet while it falls behind. One did, by five commits.
    const rows = [
      { agent: "ana", host: "h2", dir: "/d", commit: "old111", at: "2026-08-26T10:00:00Z" },
      { agent: "bo", host: "h2", dir: "/d", commit: "new222", at: "2026-08-26T11:00:00Z" },
      { agent: "me", host: "h1", dir: "/mine", commit: "old111", at: "2026-08-26T12:00:00Z" },
    ];
    const self: Origin = { host: "h1", dir: "/mine", commit: "new222" };
    const out = peersOnOtherCommits(rows, "new222", self);
    // `ana` differs and is named. `bo` matches. `me` is this very process.
    expect(out.map((r) => r.agent)).toEqual(["ana"]);
    // Newest sighting first when several differ.
    const many = peersOnOtherCommits(
      [...rows, { agent: "cy", host: "h3", dir: "/d", commit: "old111", at: "2026-08-26T13:00:00Z" }],
      "new222",
      self,
    );
    expect(many.map((r) => r.agent)).toEqual(["cy", "ana"]);
    // No installed commit to compare against: no claim.
    expect(peersOnOtherCommits(rows, undefined, self)).toEqual([]);
    expect(peersOnOtherCommits(rows, "", self)).toEqual([]);
  });

  test("a peer on a different commit gets the reader-relative range named", () => {
    // I announced two commits with "both changes touch src/cli.ts", which was
    // MY range. An agent five commits back answered with theirs: 15 files, the
    // delivery path included. A reader on that build who took my sentence at
    // face value would have skipped a restart their build needs.
    const behind = [{ agent: "cy", host: "h", dir: "/d", commit: "0ded7ad", at: "t" }, ...rows];
    const said = peersReport(behind, HERE, false);
    expect(said).toContain("read the range from THEIR commit");
    expect(said).toContain("git diff --stat <their commit>..abc1234");
    // Everybody on this commit: no reminder, since there is no range to read.
    const together = [{ agent: "cy", host: "h", dir: "/d", commit: "abc1234", at: "t" }];
    expect(peersReport(together, HERE, false)).not.toContain("THEIR commit");
    // This build publishes no commit of its own: nothing to compare against.
    expect(peersReport(behind, { host: "h", dir: "/d" }, false)).not.toContain("THEIR commit");
  });

  test("--same-dir matches HOST AND directory, never the path alone", () => {
    // Two agents measured the SAME absolute path on two machines, backed by
    // different filesystems, and could not see each other's files. Grouping by
    // path would have told them they shared a directory when they shared a
    // string.
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
    // says what it knows about others, where filtering would need a guess.
    expect(peersReport(rows, undefined, true)).toContain("2 peer(s)");
  });
});
