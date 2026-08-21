import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SlackSocket } from "../src/slack-transport";
import {
  SlackBackend,
  computeMentions,
  type SlackBackendConfig,
  type SlackInboundEvent,
} from "../src/slack-backend";
import { main, selectBackend, type Io } from "../src/cli";
import type { Delivery } from "../src/types";

// --- fake socket ---------------------------------------------------------

class FakeSocket implements SlackSocket {
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code?: number, reason?: string) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.onclose?.(code, reason);
  }
}

const SOCKET_OPEN = "slack.com/api/apps.connections.open";
const HISTORY = "slack.com/api/conversations.history";
const POST = "slack.com/api/chat.postMessage";
const USERS = "slack.com/api/users.info";

function baseConfig(over?: Partial<SlackBackendConfig>): SlackBackendConfig {
  return {
    token: "xoxb-app",
    appToken: "xapp-1",
    channels: { general: "C1", secret: "G_S" },
    agents: { alice: { token: "T_ALICE" }, bob: {} },
    roster: { U111: "ana" },
    dmChannels: { D1: "alice" },
    botIds: ["B999"],
    filesDir: join(tmpdir(), `scrb-files-${process.pid}-${Math.random().toString(36).slice(2)}`),
    ...over,
  };
}

/** Default ok:true for every Slack REST endpoint. */
function okRouter(url: string): Response {
  if (url.includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: true, url: "wss://s" }), { status: 200 });
  if (url.includes(USERS)) return new Response(JSON.stringify({ ok: true, user: { name: "fromUsers" } }), { status: 200 });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

interface H {
  backend: SlackBackend;
  sockets: FakeSocket[];
  fetches: Array<{ url: string; init?: RequestInit }>;
}

function make(
  over?: Partial<SlackBackendConfig>,
  router: (url: string, init?: RequestInit) => Response | Promise<Response> = okRouter,
): H {
  const cfg = baseConfig(over);
  const sockets: FakeSocket[] = [];
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  const backend = new SlackBackend(cfg, {
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return router(url, init);
    },
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    sleep: async () => {},
    now: () => 0,
  });
  return { backend, sockets, fetches };
}

function emit(h: H, ev: SlackInboundEvent, socket = 0): void {
  h.sockets[socket]?.onmessage?.(frame(ev));
}

function frame(ev: SlackInboundEvent, envelope = "E1"): string {
  return JSON.stringify({ type: "events_api", envelope_id: envelope, payload: { event: ev } });
}

function msg(over: Partial<SlackInboundEvent>): SlackInboundEvent {
  return { type: "message", channel: "C1", user: "U111", text: "hello", ts: "1.1", ...over };
}

async function pump(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** A real sleep/clock backend for timeout-hostile tests. */
function makeTimed(
  over?: Partial<SlackBackendConfig>,
  router: (url: string) => Response | Promise<Response> = okRouter,
): {
  backend: SlackBackend;
  sockets: FakeSocket[];
  fetches: Array<{ url: string; init?: RequestInit }>;
} {
  const cfg = baseConfig(over);
  const sockets: FakeSocket[] = [];
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  let t = 0;
  const backend = new SlackBackend(cfg, {
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return router(url);
    },
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    sleep: async () => {
      t = Number.MAX_SAFE_INTEGER;
    },
    now: () => t,
  });
  return { backend, sockets, fetches };
}

// --- computeMentions ------------------------------------------------------

describe("computeMentions", () => {
  test("a dm channel addresses its peers, never the sender", () => {
    expect(computeMentions("dm/ana/bob", "hi", "ana")).toEqual(["bob"]);
    expect(computeMentions("dm/ana/bob", "hi", "bob")).toEqual(["ana"]);
  });

  test("a group channel takes @-tokens from the text", () => {
    expect(computeMentions("general", "@alice @dev check this", "x")).toEqual(["alice", "dev"]);
  });

  test("a group channel with no @-token has empty mentions", () => {
    expect(computeMentions("general", "hello there", "x")).toEqual([]);
  });
});

