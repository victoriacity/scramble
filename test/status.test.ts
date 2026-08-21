// test/status.test.ts — the AUTOMATIC working-status surface. Status is set by
// delivery of an addressed message and cleared by a reply, has a TTL, records to
// .scramble/status.json, and talks to Slack through an injected fetch seam so no
// token and no network are needed. Status is never a message and SCRAMBLE_STATUS=off
// silences it entirely.
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

/** A local-mode StatusManager plus a controllable clock and its scratch dir. */
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
  /** The scratch workspace, so a test can plant a ledger record written by an
   *  older version of this code. */
  dir: string;
}

/** A slack-mode StatusManager whose fetch records every call. `router` decides
 *  the answer; the default answers ok:true and gives chat.postMessage a ts so the
 *  living-message path is captured. */
function makeSlack(opts?: { router?: (url: string, body: Record<string, unknown>) => Response; noToken?: boolean }): SlackHarness {
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

/** Drive the CLI with a fully faked io over a scratch workspace. */
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

/** A store seeded with ana joined into `general`, plus a bob message. Channel
 *  handler routes CLI requests against it. */
function seededStore(dir: string, text: string): ChannelStore {
  const store = createStore(dir);
  store.join("ana", "goal", "general");
  const msg = store.post({ channel: "general", from: "bob", text, id: "s1" });
  void msg;
  return store;
}

const POST = "chat.postMessage";

// --- ledger IO ----------------------------------------------------------

describe("status ledger", () => {
  test("writeStatus round-trips entries; readRecords reads them back", () => {
    const dir = scratch("ledger");
    writeStatus(statusPath(dir), [{ channel: "general", agent: "ana", expiresAt: 123 }]);
    expect(readRecords(statusPath(dir))).toEqual([{ channel: "general", agent: "ana", expiresAt: 123 }]);
  });

  test("readRecords on a missing or corrupt file returns [] and never throws", () => {
    const dir = scratch("ledger-missing");
    expect(readRecords(join(dir, "nope.json"))).toEqual([]);
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    writeFileSync(statusPath(dir), "not json{");
    expect(readRecords(statusPath(dir))).toEqual([]);
  });
});

// --- local backend ------------------------------------------------------

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

  test("a second set on one channel updates the same record, never a second", async () => {
    const { mgr, dir } = makeLocal();
    await mgr.setOn("general", "ana");
    await mgr.setOn("general", "bob");
    expect(recorded(dir)).toHaveLength(1);
    expect(recorded(dir)[0]?.agent).toBe("bob");
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

// --- slack backend ------------------------------------------------------

describe("status slack backend", () => {
  // A status is SLACK'S OWN status on a thread, not a message. Posting a
  // `working` line into the channel was the wrong shape, and setStatus works on
  // an ordinary channel thread, which is what makes the message unnecessary
  // (operator, 2026-08-21).
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
    // Silence beats a message pretending to be a status.
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

  test("a REFUSED setStatus records no thread, so a clear does not claim one", async () => {
    const refusing = (url: string): Response =>
      url.includes("assistant.threads.setStatus")
        ? new Response(JSON.stringify({ ok: false, error: "invalid_thread_ts" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    const { mgr, calls, errs } = makeSlack({ router: refusing });
    await mgr.setOn("general", "ana", "thread.9");
    await mgr.clearOn("general", "ana");
    expect(errs.join(" ")).toContain("invalid_thread_ts");
    // One attempt to set, and no attempt to clear a status that was never set.
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
    // the status is recorded despite the failed Slack call, so the lifecycle stays.
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

// --- CLI integration ----------------------------------------------------

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
    // an active status on a thread: the reply must clear it.
    writeStatus(statusPath(dir), [{ channel: "general", agent: "bob", thread: "1.9", expiresAt: Date.now() + 60_000 }]);
    let messagePosts = 0;
    const { io, errs } = await mainIo(dir, async (url) => {
      const u = String(url);
      // Slack refuses the CLEAR, which must not take the post down with it.
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
    // NO settle timer: the short-lived verb AWAITs the status clear, so the
    // ledger is already written (the cleared reply) when main() returns.
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
    // an active status backs the reply: the reply must write the CLEARED ledger.
    writeStatus(statusPath(dir), [{ channel: "general", agent: "bob", thread: "ts.9", expiresAt: Date.now() + 60_000 }]);
    const { io } = await mainIo(dir, async (url, init) => {
      const u = String(url);
      if (u.includes("chat.delete")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, {});
    const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
    expect(code).toBe(0);
    // NO settle/timer and NO promise inspection: the verb AWAITED clearOn, so
    // the ledger is already empty the moment main() returned.
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
    // an active status the failed reply must still attempt to clear (and report).
    writeStatus(statusPath(dir), [{ channel: "general", agent: "bob", thread: "ts.7", expiresAt: Date.now() + 60_000 }]);
    const { io, errs } = await mainIo(dir, async (url, init) => {
      const u = String(url);
      // the POST to general fails: the underlying post earns exit 1.
      if (u.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 });
      if (u.includes("chat.delete")) return new Response(JSON.stringify({ ok: false, error: "cannot_delete" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, {});
    const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
    // the failing status never changes the exit: the verb earns 1 from the post.
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

    // history: only the one real message, never a status line.
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
    // status.json as a DIRECTORY makes the ledger write reject: the awaited
    // status call throws, settleStatus catches it, and the check still exits 0.
    mkdirSync(join(dir, ".scramble", "status.json"), { recursive: true });
    const { io, errs } = await mainIo(dir, (u, init) => handler(new Request(u, init)), {});
    const code = await main(["message", "check", "--as", "ana"], io);
    expect(code).toBe(0); // a failing status never fails the verb
    expect(errs.some((e) => e.startsWith("status:"))).toBe(true);
  });
});
