import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoomStore } from "../src/store";
import { createStore } from "../src/store";
import { createHandler } from "../src/server";
import { main, selectBackend, type Io } from "../src/cli";
import { RaftBackend, toTarget, roomFromTarget, parseDelivery, type RunResult, type RunFn } from "../src/raft";

// --- test scaffolding --------------------------------

function scratchDir(name: string): string {
  const d = join(tmpdir(), `raft-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

/** A fake raft process: records every (cmd,args,stdin) and answers from the
 *  queues the test seeds, one response per `check`/`send`/`read` call. */
function fakeRaft(...results: RunResult[]): { run: RunFn; calls: Array<{ cmd: string; args: string[]; stdin: string }>; callsCount: () => number } {
  const calls: Array<{ cmd: string; args: string[]; stdin: string }> = [];
  const run: RunFn = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    const i = calls.length - 1;
    // Exhausted calls answer with an empty success, so poll loops keep running.
    return i < results.length ? results[i]! : { exit: 0, stdout: "", stderr: "" };
  };
  return { run, calls, callsCount: () => calls.length };
}

function raftIo(cwd: string, run: RunFn): { io: Io; writes: string[]; errs: string[] } {
  const writes: string[] = [];
  const errs: string[] = [];
  const io: Io = {
    write: (l) => writes.push(l),
    writeErr: (l) => errs.push(l),
    fetch: async () => {
      throw new Error("raft mode must not fetch");
    },
    env: () => undefined,
    cwd: () => cwd,
    sleep: async () => {},
    serve: async () => 0,
    createTransport: () => ({ connect: () => {}, postMessage: async () => {} }),
    run,
  };
  return { io, writes, errs };
}

/** A local-daemon io for equivalence: route every fetch to a real in-memory
 *  handler backed by scratchDir, like the existing cli tests. */
function localIo(cwd: string, store?: RoomStore): { io: Io; writes: string[]; errs: string[] } {
  const writes: string[] = [];
  const errs: string[] = [];
  const handler = createHandler(store ?? createStore(scratchDir("local")));
  const io: Io = {
    write: (l) => writes.push(l),
    writeErr: (l) => errs.push(l),
    fetch: async (input, init) => handler(new Request(input, init)),
    env: () => undefined,
    cwd: () => cwd,
    sleep: async () => {},
    serve: async () => 0,
    createTransport: () => ({ connect: () => {}, postMessage: async () => {} }),
  };
  return { io, writes, errs };
}

// --- unit tests against the raft backend ---------------

describe("toTarget / roomFromTarget", () => {
  test("a group room maps to #room", () => {
    expect(toTarget("general", "ana")).toBe("#general");
    expect(toTarget("engineering", "bob")).toBe("#engineering");
  });

  test("a dm/ room maps to the peer other than the actor", () => {
    expect(toTarget("dm/ana/bob", "ana")).toBe("dm:@bob");
    expect(toTarget("dm/ana/bob", "bob")).toBe("dm:@ana");
  });

  test("a dm/ room with a single peer maps to the peer", () => {
    expect(toTarget("dm/ana/", "ana")).toBe("dm:@ana");
  });

  test("roomFromTarget round-trips a channel and a dm", () => {
    expect(roomFromTarget("#general", "ana")).toBe("general");
    expect(roomFromTarget("dm:@bob", "ana")).toBe("dm/ana/bob");
  });
});

describe("parseDelivery", () => {
  test("parses a channel line into a Delivery with a computed mentioned flag", () => {
    const line = JSON.stringify({ channel: "#general", text: "@ana check", from: "bob" });
    const d = parseDelivery(line, "ana", 7);
    expect(typeof d).not.toBe("string");
    if (typeof d !== "string") {
      expect(d.room).toBe("general");
      expect(d.from).toBe("bob");
      expect(d.mentioned).toBe(true);
      expect(d.mentions).toContain("ana");
      expect(d.seq).toBe(7);
    }
  });

  test("a dm line is mentioned by construction", () => {
    const line = JSON.stringify({ target: "dm:@bob", text: "hello", from: "bob" });
    const d = parseDelivery(line, "ana", 2);
    expect(typeof d).not.toBe("string");
    if (typeof d !== "string") {
      expect(d.room).toBe("dm/ana/bob");
      expect(d.mentioned).toBe(true);
    }
  });

  test("an unparseable line is REPORTED, not dropped", () => {
    expect(parseDelivery("not json at all", "ana", 1)).toBe("not json at all");
    expect(parseDelivery("", "ana", 1)).toBe("");
  });

  test("a line missing a text or channel is REPORTED", () => {
    expect(parseDelivery(JSON.stringify({ from: "bob" }), "ana", 1)).toContain("{");
  });
});

describe("raft send/drain/next/listen backend", () => {
  test("drain parses lines into deliveries and reports unparseable ones", async () => {
    const { run } = fakeRaft({
      exit: 0,
      stdout: [
        JSON.stringify({ channel: "#room", text: "hey @ana", from: "bob" }),
        "this is not json",
      ].join("\n"),
      stderr: "",
    });
    const b = new RaftBackend({ run });
    const d = await b.drain("ana");
    expect(d.deliveries.length).toBe(1);
    expect(d.deliveries[0]!.mentioned).toBe(true);
    expect(d.problems).toEqual(["this is not json"]);
  });

  test("a failed check surfaces as a reported problem", async () => {
    const { run } = fakeRaft({ exit: 1, stdout: "", stderr: "boom" });
    const b = new RaftBackend({ run });
    const d = await b.drain("ana");
    expect(d.deliveries).toHaveLength(0);
    expect(d.problems[0]).toContain("boom");
  });

  test("post failure is surfaced, never swallowed", async () => {
    const { run } = fakeRaft({ exit: 1, stdout: "", stderr: "nope" });
    const b = new RaftBackend({ run });
    const r = await b.send("general", "hi", "ana");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nope");
  });

  test("next returns on the first message", async () => {
    const { run } = fakeRaft({
      exit: 0,
      stdout: JSON.stringify({ channel: "#room", text: "@ana hey", from: "bob" }),
      stderr: "",
    });
    const b = new RaftBackend({ run, now: () => 0, sleep: async () => {} });
    const r = await b.next("ana", 5);
    expect(r.code).toBe(0);
    expect(r.line!.mentioned).toBe(true);
    expect(r.problems).toEqual([]);
  });

  test("next hits the timeout with nothing to report", async () => {
    const { run } = fakeRaft({ exit: 0, stdout: "", stderr: "" });
    const b = new RaftBackend({ run, now: () => 0, sleep: async () => {} });
    const r = await b.next("ana", 0);
    expect(r.code).toBe(64);
    expect(r.line).toBeUndefined();
  });

  test("listen emits deliveries as they arrive", async () => {
    let n = 0;
    const run2: RunFn = async () => {
      n++;
      if (n === 1) return { exit: 0, stdout: JSON.stringify({ channel: "#room", text: "one", from: "bob" }), stderr: "" };
      return { exit: 0, stdout: "", stderr: "" };
    };
    const b = new RaftBackend({ run: run2, maxPolls: 2, sleep: async () => {} });
    const lines: string[] = [];
    const problems: string[] = [];
    await b.listen("ana", (d) => lines.push(d.text), (p) => problems.push(p));
    expect(lines).toEqual(["one"]);
    expect(problems).toEqual([]);
  });

  test("history returns messages and surfaces errors", async () => {
    const { run } = fakeRaft({
      exit: 0,
      stdout: JSON.stringify({ channel: "#room", text: "one", from: "bob" }),
      stderr: "",
    });
    const b = new RaftBackend({ run });
    const ok = await b.history("room", "ana");
    expect(ok.code).toBe(0);
    expect(ok.messages).toHaveLength(1);
    expect(ok.messages[0]!.text).toBe("one");
    const bad = fakeRaft({ exit: 1, stdout: "", stderr: "gone" });
    const r2 = await new RaftBackend({ run: bad.run }).history("room", "ana");
    expect(r2.code).toBe(1);
    expect(r2.error).toContain("gone");
  });
});

// --- equivalence through main(): raft vs local daemon -----------------

describe("backend equivalence through main()", () => {
  test("post exits 0 with no stdout under both backends", async () => {
    const cwd = scratchDir("eq-post");
    // raft
    const { run } = fakeRaft({ exit: 0, stdout: "ack", stderr: "" });
    const r = raftIo(cwd, run);
    const rcode = await main(["post", "general", "hi", "--as", "ana", "--backend", "raft"], r.io);
    expect(rcode).toBe(0);
    expect(r.writes).toHaveLength(0);
    // local
    const l = localIo(cwd);
    const lcode = await main(["post", "general", "hi", "--as", "ana"], l.io);
    expect(lcode).toBe(0);
    expect(l.writes).toHaveLength(0);
  });

  test("history prints the same message bodies under both backends", async () => {
    const cwd = scratchDir("eq-hist");
    // local: seed the store with one message
    const store = createStore(scratchDir("eq-store"));
    await createHandler(store)(
      new Request("http://x/rooms/general", { method: "POST", body: JSON.stringify({ from: "bob", text: "one", id: "i1" }) }),
    );
    const l = localIo(cwd, store);
    const lcode = await main(["history", "general"], l.io);
    expect(lcode).toBe(0);
    expect(JSON.parse(l.writes[0]!)).toMatchObject({ from: "bob", text: "one" });
    // raft: the same conversation over a fake raft response
    const { run } = fakeRaft({
      exit: 0,
      stdout: JSON.stringify({ channel: "#general", text: "one", from: "bob" }),
      stderr: "",
    });
    const r = raftIo(cwd, run);
    const rcode = await main(["history", "general", "--as", "ana", "--backend", "raft"], r.io);
    expect(rcode).toBe(0);
    expect(rcode).toBe(lcode);
    expect(r.writes).toHaveLength(1);
    // identical conversational identity — ts/id/seq are transport-local in raft
    expect(JSON.parse(r.writes[0]!)).toMatchObject({ from: "bob", text: "one", room: "general" });
    expect(JSON.parse(l.writes[0]!)).toMatchObject({ from: "bob", text: "one", room: "general" });
  });

  test("next returns on the first message under both backends", async () => {
    const cwd = scratchDir("eq-next");
    // local: a post arrives and next returns it
    const store = createStore(scratchDir("eq-next-store"));
    const handler = createHandler(store);
    const l = localIo(cwd, store);
    l.io.sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
    const pending = main(["next", "general", "--as", "ana", "--timeout", "5"], l.io);
    await new Promise((r) => setTimeout(r, 20));
    await handler(new Request("http://x/rooms/general", { method: "POST", body: JSON.stringify({ from: "bob", text: "hey", id: "n" }) }));
    const lcode = await pending;
    expect(lcode).toBe(0);
    expect(JSON.parse(l.writes[0]!)).toMatchObject({ from: "bob", text: "hey" });
    // raft: a fake check returns the message
    const { run } = fakeRaft({
      exit: 0,
      stdout: JSON.stringify({ channel: "#general", text: "hey", from: "bob" }),
      stderr: "",
    });
    const r = raftIo(cwd, run);
    const rcode = await main(["next", "--as", "ana", "--timeout", "5", "--backend", "raft"], r.io);
    expect(rcode).toBe(0);
    expect(r.writes).toHaveLength(1);
    expect(JSON.parse(r.writes[0]!)).toMatchObject({ from: "bob", text: "hey" });
  });
});

describe("raft through main()", () => {
  test("a dm/ room post targets dm:@peer with the text on stdin", async () => {
    const cwd = scratchDir("raft-dm");
    const { run, calls } = fakeRaft({ exit: 0, stdout: "ok", stderr: "" });
    const { io } = raftIo(cwd, run);
    const code = await main(["post", "dm/ana/bob", "hello bob", "--as", "ana", "--backend", "raft"], io);
    expect(code).toBe(0);
    expect(calls[0]!.args).toEqual(["message", "send", "--target", "dm:@bob"]);
    expect(calls[0]!.stdin).toBe("hello bob");
  });

  test("a failure exit surfaces what raft printed", async () => {
    const cwd = scratchDir("raft-fail");
    const { run } = fakeRaft({ exit: 1, stdout: "", stderr: "credential expired" });
    const { io, errs } = raftIo(cwd, run);
    const code = await main(["post", "general", "hi", "--as", "ana", "--backend", "raft"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("credential expired");
  });

  test("an unparseable line is reported on stderr by next", async () => {
    const cwd = scratchDir("raft-unparse");
    const { run } = fakeRaft({ exit: 0, stdout: "nonsense line", stderr: "" });
    const { io, errs } = raftIo(cwd, run);
    const code = await main(["next", "--as", "ana", "--backend", "raft", "--timeout", "1"], io);
    expect(code).toBe(64);
    expect(errs.some((l) => l.includes("nonsense line"))).toBe(true);
  });

  test("next times out with exit 64", async () => {
    const cwd = scratchDir("raft-timeout");
    const { run } = fakeRaft({ exit: 0, stdout: "", stderr: "" });
    const { io } = raftIo(cwd, run);
    const code = await main(["next", "--as", "ana", "--backend", "raft", "--timeout", "0"], io);
    expect(code).toBe(64);
  });

  test("listen emits lines and stops when max-polls bounds it", async () => {
    const cwd = scratchDir("raft-listen");
    const { run } = fakeRaft({
      exit: 0,
      stdout: JSON.stringify({ channel: "#room", text: "ping", from: "bob" }),
      stderr: "",
    });
    const { io, writes } = raftIo(cwd, run);
    const code = await main(["listen", "--as", "ana", "--backend", "raft", "--max-polls", "1"], io);
    expect(code).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ from: "bob", text: "ping" });
  });

  test("listen reports an unparseable line via its problem callback", async () => {
    const cwd = scratchDir("raft-listen-problem");
    const { run } = fakeRaft({ exit: 0, stdout: "garbage from raft", stderr: "" });
    const { io, errs } = raftIo(cwd, run);
    const code = await main(["listen", "--as", "ana", "--backend", "raft", "--max-polls", "1"], io);
    expect(code).toBe(0);
    expect(errs.some((l) => l.includes("garbage from raft"))).toBe(true);
  });

  test("--backend raft via SCRAMBLE_BACKEND env is honored", async () => {
    const cwd = scratchDir("raft-env");
    const { run } = fakeRaft({ exit: 0, stdout: "ok", stderr: "" });
    const { io } = raftIo(cwd, run);
    io.env = (n) => (n === "SCRAMBLE_BACKEND" ? "raft" : n === "RAFT_PROFILE" ? "dev" : undefined);
    const code = await main(["post", "general", "hi", "--as", "ana"], io);
    expect(code).toBe(0);
  });

  test("--profile is passed to the raft verb", async () => {
    const cwd = scratchDir("raft-profile");
    const { run, calls } = fakeRaft({ exit: 0, stdout: "ok", stderr: "" });
    const { io } = raftIo(cwd, run);
    const code = await main(["post", "general", "hi", "--as", "ana", "--backend", "raft", "--profile", "work"], io);
    expect(code).toBe(0);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["--profile", "work"]);
  });

  test("a raft post with no text is a usage error", async () => {
    const cwd = scratchDir("raft-post-usage");
    const { run } = fakeRaft({ exit: 0, stdout: "", stderr: "" });
    const { io, errs } = raftIo(cwd, run);
    const code = await main(["post", "general", "--backend", "raft"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("usage");
  });

  test("a raft history with no room is an error", async () => {
    const cwd = scratchDir("raft-hist-usage");
    const { run } = fakeRaft({ exit: 0, stdout: "", stderr: "" });
    const { io, errs } = raftIo(cwd, run);
    const code = await main(["history", "--backend", "raft"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("room");
  });

  test("a raft history failure surfaces the raft error", async () => {
    const cwd = scratchDir("raft-hist-fail");
    const { run } = fakeRaft({ exit: 1, stdout: "", stderr: "no such channel" });
    const { io, errs } = raftIo(cwd, run);
    const code = await main(["history", "general", "--as", "ana", "--backend", "raft"], io);
    expect(code).toBe(1);
    expect(errs.some((l) => l.includes("no such channel"))).toBe(true);
  });
});

// --- the mirrored raft grammar through main() ---------------------------
describe("mirrored raft grammar", () => {
  test("message send --target pipes stdin to raft and exits 0", async () => {
    const cwd = scratchDir("mirror-send");
    const { run, calls } = fakeRaft({ exit: 0, stdout: "ok", stderr: "" });
    const { io } = raftIo(cwd, run);
    io.readStdin = async () => "hello from stdin";
    const code = await main(["message", "send", "--target", "general", "--as", "ana", "--backend", "raft"], io);
    expect(code).toBe(0);
    expect(calls[0]!.args).toEqual(["message", "send", "--target", "#general"]);
    expect(calls[0]!.stdin).toBe("hello from stdin");
  });

  test("message check drains raft deliveries", async () => {
    const cwd = scratchDir("mirror-check");
    const { run } = fakeRaft({
      exit: 0,
      stdout: JSON.stringify({ channel: "#room", text: "@ana ping", from: "bob" }),
      stderr: "",
    });
    const { io, writes } = raftIo(cwd, run);
    const code = await main(["message", "check", "--as", "ana", "--backend", "raft"], io);
    expect(code).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ from: "bob", text: "@ana ping", mentioned: true });
  });

  test("message read --after passes the cursor to raft and prints deliveries", async () => {
    const cwd = scratchDir("mirror-read");
    const { run, calls } = fakeRaft({
      exit: 0,
      stdout: JSON.stringify({ channel: "#general", text: "one", from: "bob" }),
      stderr: "",
    });
    const { io, writes } = raftIo(cwd, run);
    const code = await main(["message", "read", "--target", "general", "--after", "3", "--as", "ana", "--backend", "raft"], io);
    expect(code).toBe(0);
    expect(calls[0]!.args).toEqual(["message", "read", "--target", "#general", "--after", "3"]);
    expect(JSON.parse(writes[0]!)).toMatchObject({ from: "bob", text: "one", room: "general" });
  });

  test("message read surfaces a raft failure", async () => {
    const cwd = scratchDir("mirror-read-fail");
    const { run } = fakeRaft({ exit: 1, stdout: "", stderr: "gone" });
    const { io, errs } = raftIo(cwd, run);
    const code = await main(["message", "read", "--target", "general", "--backend", "raft"], io);
    expect(code).toBe(1);
    expect(errs.some((l) => l.includes("gone"))).toBe(true);
  });
});

describe("selectBackend", () => {
  function ioWithEnv(env: string | undefined): Io {
    return {
      write: () => {},
      writeErr: () => {},
      fetch: async () => new Response("[]", { status: 200 }),
      env: (n) => (n === "SCRAMBLE_BACKEND" ? env : undefined),
      cwd: () => "/tmp",
      sleep: async () => {},
      serve: async () => 0,
      createTransport: () => ({ connect: () => {}, postMessage: async () => {} }),
    };
  }

  test("--backend raft (space form) selects raft", () => {
    expect(selectBackend(["post", "--backend", "raft", "general"], ioWithEnv(undefined))).toBe("raft");
  });

  test("--backend local overrides raft env", () => {
    expect(selectBackend(["post", "--backend", "local"], ioWithEnv("raft"))).toBe("local");
  });

  test("--backend=local equals form selects local", () => {
    expect(selectBackend(["--backend=local"], ioWithEnv(undefined))).toBe("local");
  });

  test("--backend=raft selects raft", () => {
    expect(selectBackend(["--backend=raft"], ioWithEnv(undefined))).toBe("raft");
  });

  test("defaults to local when nothing selects raft", () => {
    expect(selectBackend(["post", "room", "text"], ioWithEnv(undefined))).toBe("local");
  });

  test("SCRAMBLE_BACKEND=raft selects raft without a flag", () => {
    expect(selectBackend(["post", "room", "text"], ioWithEnv("raft"))).toBe("raft");
  });

  test("unknown --backend values are treated as raft (a toggle, not a deny)", () => {
    expect(selectBackend(["post", "--backend", "else"], ioWithEnv(undefined))).toBe("raft");
  });
});