// --- post ------------------------------------------------------------------

describe("post", () => {
  test("posts with the agent's own bot token when configured", async () => {
    const h = make();
    const r = await h.backend.post("general", "hi", "alice");
    expect(r).toEqual({ ok: true });
    const call = h.fetches.find((f) => f.url.includes(POST))!;
    expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer T_ALICE");
    expect(JSON.parse(call.init?.body as string)).toEqual({ channel: "C1", text: "hi" });
  });

  test("falls back to the config token for an agent without one", async () => {
    const h = make();
    const r = await h.backend.post("general", "hi", "bob");
    expect(r).toEqual({ ok: true });
    const call = h.fetches.find((f) => f.url.includes(POST))!;
    expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer xoxb-app");
  });

  test("an unknown channel is a failure naming the channel", async () => {
    const h = make();
    const r = await h.backend.post("nope", "hi", "bob");
    expect(r).toEqual({ ok: false, error: "no Slack channel for channel nope" });
  });

  test("Slack ok:false surfaces Slack's error text, never a success", async () => {
    const h = make({}, async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 }));
    const r = await h.backend.post("general", "hi", "bob");
    expect(r).toEqual({ ok: false, error: "invalid_auth" });
  });

  test("a non-JSON answer is a failure", async () => {
    const h = make({}, async () => new Response("not json", { status: 200 }));
    const r = await h.backend.post("general", "hi", "bob");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("non-JSON");
  });

  test("a non-object JSON answer is a failure", async () => {
    const h = make({}, async () => new Response(JSON.stringify([1, 2]), { status: 200 }));
    const r = await h.backend.post("general", "hi", "bob");
    expect(r.ok).toBe(false);
  });

  test("a fetch network error is a failure", async () => {
    const h = make({}, async () => {
      throw new Error("net down");
    });
    const r = await h.backend.post("general", "hi", "bob");
    expect(r).toEqual({ ok: false, error: "slack request failed: https://slack.com/api/chat.postMessage" });
  });

  test("posts into a thread by passing thread_ts", async () => {
    const h = make();
    const r = await h.backend.post("general", "hi", "alice", "1.1");
    expect(r).toEqual({ ok: true });
    const call = h.fetches.find((f) => f.url.includes(POST))!;
    expect(JSON.parse(call.init?.body as string)).toEqual({ channel: "C1", text: "hi", thread_ts: "1.1" });
  });

  test("posts without thread_ts when no thread is given", async () => {
    const h = make();
    await h.backend.post("general", "hi", "alice");
    const call = h.fetches.find((f) => f.url.includes(POST))!;
    const body = JSON.parse(call.init?.body as string) as Record<string, unknown>;
    expect("thread_ts" in body).toBe(false);
  });
});

// --- history ---------------------------------------------------------------

describe("history", () => {
  test("maps conversations.history messages into the line shape", async () => {
    const h = make({}, async (url) => {
      expect(url).toContain("channel=C1");
      return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1", user: "U111", text: "start" }] }), { status: 200 });
    });
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    expect(r.messages[0]!.channel).toBe("general");
    expect(r.messages[0]!.from).toBe("ana");
    expect(r.messages[0]!.text).toBe("start");
    expect(r.messages[0]!.ts).toBe("1");
  });

  test("maps a since cursor to Slack's oldest param", async () => {
    const h = make({}, async (url) => {
      expect(url).toContain("oldest=5");
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    const r = await h.backend.history("general", "5");
    expect(r.code).toBe(0);
  });

  test("an unknown channel history fails naming the channel", async () => {
    const h = make();
    const r = await h.backend.history("nope");
    expect(r.code).toBe(1);
    expect(r.error).toContain("nope");
  });

  test("a history failure surfaces the error", async () => {
    const h = make({}, async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }));
    const r = await h.backend.history("general");
    expect(r.code).toBe(1);
    expect(r.error).toBe("channel_not_found");
  });

  test("a self-filtered or textless history message is skipped", async () => {
    const h = make({}, async () =>
      new Response(JSON.stringify({ ok: true, messages: [{ ts: "1", bot_id: "B999", text: "x" }, { ts: "2", user: "U1" }] }), { status: 200 }),
    );
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    expect(r.messages).toHaveLength(0);
  });

  test("history round-trips a threaded reply's thread id and leaves a parent unmarked", async () => {
    const h = make({}, async () =>
      new Response(JSON.stringify({ ok: true, messages: [
        { ts: "5.1", thread_ts: "5.0", user: "U111", text: "inside" },
        { ts: "5.0", thread_ts: "5.0", user: "U111", text: "root" },
        { ts: "5.2", user: "U111", text: "plain" },
      ] }), { status: 200 }),
    );
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    expect(r.messages[0]!.thread).toBe("5.0");
    expect("thread" in r.messages[1]!).toBe(false);
    expect("thread" in r.messages[2]!).toBe(false);
  });
});

