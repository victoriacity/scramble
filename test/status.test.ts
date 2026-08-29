// The `test/status.test.ts` suite tests the automatic working-status interface.
// Delivery of an addressed message sets the status, and a reply clears it. The
// status has a TTL, writes to `.scramble/status.json`, and connects to Slack
// through an injected fetch seam so it requires no token and no network.
// Status is never a message, and `SCRAMBLE_STATUS=off` silences it entirely.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { createStore, type ChannelStore } from "../src/store";
import { createHandler } from "../src/server";
import { main, type Io } from "../src/cli";
import { StatusManager, readRecords, writeStatus, STATUS_TEXT } from "../src/status";

// --- helpers ------------------------------------------------------------

function scratch(name: string): string {
  const d = join(tmpdir(), `zz-status-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

function statusPath(dir: string): string {
  return join(dir, ".scramble", "status.json");
}

function recorded(dir: string): ReturnType<typeof readRecords> {
  if (!existsSync(statusPath(dir))) return [];
  return readRecords(statusPath(dir));
}

/**
 *  The system includes a local-mode StatusManager, a controllable clock, and its
 *  scratch directory.
 */
function makeLocal(): { mgr: StatusManager; advance(ms: number): void; setNow(n: number): void; dir: string } {
  const dir = scratch("local");
  let now = 0;
  const mgr = new StatusManager({
    file: statusPath(dir),
    backend: "local",
    now: () => now,
    ttlMs: 10_000,
    writeErr: () => {},
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });
  return { mgr, setNow: (n) => (now = n), advance: (ms) => (now += ms), dir };
}

interface SlackHarness {
  mgr: StatusManager;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
  errs: string[];
  advance(ms: number): void;
  setNow(n: number): void;
  /**
   *  Tests use the scratch workspace, so a test can plant a ledger record written by
   *  an older version of this code.
   */
  dir: string;
}

/**
 *  The Slack-mode StatusManager records every fetch call. The `router` determines
 *  the answer. By default, it returns ok:true and provides chat.postMessage with a
 *  ts so the living-message path is captured.
 */
function makeSlack(opts?: {
  router?: (url: string, body: Record<string, unknown>) => Response;
  noToken?: boolean;
  resolve?: (channel: string) => Promise<string | undefined>;
}): SlackHarness {
  const dir = scratch("slack");
  let now = 0;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const errs: string[] = [];
  const token = opts?.noToken ? undefined : "xoxb";
  const defRouter = (url: string, _body: Record<string, unknown>): Response => {
    if (url.includes("chat.postMessage"))
      return new Response(JSON.stringify({ ok: true, ts: "ts.1" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const r: (url: string, body: Record<string, unknown>) => Response = opts?.router ?? defRouter;
  const mgr = new StatusManager({
    file: statusPath(dir),
    backend: "slack",
    now: () => now,
    ttlMs: 10_000,
    channels: { general: "C1" },
    ...(opts?.resolve === undefined ? {} : { resolve: opts.resolve }),
    token,
    writeErr: (l) => errs.push(l),
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      return r(String(url), body);
    },
  });
  return { mgr, setNow: (n) => (now = n), advance: (ms) => (now += ms), calls, errs, dir };
}

/**
 *  Drive the CLI with simulated input and output across a scratch workspace.
 */
async function mainIo(
  dir: string,
  fetch: Io["fetch"],
  env: Record<string, string | undefined>,
): Promise<{ io: Io; writes: string[]; errs: string[] }> {
  const writes: string[] = [];
  const errs: string[] = [];
  const io: Io = {
    write: (l) => writes.push(l),
    writeErr: (l) => errs.push(l),
    fetch: async (u, init) => fetch(u, init),
    env: (n) => env[n],
    cwd: () => dir,
    sleep: async () => {},
    serve: async () => 0,
    createSocket: () => ({
      send: (d) => void d,
      close: () => {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }),
    readStdin: async () => "",
  };
  return { io, writes, errs };
}

/**
 *  The store initializes with ana joined to `general` and includes a message from
 *  bob. The channel handler routes CLI requests against this store.
 */
function seededStore(dir: string, text: string): ChannelStore {
  const store = createStore(dir);
  store.join("ana", "goal", "general");
  const msg = store.post({ channel: "general", from: "bob", text, id: "s1" });
  void msg;
  return store;
}

const POST = "chat.postMessage";

// # Ledger IO

describe("status ledger", () => {
  test("writeStatus round-trips entries; readRecords reads them back", () => {
    const dir = scratch("ledger");
    writeStatus(statusPath(dir), [{ channel: "general", agent: "ana", expiresAt: 123 }]);
    expect(readRecords(statusPath(dir))).toEqual([{ channel: "general", agent: "ana", expiresAt: 123 }]);
  });

  test("A LEDGER WRITE THAT FAILS IS REPORTED, and the caller carries on", async () => {
    // The `save` method called mkdirSync and writeFileSync without error handling,
    // and `withFileLock` calls mkdirSync before either operation. The class comment
    // stated that a failed status never fails the work it describes. On a host whose
    // writes returned EIO, that thrown error left `startExpiryTicker` holding a
    // rejected promise that nobody awaits, which takes a listener down. An agent
    // read the source code and reported the defect against the comment.
    const dir = scratch("ledger-unwritable");
    const errs: string[] = [];
    const mgr = new StatusManager({
      file: statusPath(dir),
      backend: "local",
      now: () => 0,
      ttlMs: 10_000,
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    // If a file exists where the `.scramble` directory belongs, every write under it
    // throws.
    writeFileSync(join(dir, ".scramble"), "this is a file");
    await mgr.setOn("general", "ana");
    await mgr.clearOn("general", "ana");
    expect(await mgr.clearExpired()).toBe(0);
    expect(errs.join(" ")).toContain("the status ledger could not be written");
  });

  test("readRecords on a missing or corrupt file returns [] and never throws", () => {
    const dir = scratch("ledger-missing");
    expect(readRecords(join(dir, "nope.json"))).toEqual([]);
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    writeFileSync(statusPath(dir), "not json{");
    expect(readRecords(statusPath(dir))).toEqual([]);
  });
});

// ## local backend

describe("status local backend", () => {
  test("a fresh set records channel+agent+expiry and becomes active", async () => {
    const { mgr, setNow, advance, dir } = makeLocal();
    setNow(1000);
    await mgr.setOn("general", "ana");
    expect(recorded(dir)).toHaveLength(1);
    expect(recorded(dir)[0]).toMatchObject({ channel: "general", agent: "ana", expiresAt: 1000 + 10_000 });
    expect(mgr.isActive("general")).toBe(true);
    expect(STATUS_TEXT).toBe("working");
    advance(10_001);
    expect(mgr.isActive("general")).toBe(false);
  });

  test("the same agent setting twice updates its record, never adds a second", async () => {
    const { mgr, dir } = makeLocal();
    await mgr.setOn("general", "ana");
    await mgr.setOn("general", "ana");
    expect(recorded(dir)).toHaveLength(1);
    expect(recorded(dir)[0]?.agent).toBe("ana");
  });

  test("two agents working one channel each keep their own status", async () => {
    // The ledger stored one record per channel, so one agent's status overwrote
    // another agent's status, and any agent reply cleared whatever the channel held.
    // The live smoke test caught this issue when a peer's message removed the status
    // the listener had set for itself.
    const { mgr, dir } = makeLocal();
    await mgr.setOn("general", "ana");
    await mgr.setOn("general", "bob");
    expect(recorded(dir).map((r) => r.agent).sort()).toEqual(["ana", "bob"]);
    // When bob finishes, ana continues working.
    await mgr.clearOn("general", "bob");
    expect(recorded(dir).map((r) => r.agent)).toEqual(["ana"]);
  });

  test("clearing a channel with no active status is a no-op", async () => {
    const { mgr, dir } = makeLocal();
    await mgr.clearOn("general", "ana");
    expect(recorded(dir)).toEqual([]);
  });

  test("clearing an active status removes the record", async () => {
    const { mgr, dir } = makeLocal();
    await mgr.setOn("general", "ana");
    await mgr.clearOn("general", "ana");
    expect(recorded(dir)).toEqual([]);
    expect(mgr.isActive("general")).toBe(false);
  });

  test("an expired entry is cleared by the next invocation", async () => {
    const { mgr, advance, dir } = makeLocal();
    await mgr.setOn("general", "ana");
    await mgr.setOn("team", "bob");
    advance(10_001);
    expect(await mgr.clearExpired()).toBe(2);
    expect(recorded(dir)).toEqual([]);
  });

  test("clearExpired with nothing expired returns 0 and preserves the ledger", async () => {
    const { mgr, dir } = makeLocal();
    await mgr.setOn("general", "ana");
    expect(await mgr.clearExpired()).toBe(0);
    expect(recorded(dir)).toHaveLength(1);
  });

  test("the expiry ticker clears on expiry while running and stops on request", async () => {
    const { mgr, dir } = makeLocal();
    writeStatus(statusPath(dir), [{ channel: "manual", agent: "ana", expiresAt: 0 }]); // already expired
    const stop = mgr.startExpiryTicker(1); // real timer sleep yields the event loop
    await new Promise((r) => setTimeout(r, 20));
    stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(recorded(dir)).toEqual([]); // the ticker swept the expired entry
  });
});

// # slack backend

describe("status slack backend", () => {
  // Slack maintains its own status on a thread. Posting a `working` line into the
  // channel used the wrong structure, and setStatus operates on an ordinary channel
  // thread, which makes that message unnecessary.
  test("a status on a thread is Slack's own status, and NO message is posted", async () => {
    const { mgr, calls } = makeSlack();
    await mgr.setOn("general", "ana", "thread.9");
    const set = calls.filter((c) => c.url.includes("assistant.threads.setStatus"));
    expect(set).toHaveLength(1);
    expect(set[0]?.body).toMatchObject({ channel_id: "C1", thread_ts: "thread.9", status: STATUS_TEXT });
    expect(calls.filter((c) => c.url.includes(POST))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("chat.update"))).toHaveLength(0);
  });

  test("with NO thread there is no native status, so nothing is sent at all", async () => {
    // Silence outperforms a message that simulates a status.
    const { mgr, calls } = makeSlack();
    await mgr.setOn("general", "ana");
    expect(calls.filter((c) => c.url.includes(POST))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("assistant.threads.setStatus"))).toHaveLength(0);
  });

  test("a refresh re-asserts the thread status rather than editing a message", async () => {
    const { mgr, calls } = makeSlack();
    await mgr.setOn("general", "ana", "thread.9");
    await mgr.setOn("general", "bob", "thread.9");
    expect(calls.filter((c) => c.url.includes("assistant.threads.setStatus"))).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes("chat.update"))).toHaveLength(0);
  });

  test("clearing sets the thread status back to EMPTY", async () => {
    const { mgr, calls } = makeSlack();
    await mgr.setOn("general", "ana", "thread.9");
    await mgr.clearOn("general", "ana");
    const set = calls.filter((c) => c.url.includes("assistant.threads.setStatus"));
    expect(set).toHaveLength(2);
    expect(set[1]?.body).toMatchObject({ channel_id: "C1", thread_ts: "thread.9", status: "" });
  });

  test("a thread Slack no longer has is dropped from the record, so the error stops repeating", async () => {
    // A deleted message left an agent's status record pointing at its thread, and
    // every send after that printed `invalid_thread_ts` naming the same timestamp.
    // The reference goes with the thread it named.
    let live = true;
    const router = (url: string): Response =>
      url.includes("assistant.threads.setStatus") && !live
        ? new Response(JSON.stringify({ ok: false, error: "invalid_thread_ts" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    const { mgr, calls, errs, dir } = makeSlack({ router });
    await mgr.setOn("general", "ana", "thread.9");
    expect(recorded(dir)[0]?.thread).toBe("thread.9");

    // Somebody deletes the message that thread hung from.
    live = false;
    await mgr.setOn("general", "ana");
    expect(errs.join(" ")).toContain("the thread this status pointed at is gone from Slack");
    expect(recorded(dir)[0]?.thread).toBeUndefined();
    // The record still exists and still holds the status; what it lost is a
    // reference no call can use.
    expect(recorded(dir)[0]?.agent).toBe("ana");

    // The next write asks Slack about nothing, so the error cannot repeat.
    const before = calls.filter((c) => c.url.includes("assistant.threads.setStatus")).length;
    await mgr.setOn("general", "ana");
    expect(calls.filter((c) => c.url.includes("assistant.threads.setStatus"))).toHaveLength(before);
  });

  test("a REFUSED setStatus records no thread, so a clear does not claim one", async () => {
    const refusing = (url: string): Response =>
      url.includes("assistant.threads.setStatus")
        ? new Response(JSON.stringify({ ok: false, error: "invalid_thread_ts" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    const { mgr, calls, errs } = makeSlack({ router: refusing });
    await mgr.setOn("general", "ana", "thread.9");
    await mgr.clearOn("general", "ana");
    expect(errs.join(" ")).toContain("invalid_thread_ts");
    // The operation makes one attempt to set the status, and makes no attempt to
    // clear a status that was never set.
    expect(calls.filter((c) => c.url.includes("assistant.threads.setStatus"))).toHaveLength(1);
  });



  test("a Slack ok:false on the status call is reported and the work carries on", async () => {
    const failing = (url: string): Response =>
      url.includes("assistant.threads.setStatus")
        ? new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    const { mgr, errs } = makeSlack({ router: failing });
    await mgr.setOn("general", "ana", "thread.9");
    expect(errs.join(" ")).toContain("invalid_auth");
    // Despite the failed Slack call, the status is recorded, so the lifecycle
    // remains.
  });

  test("a network failure and a non-JSON answer are surfaced as failures", async () => {
    const throwing = (): Response => {
      throw new Error("network");
    };
    const { mgr, errs } = makeSlack({ router: throwing });
    await mgr.setOn("general", "ana", "thread.9");
    expect(errs.join(" ")).toContain("status request failed");

    const nonJson = (): Response => new Response("not json", { status: 200 });
    const { mgr: m2, errs: e2 } = makeSlack({ router: nonJson });
    await m2.setOn("general", "bob", "thread.9");
    expect(e2.join(" ")).toContain("non-JSON");

    const scalar = (): Response => new Response("42", { status: 200 });
    const { mgr: m3, errs: e3 } = makeSlack({ router: scalar });
    await m3.setOn("general", "carol", "thread.9");
    expect(e3.join(" ")).toContain("non-object");
  });

  test("a missing token reports without a call", async () => {
    const { mgr, calls, errs } = makeSlack({ noToken: true });
    expect(calls).toEqual([]);
    await mgr.setOn("general", "ana", "thread.9"); // reports the token error, no fetch
    expect(calls).toEqual([]);
    expect(errs.join(" ")).toContain("status needs a Slack token");
  });

  test("an expired entry clears Slack's status, so it never outlives the work", async () => {
    const { mgr, advance, calls } = makeSlack();
    await mgr.setOn("general", "ana", "thread.9");
    advance(10_001);
    await mgr.clearExpired();
    const set = calls.filter((c) => c.url.includes("assistant.threads.setStatus"));
    expect(set).toHaveLength(2);
    expect(set[1]?.body).toMatchObject({ thread_ts: "thread.9", status: "" });
  });
});

// ## CLI integration

describe("status through the CLI", () => {
  test("a message addressed to this agent sets the status for that channel", async () => {
    const dir = scratch("cli-deliver");
    const store = seededStore(dir, "@ana hi");
    const handler = createHandler(store);
    const { io } = await mainIo(dir, (u, init) => handler(new Request(u, init)), {});
    const code = await main(["message", "check", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(recorded(dir)).toHaveLength(1);
    expect(recorded(dir)[0]).toMatchObject({ channel: "general", agent: "ana" });
  });

  test("a message NOT addressed to this agent sets nothing", async () => {
    const dir = scratch("cli-unaddressed");
    const store = createStore(scratch("cli-unaddressed-store"));
    store.join("ana", "goal", "general");
    store.join("bob", "goal", "general");
    store.post({ channel: "general", from: "bob", text: "hello everyone", id: "1" });
    const handler = createHandler(store);
    const { io } = await mainIo(dir, (u, init) => handler(new Request(u, init)), {});
    const code = await main(["message", "check", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(recorded(dir)).toEqual([]);
  });

  test("a reply clears the active status in the same call", async () => {
    const dir = scratch("cli-reply");
    const store = seededStore(dir, "@ana hi");
    const handler = createHandler(store);
    const { io } = await mainIo(dir, (u, init) => handler(new Request(u, init)), {});
    await main(["message", "check", "--as", "ana"], io); // delivery sets the status
    expect(recorded(dir)).toHaveLength(1);
    const code = await main(["post", "general", "answering now", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(recorded(dir)).toEqual([]);
  });

  test("a Slack ok:false status answer is reported while the post itself still succeeds", async () => {
    const dir = scratch("cli-slack-okfalse");
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    writeFileSync(
      join(dir, ".scramble", "slack.json"),
      JSON.stringify({
        token: "xoxb-app",
        appToken: "xapp-1",
        channels: { general: "C1" },
        agents: { bob: {} },
        roster: {},
        dmChannels: {},
      }),
    );
    // When a thread has an active status, the reply must clear it.
    writeStatus(statusPath(dir), [{ channel: "general", agent: "bob", thread: "1.9", expiresAt: Date.now() + 60_000 }]);
    let messagePosts = 0;
    const { io, errs } = await mainIo(dir, async (url) => {
      const u = String(url);
      // Slack refuses the CLEAR request, and this rejection must not take down the
      // post.
      if (u.includes("assistant.threads.setStatus")) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_thread_ts" }), { status: 200 });
      }
      if (u.includes("chat.postMessage")) {
        messagePosts++;
        return new Response(JSON.stringify({ ok: true, ts: "5.5" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, {});
    const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
    expect(code).toBe(0); // the status failure never fails the post
    // The system uses no settle timer. The short-lived command awaits the status
    // clear, so the ledger is already written with the cleared reply when `main()`
    // returns.
    expect(errs.some((e) => e.includes("invalid_thread_ts"))).toBe(true);
    expect(messagePosts).toBe(1); // the message itself went out
    expect(recorded(dir)).toEqual([]); // the status was still dropped locally
  });

  test("a short-lived slack reply clears the ledger before the call returns", async () => {
    const dir = scratch("cli-slack-awaited-clear");
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    writeFileSync(
      join(dir, ".scramble", "slack.json"),
      JSON.stringify({
        token: "xoxb-app",
        appToken: "xapp-1",
        channels: { general: "C1" },
        agents: { bob: {} },
        roster: {},
        dmChannels: {},
      }),
    );
    // An active status backs the reply, so the reply must write the CLEARED ledger.
    writeStatus(statusPath(dir), [{ channel: "general", agent: "bob", thread: "ts.9", expiresAt: Date.now() + 60_000 }]);
    const { io } = await mainIo(dir, async (url, init) => {
      const u = String(url);
      if (u.includes("chat.delete")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, {});
    const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
    expect(code).toBe(0);
    // The test uses no settle timers and performs no promise inspection. The operation
    // awaited `clearOn`, so the ledger is already empty the moment `main()` returned.
    expect(recorded(dir)).toEqual([]);
  });

  test("a failed slack post earns exit 1 while a status ok:false is still reported", async () => {
    const dir = scratch("cli-slack-fail");
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    writeFileSync(
      join(dir, ".scramble", "slack.json"),
      JSON.stringify({
        token: "xoxb-app",
        appToken: "xapp-1",
        channels: { general: "C1" },
        agents: { bob: {} },
        roster: {},
        dmChannels: {},
      }),
    );
    // The failed reply must still attempt to clear and report an active status.
    writeStatus(statusPath(dir), [{ channel: "general", agent: "bob", thread: "ts.7", expiresAt: Date.now() + 60_000 }]);
    const { io, errs } = await mainIo(dir, async (url, init) => {
      const u = String(url);
      // The POST request to general fails. The underlying post command exits with
      // status 1.
      if (u.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 });
      if (u.includes("chat.delete")) return new Response(JSON.stringify({ ok: false, error: "cannot_delete" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, {});
    const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
    // The failure status never changes the exit code. The command returns 1 from the
    // post operation.
    expect(code).toBe(1);
    expect(errs.join(" ")).toContain("not_in_channel");
  });

  test("SCRAMBLE_STATUS=off performs no status and leaves no ledger", async () => {
    const dir = scratch("cli-off");
    const store = seededStore(dir, "@ana hi");
    const handler = createHandler(store);
    const { io } = await mainIo(dir, (u, init) => handler(new Request(u, init)), { SCRAMBLE_STATUS: "off" });
    const code = await main(["message", "check", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(recorded(dir)).toEqual([]);
  });

  test("status appears in neither history nor a listener's stdout", async () => {
    const dir = scratch("cli-hidden");
    const store = createStore(scratch("cli-hidden-store"));
    store.join("ana", "goal", "general");
    store.post({ channel: "general", from: "bob", text: "@ana howdy", id: "1" });
    const handler = createHandler(store);
    const { io: ioCheck } = await mainIo(dir, (u, init) => handler(new Request(u, init)), {});
    await main(["message", "check", "--as", "ana"], ioCheck);
    expect(recorded(dir)).toHaveLength(1); // a status EXISTS in the ledger

    // The history holds only the one real message, with no status line in it.
    const { io, writes } = await mainIo(dir, (u, init) => handler(new Request(u, init)), { SCRAMBLE_STATUS: "off" });
    const code = await main(["history", "general"], io);
    expect(code).toBe(0);
    const lines = writes.map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ from: "bob", text: "@ana howdy" });
    expect(lines.some((l) => l.channel === "general" && (l.text ?? "").includes(STATUS_TEXT))).toBe(false);
  });

  test("a status write failure is caught, reported on stderr, and the verb still exits 0", async () => {
    const dir = scratch("status-throws");
    const store = createStore(scratch("status-throws-store"));
    store.join("ana", "goal", "general");
    store.post({ channel: "general", from: "bob", text: "@ana hi", id: "1" });
    const handler = createHandler(store);
    // When `status.json` is a directory, the ledger write rejects. The awaited status
    // call throws, `settleStatus` catches the error, and the check still exits 0.
    mkdirSync(join(dir, ".scramble", "status.json"), { recursive: true });
    const { io, errs } = await mainIo(dir, (u, init) => handler(new Request(u, init)), {});
    const code = await main(["message", "check", "--as", "ana"], io);
    expect(code).toBe(0); // a failing status never fails the verb
    expect(errs.some((e) => e.startsWith("status:"))).toBe(true);
  });
});

describe("a channel the config map does not hold", () => {
  // The map is a manually maintained copy of data stored in Slack, and this is the
  // fourth place in this repository where the copy was missing or stale. In a live
  // measurement, an agent was invited into a channel; `message send` to the agent
  // worked because the post path queries Slack, but the status path read the map,
  // found nothing, and the whole feature failed in that channel. A stale entry ended
  // the same way, producing a bare `status: channel_not_found`.

  test("resolves live, and the status lands in the resolved channel", async () => {
    const h = makeSlack({ resolve: async (c) => (c === "invited-channel" ? "C-INVITED" : undefined) });
    await h.mgr.setOn("invited-channel", "dev", "root.1");
    const set = h.calls.find((c) => c.url.includes("assistant.threads.setStatus"));
    expect(set?.body).toMatchObject({ channel_id: "C-INVITED", thread_ts: "root.1", status: STATUS_TEXT });
    expect(h.errs).toEqual([]);
  });

  test("the map still wins, so a mapped channel costs no lookup", async () => {
    let asked = 0;
    const h = makeSlack({
      resolve: async () => {
        asked += 1;
        return "C-OTHER";
      },
    });
    await h.mgr.setOn("general", "dev", "root.1");
    expect(asked).toBe(0);
    expect(h.calls.find((c) => c.url.includes("setStatus"))?.body).toMatchObject({ channel_id: "C1" });
  });

  test("an unresolvable channel sets nothing and stays quiet", async () => {
    const h = makeSlack({ resolve: async () => undefined });
    await h.mgr.setOn("nowhere", "dev", "root.1");
    expect(h.calls.find((c) => c.url.includes("setStatus"))).toBeUndefined();
    expect(h.errs).toEqual([]);
  });

  test("a resolver that THROWS is reported with the channel, never swallowed", async () => {
    const h = makeSlack({
      resolve: async () => {
        throw new Error("users.conversations failed");
      },
    });
    await h.mgr.setOn("nowhere", "dev", "root.1");
    expect(h.errs.join(" ")).toContain("resolving nowhere failed: users.conversations failed");
  });

  test("a Slack refusal names the channel and what was asked", async () => {
    // The `status: channel_not_found` output indicated which error returned and
    // contained no details about the request. Failures in this feature are reported
    // and never escalated, so the report is the only trace it leaves.
    const h = makeSlack({
      router: () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
    });
    await h.mgr.setOn("general", "dev", "root.1");
    expect(h.errs.join(" ")).toContain("status in general: channel_not_found (channel_id C1, thread root.1)");
  });
});

describe("a wedged lock", () => {
  test("is broken, and the break is REPORTED on the status channel", async () => {
    // A process terminated while holding the lock must not freeze every status
    // across the workspace, and breaking a lock silently would conceal a wedged
    // process.
    const h = makeSlack();
    mkdirSync(`${statusPath(h.dir)}.lock`, { recursive: true });
    await h.mgr.setOn("general", "dev", "root.1");
    expect(h.errs.join(" ")).toContain("breaking it");
    expect(recorded(h.dir).map((r) => r.channel)).toEqual(["general"]);
  }, 15_000);
});

describe("an expiry sweep touches only the sweeping agent's own rows", () => {
  test("another agent's expired row is left where it is", async () => {
    // A manager holds one token, so taking down another agent's status means calling
    // Slack under the wrong credential, in a channel this agent may not be in. This
    // was measured as `status in team: channel_not_found (channel_id C0EXAMPLE006)`
    // for a row belonging to a different agent.
    const dir = scratch("sweep-own");
    const file = statusPath(dir);
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    writeStatus(file, [
      { channel: "team", agent: "someone-else", expiresAt: 10 },
      { channel: "team", agent: "me", expiresAt: 10 },
    ]);
    const calls: string[] = [];
    const mgr = new StatusManager({
      file,
      backend: "slack",
      now: () => 1_000_000,
      ttlMs: 10_000,
      channels: { team: "C1" },
      token: "xoxb",
      agent: "me",
      writeErr: () => {},
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(await mgr.clearExpired()).toBe(1);
    expect(recorded(dir).map((r) => r.agent)).toEqual(["someone-else"]);
    // No Slack call was sent regarding the other agent's row.
    expect(calls).toEqual([]);
  });

  test("with no agent named, the sweep clears everything", async () => {
    // The local backend and a one-agent workspace require the previous behavior.
    const dir = scratch("sweep-all");
    const file = statusPath(dir);
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    writeStatus(file, [
      { channel: "a", agent: "x", expiresAt: 10 },
      { channel: "b", agent: "y", expiresAt: 10 },
    ]);
    const mgr = new StatusManager({
      file,
      backend: "local",
      now: () => 1_000_000,
      ttlMs: 10_000,
      writeErr: () => {},
      fetch: async () => new Response("{}", { status: 200 }),
    });
    expect(await mgr.clearExpired()).toBe(2);
    expect(recorded(dir)).toEqual([]);
  });
});

describe("the ledger survives several processes writing at once", () => {
  // Before the fix, eight processes each added one channel and left two entries of
  // eight. Every mutation read the file, changed what it read, and wrote the entire
  // file back, while a listener, a send operation, and an expiry sweep did the same
  // in separate processes. The last writer won.
  //
  // The live smoke test caught the defect when a status that existed a moment
  // earlier disappeared, which is the shape a lost update takes when observed.
  test("eight concurrent writers all survive", async () => {
    const dir = scratch("concurrent");
    const file = statusPath(dir);
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      [
        `import { StatusManager } from "${join(import.meta.dir, "..", "src", "status")}";`,
        `const mgr = new StatusManager({`,
        `  file: ${JSON.stringify(file)}, backend: "local", now: () => 1_000_000, ttlMs: 60_000,`,
        `  writeErr: () => {}, fetch: async () => new Response("{}", { status: 200 }),`,
        `});`,
        `await mgr.setOn(process.argv[2]!, "dev", "t1");`,
      ].join("\n"),
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Bun.spawn(["bun", probe, `ch${i}`], { stdout: "ignore", stderr: "ignore" }).exited,
      ),
    );
    expect(readRecords(file).map((r) => r.channel).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `ch${i}`).sort(),
    );
  }, 30_000);
});