// --- listen -----------------------------------------------------------------

describe("listen", () => {
  test("delivers one line per matching message, mentioned stamped for the agent", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "@alice check" }));
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(1);
    const d = lines[0] as Record<string, unknown>;
    expect(d.channel).toBe("general");
    expect(d.from).toBe("ana");
    expect(d.mentions).toContain("alice");
    expect(d.mentioned).toBe(true);
  });

  test("self-filter drops our own bot posts", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ bot_id: "B999", text: "hi" }), 0);
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(0);
  });

  test("with no channel list, every mapped channel is delivered", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "G_S" }));
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(1);
    expect((lines[0] as Record<string, unknown>).channel).toBe("secret");
  });

  test("a non-message event and empty text are not delivered", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, { type: "reaction_added" });
    emit(h, msg({ text: "" }));
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(0);
  });

  test("an unknown channel is not delivered", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "C_NOPE" }));
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(0);
  });

  test("a plain username sender passes through unchanged", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ user: "notanid", username: "webby" }));
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect((lines[0] as Record<string, unknown>).from).toBe("webby");
  });

  test("the envelope is ACKed so Slack does not redeliver", async () => {
    const h = make();
    const p = h.backend.listen([], "alice", () => {}, () => {});
    await pump();
    h.sockets[0]?.onmessage?.(frame(msg({}), "E9"));
    expect(h.sockets[0]!.sent).toEqual([JSON.stringify({ envelope_id: "E9" })]);
    await pump(5);
    h.sockets[0]?.close();
    await p;
  });

  test("a disconnect frame closes the socket cleanly", async () => {
    const h = make();
    const p = h.backend.listen([], "alice", () => {}, () => {});
    await pump();
    h.sockets[0]?.onmessage?.(JSON.stringify({ type: "disconnect" }));
    expect(h.sockets[0]!.closed).toEqual([{ code: 1000, reason: "disconnect" }]);
    await p;
  });

  test("non-JSON frames are ignored without events", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    h.sockets[0]?.onmessage?.("garbage");
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(0);
  });

  test("a channel list filters to those channels", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen(["secret"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "C1" })); // general, not requested
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(0);
  });

  test("a users.info lookup failure still normalizes to the raw id (cached)", async () => {
    const h = make({}, async (url) => {
      if (url.includes(USERS)) return new Response(JSON.stringify({ ok: false, error: "x" }), { status: 200 });
      return okRouter(url);
    });
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "<@Z999> yo" }));
    await pump(12);
    h.sockets[0]?.close();
    await p;
    expect((lines[0] as Record<string, unknown>).text).toBe("@Z999 yo");
  });

  test("a users.info success resolves a mention id outside the roster", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "<@U222> ping" })); // U222 not in roster -> users.info -> fromUsers
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect((lines[0] as Record<string, unknown>).text).toBe("@fromUsers ping");
  });

  test("a DM channel maps to a dm/<agent>/<peer> channel", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "D1", text: "privately" }));
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect((lines[0] as Record<string, unknown>).channel).toBe("dm/alice/ana");
  });

  test("listen resolves when the socket closes", async () => {
    const h = make();
    let done = false;
    const p = h.backend.listen([], "alice", () => {}, () => {}).then(() => {
      done = true;
    });
    await pump();
    h.sockets[0]?.close();
    await p;
    expect(done).toBe(true);
  });

  test("an inbound reply (thread_ts != ts) carries the thread id", async () => {
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ ts: "2.2", thread_ts: "1.1" }));
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect(lines[0]!.thread).toBe("1.1");
  });

  test("a parent (thread_ts == ts) carries no thread", async () => {
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ ts: "1.1", thread_ts: "1.1" }));
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect("thread" in lines[0]!).toBe(false);
  });

  test("a plain message carries no thread field at all", async () => {
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "anything" })); // no thread_ts, default ts=1.1
    await pump(5);
    h.sockets[0]?.close();
    await p;
    expect("thread" in lines[0]!).toBe(false);
  });

  test("a listen socket-open failure reports a problem and still resolves", async () => {
    const h = make({}, async (url) => {
      if (url.includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: false, error: "bad_app" }), { status: 200 });
      return okRouter(url);
    });
    const problems: string[] = [];
    const p = h.backend.listen([], "alice", () => {}, (pr) => problems.push(pr)).then(() => {});
    await pump();
    expect(problems.some((pr) => pr.includes("bad_app"))).toBe(true);
    await p;
  });
});

// --- next -------------------------------------------------------------------

describe("next", () => {
  test("resolves 0 with one line then blocks no further", async () => {
    const h = make();
    const p = h.backend.next(["general"], "alice", 5, () => {});
    await pump();
    expect(h.sockets).toHaveLength(1);
    emit(h, msg({ text: "@alice go" }));
    const r = await p;
    expect(r.code).toBe(0);
    if (r.code === 0) {
      expect(r.line.channel).toBe("general");
      expect(r.line.mentioned).toBe(true);
    }
    expect(h.sockets[0]!.closed.length).toBeGreaterThan(0);
  });

  test("times out with exit-64 semantics and nothing printed", async () => {
    const h = makeTimed();
    const p = h.backend.next([], "alice", 1, () => {});
    const r = await p;
    expect(r).toEqual({ code: 64 });
  });

  test("an open failure reports a problem and still times out", async () => {
    const h = makeTimed({}, async (url) => {
      if (url.includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: false, error: "invalid_app" }), { status: 200 });
      return okRouter(url);
    });
    const problems: string[] = [];
    const q = await h.backend.next([], "alice", 1, (pr) => problems.push(pr));
    await pump(5);
    expect(q).toEqual({ code: 64 });
    expect(problems.some((pr) => pr.includes("invalid_app"))).toBe(true);
  });
});

// --- CLI wiring -------------------------------------------------------------

function stubIo(over?: Partial<Io>): Io {
  return {
    write: () => {},
    writeErr: () => {},
    fetch: async () => new Response("[]", { status: 200 }),
    env: () => undefined,
    cwd: () => "/tmp",
    sleep: async () => {},
    serve: async () => 0,
    createSocket: () => new FakeSocket(),
    ...over,
  };
}

describe("selectBackend", () => {
  const env = (v: string | undefined): Io => stubIo({ env: (n) => (n === "SCRAMBLE_BACKEND" ? v : undefined) });

  test("--backend slack selects slack", () => {
    expect(selectBackend(["post", "--backend", "slack", "general"], env(undefined))).toBe("slack");
  });

  test("--backend=slack equals form selects slack", () => {
    expect(selectBackend(["--backend=slack"], env(undefined))).toBe("slack");
  });

  test("--backend local overrides a slack env", () => {
    expect(selectBackend(["post", "--backend", "local"], env("slack"))).toBe("local");
  });

  test("SCRAMBLE_BACKEND=slack selects slack without a flag", () => {
    expect(selectBackend(["post", "channel", "text"], env("slack"))).toBe("slack");
  });

  test("SCRAMBLE_BACKEND=local selects local", () => {
    expect(selectBackend(["post"], env("local"))).toBe("local");
  });
});

describe("slack commands through main", () => {
  /** Write a valid slack config into a scratch workspace and return an io whose
   *  cwd points there. */
  function configuredIo(over?: Partial<Io>): { io: Io; writes: string[]; errs: string[] } {
    const dir = makeTmpDir("slack-config");
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    writeFileSync(
      join(dir, ".scramble", "slack.json"),
      JSON.stringify({
        token: "xoxb-app",
        appToken: "xapp-1",
        channels: { general: "C1" },
        agents: { alice: { token: "T_ALICE" }, bob: {} },
        roster: { U111: "ana" },
        dmChannels: {},
        botIds: [],
      }),
    );
    const writes: string[] = [];
    const errs: string[] = [];
    const io = stubIo({
      cwd: () => dir,
      write: (l) => writes.push(l),
      writeErr: (l) => errs.push(l),
      ...over,
    });
    return { io, writes, errs };
  }

  test("post resolves through the slack backend and exits 0", async () => {
    let sawPost = false;
    const { io } = configuredIo({
      fetch: async (url, init) => {
        if (String(url).includes(POST)) {
          sawPost = true;
          expect((init?.headers as Record<string, string>).authorization).toBe("Bearer xoxb-app");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      createSocket: () => new FakeSocket(),
    });
    const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
    expect(code).toBe(0);
    expect(sawPost).toBe(true);
  });

  test("message send --thread reaches chat.postMessage with thread_ts", async () => {
    const { io } = configuredIo({
      fetch: async (url, init) => {
        if (String(url).includes(POST)) {
          expect(JSON.parse(String(init?.body))).toEqual({ channel: "C1", text: "thread reply", thread_ts: "1787291684.717739" });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      createSocket: () => new FakeSocket(),
    });
    io.readStdin = async () => "thread reply";
    const code = await main(["message", "send", "--target", "general", "--thread", "1787291684.717739", "--as", "bob", "--backend", "slack"], io);
    expect(code).toBe(0);
  });

  test("a slack post failure exits 1 with Slack's error on stderr", async () => {
    const { io, errs } = configuredIo({
      fetch: async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 }),
      createSocket: () => new FakeSocket(),
    });
    const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("invalid_auth");
  });

  test("history through slack prints the messages and exits 0", async () => {
    const { io, writes } = configuredIo({
      fetch: async (url) => {
        if (String(url).includes(HISTORY)) {
          return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1", username: "ana", text: "hi" }] }), { status: 200 });
        }
        return okRouter(String(url));
      },
      createSocket: () => new FakeSocket(),
    });
    const code = await main(["history", "general", "--backend", "slack"], io);
    expect(code).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ channel: "general", text: "hi" });
  });

  test("next through the slack backend blocks for one and exits 0", async () => {
    const sockets: FakeSocket[] = [];
    const { io, writes } = configuredIo({
      fetch: async (url) => {
        if (String(url).includes(SOCKET_OPEN)) {
          return new Response(JSON.stringify({ ok: true, url: "wss://s" }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    const p = main(["next", "--as", "alice", "--backend", "slack", "--timeout", "5"], io);
    await pump(10);
    sockets[0]?.onmessage?.(frame({ type: "message", channel: "C1", user: "U123", text: "@alice hi", ts: "1" }));
    const code = await p;
    expect(code).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ channel: "general", mentioned: true });
  });

  test("a slack next with no config exits 1 naming the config path", async () => {
    const io = stubIo();
    const cwd2 = makeTmpDir("slackcfg-missing");
    io.cwd = () => cwd2;
    const errs: string[] = [];
    io.writeErr = (l) => errs.push(l);
    const code = await main(["next", "--backend", "slack", "--as", "alice", "--timeout", "1"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("missing or malformed");
  });

  test("discovery: a default (localhost) backend is untouched", async () => {
    const io = stubIo();
    const writes: string[] = [];
    io.write = (l) => writes.push(l);
    const code = await main(["history", "general"], io);
    expect(code).toBe(0);
  });

  test("a slack post with no channel exits 1 with a usage error", async () => {
    const { io, errs } = configuredIo();
    const code = await main(["post", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("usage");
  });

  test("a slack backend with no socket seam exits 1", async () => {
    const { io, errs } = configuredIo({ createSocket: undefined });
    const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("socket");
  });

  test("a slack backtak with no token exits 1", async () => {
    const dir = makeTmpDir("slackcfg-notoken");
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    writeFileSync(
      join(dir, ".scramble", "slack.json"),
      JSON.stringify({ channels: { general: "C1" }, agents: {} }),
    );
    const io = stubIo({ cwd: () => dir });
    const errs: string[] = [];
    io.writeErr = (l) => errs.push(l);
    const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("bot token");
  });

  test("listen through the slack backend exits 0 after the socket closes", async () => {
    const sockets: FakeSocket[] = [];
    const { io, writes } = configuredIo({
      fetch: async (url) => {
        if (String(url).includes(SOCKET_OPEN)) {
          return new Response(JSON.stringify({ ok: true, url: "wss://s" }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    const p = main(["listen", "--as", "alice", "--backend", "slack"], io);
    await pump(10);
    sockets[0]?.onmessage?.(frame({ type: "message", channel: "C1", user: "U111", text: "@alice yo", ts: "1" }));
    await pump(3);
    sockets[0]?.close();
    const code = await p;
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
  });

  test("a slack history with no channel exits 1", async () => {
    const { io, errs } = configuredIo();
    const code = await main(["history", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("channel");
  });

  test("a slack history missing config exits 1", async () => {
    const io = stubIo();
    const dir = makeTmpDir("slackcfg-missing-hist");
    io.cwd = () => dir;
    const errs: string[] = [];
    io.writeErr = (l) => errs.push(l);
    const code = await main(["history", "general", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("missing or malformed");
  });

  test("a slack history failure exits 1 with Slack's error", async () => {
    const { io, errs } = configuredIo({
      fetch: async () => new Response(JSON.stringify({ ok: false, error: "channel_closed" }), { status: 200 }),
    });
    const code = await main(["history", "general", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("channel_closed");
  });

  test("a slack listen with no config exits 1", async () => {
    const io = stubIo();
    const dir = makeTmpDir("slackcfg-missing-listen");
    io.cwd = () => dir;
    const errs: string[] = [];
    io.writeErr = (l) => errs.push(l);
    const code = await main(["listen", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("missing or malformed");
  });

  test("a slack listen socket-open failure reports on stderr and exits", async () => {
    const { io, errs } = configuredIo({
      fetch: async (url) => {
        if (String(url).includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: false, error: "bad_app" }), { status: 200 });
        return okRouter(url);
      },
      createSocket: () => new FakeSocket(),
    });
    const code = await main(["listen", "--as", "alice", "--backend", "slack"], io);
    expect(code).toBe(0);
    expect(errs.some((l) => l.includes("bad_app"))).toBe(true);
  });

  test("a slack next socket-open failure reports on stderr and exits 64", async () => {
    const { io, errs } = configuredIo({
      fetch: async (url) => {
        if (String(url).includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: false, error: "bad_token" }), { status: 200 });
        return okRouter(url);
      },
      createSocket: () => new FakeSocket(),
    });
    const code = await main(["next", "--as", "alice", "--backend", "slack", "--timeout", "1"], io);
    expect(code).toBe(64);
    expect(errs.some((l) => l.includes("bad_token"))).toBe(true);
  });
});

function makeTmpDir(name: string): string {
  const d = join(tmpdir(), `${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

// --- inbound file downloads ----------------------------------------------
// Every network seam is injected, so the download of a Slack message's `files`
// needs no token and no network. The fake fetch serves url_private from a
// queue; the bytes are written into a temp filesDir and read back to prove the
// download landed on the line.

describe("inbound file downloads", () => {
  function filesDir(): string {
    const d = makeTmpDir("scrb-in");
    return d;
  }

  test("a message with one file lands with files[0].path at a file whose bytes match what the fake returned", async () => {
    const dir = filesDir();
    const bytes = new TextEncoder().encode("PNG-SCREENSHOT-BYTES");
    const h = make({ filesDir: dir }, async (url, init) => {
      if (String(url).includes("files.slack.com") && init?.headers) {
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-app");
        return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      return okRouter(String(url));
    });
    const lines: Delivery[] = [];
    const problems: string[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), (pr) => problems.push(pr));
    await pump();
    emit(h, msg({ text: "see the screenshot", files: [{ id: "F1", name: "shot cat.png", url_private: "https://files.slack.com/v1/F1", mimetype: "image/png", size: 21 }] }));
    await pump(20);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(1);
    const file = lines[0]!.files![0]!;
    expect(file.id).toBe("F1");
    expect(file.mime).toBe("image/png");
    expect(file.size).toBe(21);
    expect(file.path).toContain("F1-shot_cat.png");
    expect(Buffer.from(readFileSync(file.path!)).equals(Buffer.from(bytes))).toBe(true);
    expect(problems).toHaveLength(0);
  });

  test("an inbound download that returns HTML is REPORTED and the message still arrives with metadata and no path", async () => {
    const dir = filesDir();
    const h = make({ filesDir: dir }, async (url) => {
      if (String(url).includes("files.slack.com")) {
        return new Response("<html><body>requires auth</body></html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      return okRouter(String(url));
    });
    const lines: Delivery[] = [];
    const problems: string[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), (pr) => problems.push(pr));
    await pump();
    emit(h, msg({ text: "file", files: [{ id: "F2", name: "x.html", url_private: "https://files.slack.com/x", mimetype: "text/html" }] }));
    await pump(20);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.files![0]!.id).toBe("F2");
    expect(lines[0]!.files![0]!.path).toBeUndefined();
    expect(problems.some((pr) => pr.includes("HTML"))).toBe(true);
  });

  test("a message with no files carries no files field at all", async () => {
    const dir = filesDir();
    const h = make({ filesDir: dir });
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "no file here" }));
    await pump(8);
    h.sockets[0]?.close();
    await p;
    expect(lines).toHaveLength(1);
    expect("files" in lines[0]!).toBe(false);
  });

  test("a download network failure is reported and the message still arrives with no path", async () => {
    const dir = filesDir();
    const h = make({ filesDir: dir }, async (url) => {
      if (String(url).includes("files.slack.com")) throw new Error("net down");
      return okRouter(String(url));
    });
    const lines: Delivery[] = [];
    const problems: string[] = [];
    const p = h.backend.next(["general"], "alice", 5, (pr) => problems.push(pr));
    await pump();
    emit(h, msg({ files: [{ id: "F3", name: "a.bin", url_private: "https://files.slack.com/f3", mimetype: "application/octet-stream" }] }));
    const r = await p;
    expect(r.code).toBe(0);
    expect(r.code === 0 && r.line.files![0]!.path).toBeUndefined();
    expect(problems.some((pr) => pr.includes("download failed"))).toBe(true);
  });

  test("history maps a file onto the line the same way", async () => {
    const dir = filesDir();
    const bytes = new TextEncoder().encode("HIST-BYTES");
    const h = make({ filesDir: dir }, async (url) => {
      if (String(url).includes(HISTORY)) {
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1", user: "U111", text: "hist", files: [{ id: "H1", name: "doc.txt", url_private: "https://files.slack.com/h1", mimetype: "text/plain", size: 9 }] }] }), { status: 200 });
      }
      if (String(url).includes("files.slack.com")) return new Response(bytes, { status: 200, headers: { "content-type": "text/plain" } });
      return okRouter(String(url));
    });
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    expect(r.messages[0]!.files![0]!.path).toContain("H1-doc.txt");
    expect(Buffer.from(readFileSync(r.messages[0]!.files![0]!.path!)).equals(Buffer.from(bytes))).toBe(true);
    expect(r.problems).toHaveLength(0);
  });
});