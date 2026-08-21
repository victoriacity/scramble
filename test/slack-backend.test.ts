import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SlackSocket } from "../src/slack-transport";
import {
  SlackBackend,
  computeMentions,
  THREAD_EXPANSION_CAP,
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
const REPLIES = "slack.com/api/conversations.replies";
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

  test("history keeps a bot_id message and drops only textless lines", async () => {
    // history returns EVERY line: a bot_id message (even the reading agent's own
    // post) stays, and only a line Slack sent with no text at all is skipped.
    const h = make({}, async () =>
      new Response(JSON.stringify({ ok: true, messages: [
        { ts: "1", bot_id: "B999", text: "an app post" },
        { ts: "2", user: "U1" },
      ] }), { status: 200 }),
    );
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.text).toBe("an app post");
  });

  test("history includes BOTH the reading agent's own post and a peer's", async () => {
    // The read is a transcript: no self-suppression, so the agent's own line and
    // a peer's line both come back, matching a direct conversations.history read.
    const h = make({ roster: { U111: "ana", U1000: "alice" } }, async () =>
      new Response(JSON.stringify({ ok: true, messages: [
        { ts: "1", bot_id: "B999", user: "U1000", text: "from the agent itself" },
        { ts: "2", user: "U111", text: "from a peer" },
      ] }), { status: 200 }),
    );
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    expect(r.messages.map((m) => m.from)).toEqual(["alice", "ana"]);
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

  test("a threaded root expands: each reply carries thread==root ts, the root appears once with no thread", async () => {
    const h = make({}, async (url) => {
      if (url.includes(REPLIES)) {
        return new Response(JSON.stringify({ ok: true, messages: [
          { ts: "5.0", thread_ts: "5.0", reply_count: 2, user: "U111", text: "root dup" },
          { ts: "5.3", thread_ts: "5.0", user: "U111", text: "second" },
          { ts: "5.1", thread_ts: "5.0", user: "U111", text: "first" },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, messages: [
        { ts: "5.0", thread_ts: "5.0", reply_count: 2, user: "U111", text: "root" },
        { ts: "4.0", user: "U111", text: "other" },
      ] }), { status: 200 });
    });
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    // the root appears exactly once, carrying no thread
    const root = r.messages.filter((m) => m.ts === "5.0");
    expect(root).toHaveLength(1);
    expect(root[0]!.text).toBe("root"); // the root's own text, not the replies' first-entry dup
    expect("thread" in root[0]!).toBe(false);
    // each reply carries thread equal to the root ts
    const replies = r.messages.filter((m) => m.text === "first" || m.text === "second");
    expect(replies.map((m) => m.thread)).toEqual(["5.0", "5.0"]);
  });

  test("a history row with no replies triggers no conversations.replies request (proven by counting)", async () => {
    const h = make({}, async (url) => {
      if (url.includes(REPLIES)) throw new Error("no replies request expected for a reply-less row");
      return new Response(JSON.stringify({ ok: true, messages: [
        { ts: "2.0", thread_ts: "2.0", reply_count: 0, user: "U111", text: "root, no replies" },
        { ts: "1.0", user: "U111", text: "plain" },
      ] }), { status: 200 });
    });
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    expect(h.fetches.filter((f) => f.url.includes(REPLIES))).toHaveLength(0);
    expect(r.messages.length).toBe(2);
  });

  test("more threaded roots than the cap: the newest are expanded and the dropped count is named", async () => {
    // conversations.history returns NEWEST-FIRST: index 0 is the newest root.
    const roots = [...Array(THREAD_EXPANSION_CAP + 2)].map((_, i) => `root${i}.0`);
    const h = make({}, async (url) => {
      if (url.includes(REPLIES)) {
        // echo back the root + one reply so expansions are observable
        const rootTs = decodeURIComponent(url.split("ts=")[1]!.split("&")[0]!);
        return new Response(JSON.stringify({ ok: true, messages: [
          { ts: rootTs, thread_ts: rootTs, reply_count: 1, user: "U111", text: `root-dup ${rootTs}` },
          { ts: `${rootTs}.r`, thread_ts: rootTs, user: "U111", text: `reply to ${rootTs}` },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, messages: roots.map((ts, i) => ({ ts, thread_ts: ts, reply_count: 1, user: "U111", text: `root ${ts} (idx ${i})` })) }), { status: 200 });
    });
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    // only the cap is satisfied: exactly CAP conversations.replies requests
    const reqs = h.fetches.filter((f) => f.url.includes(REPLIES));
    expect(reqs.length).toBe(THREAD_EXPANSION_CAP);
    // newest roots (idx 0..CAP-1) were expanded, the OLDEST (idx CAP..end) dropped
    const expanded = reqs.map((f) => f.url.split("ts=")[1]!.split("&")[0]!);
    for (let i = 0; i < THREAD_EXPANSION_CAP; i++) expect(expanded).toContain(roots[i]!);
    for (let i = THREAD_EXPANSION_CAP; i < roots.length; i++) expect(expanded).not.toContain(roots[i]!);
    // the reply to each expanded root is present, carrying thread == root
    for (let i = 0; i < THREAD_EXPANSION_CAP; i++) {
      const reply = r.messages.find((m) => m.text === `reply to ${roots[i]!}`);
      expect(reply?.thread).toBe(roots[i]!);
    }
    // no reply for the dropped roots, and the drop is named in problems
    for (let i = THREAD_EXPANSION_CAP; i < roots.length; i++) {
      expect(r.messages.find((m) => m.text === `reply to ${roots[i]!}`)).toBeUndefined();
    }
    expect(r.problems.some((p) => p.includes(`${roots.length - THREAD_EXPANSION_CAP} threaded root(s) left unexpanded`))).toBe(true);
  });

  test("a history row that is a threaded root keeps out only the status-ts line among replies", async () => {
    // Safety when a status ts lands in a threaded expansion layer: the row whose
    // ts is in the status set is skipped, every other reply stays.
    const h = make({}, async (url) => {
      if (url.includes(REPLIES)) {
        return new Response(JSON.stringify({ ok: true, messages: [
          { ts: "5.0", thread_ts: "5.0", reply_count: 2, user: "U111", text: "root dup" },
          { ts: "5.1", thread_ts: "5.0", user: "U111", text: "status reply" },
          { ts: "5.2", thread_ts: "5.0", user: "U111", text: "normal reply" },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, messages: [
        { ts: "5.0", thread_ts: "5.0", reply_count: 2, user: "U111", text: "root" },
      ] }), { status: 200 });
    });
    const r = await h.backend.history("general", undefined, new Set(["5.1"]));
    expect(r.code).toBe(0);
    expect(r.messages.find((m) => m.ts === "5.1")).toBeUndefined();
    expect(r.messages.find((m) => m.ts === "5.2")?.text).toBe("normal reply");
    expect(r.messages.find((m) => m.ts === "5.0")?.text).toBe("root");
  });

  // --- status filtering: the SEAM the defect is about --------------------
  // A living status is a MESSAGE drawn by chat.postMessage with the fixed text
  // "working" and its ts recorded in the status ledger. A read or a delivery
  // must leave it out by the ledger's ts — never by matching text (a human
  // saying "working" is a real message). The set of status ts is passed in by
  // the caller (src/cli.ts), which reads the ledger; the backend itself holds no
  // notion of where the ledger lives.

  test("a history read whose conversation holds a message at a recorded status ts omits that line and keeps every other", async () => {
    const h = make({}, async () =>
      new Response(JSON.stringify({ ok: true, messages: [
        { ts: "1.1", user: "U111", text: "working" }, // the living status message
        { ts: "1.2", user: "U111", text: "before" },
        { ts: "1.3", user: "U111", text: "after" },
      ] }), { status: 200 }),
    );
    // ts "1.1" is a recorded living status.
    const r = await h.backend.history("general", undefined, new Set(["1.1"]));
    expect(r.code).toBe(0);
    expect(r.messages.map((m) => m.ts)).toEqual(["1.2", "1.3"]);
    expect(r.messages.every((m) => m.ts !== "1.1")).toBe(true);
  });

  test("with no active status the same read returns every line, including one whose text is 'working'", async () => {
    const h = make({}, async () =>
      new Response(JSON.stringify({ ok: true, messages: [
        { ts: "1.1", user: "U111", text: "working" },
        { ts: "1.2", user: "U111", text: "hello" },
      ] }), { status: 200 }),
    );
    // No status tts passed (undefined): nothing is hidden — even a text "working".
    const r = await h.backend.history("general", undefined, new Set<string>());
    expect(r.code).toBe(0);
    expect(r.messages.map((m) => m.ts)).toEqual(["1.1", "1.2"]);
    expect(r.messages.map((m) => m.text)).toEqual(["working", "hello"]);
  });

  test("a status ts ABSENT from the ledger is NOT hidden", async () => {
    const h = make({}, async () =>
      new Response(JSON.stringify({ ok: true, messages: [
        { ts: "9.9", user: "U111", text: "working" }, // same text, ts NOT a status
        { ts: "9.8", user: "U111", text: "real" },
      ] }), { status: 200 }),
    );
    // The set carries a DIFFERENT ts than 9.9, so the "working" line stays.
    const r = await h.backend.history("general", undefined, new Set(["7.7"]));
    expect(r.code).toBe(0);
    expect(r.messages.map((m) => m.ts)).toEqual(["9.9", "9.8"]);
  });

  test("a conversations.replies ok:false keeps the top-level messages and reports the problem", async () => {
    const h = make({}, async (url) => {
      if (url.includes(REPLIES)) return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [
        { ts: "9.0", thread_ts: "9.0", reply_count: 3, user: "U111", text: "a root" },
        { ts: "1.0", user: "U111", text: "top-level" },
      ] }), { status: 200 });
    });
    const r = await h.backend.history("general");
    expect(r.code).toBe(0);
    // top-level messages stay intact
    expect(r.messages.map((m) => m.text)).toEqual(["a root", "top-level"]);
    expect(r.problems.some((p) => p.includes("thread replies failed for root 9.0"))).toBe(true);
    expect(r.problems.some((p) => p.includes("not_in_channel"))).toBe(true);
  });

  test("a threaded-root expansion preserves attachment and mention behavior unchanged", async () => {
    const h = make(
      { filesDir: join(tmpdir(), `scrb-file-${process.pid}-${Math.random().toString(36).slice(2)}`) },
      async (url) => {
        if (url.includes(REPLIES)) {
          return new Response(JSON.stringify({ ok: true, messages: [
            { ts: "5.0", thread_ts: "5.0", reply_count: 1, user: "U111", text: "root dup" },
            { ts: "5.1", thread_ts: "5.0", user: "U111", text: "@alice replied with a file", files: [{ id: "F5", name: "a.txt", url_private: "https://files.slack.com/r1", mimetype: "text/plain", size: 2 }] },
          ] }), { status: 200 });
        }
        if (url.includes("files.slack.com")) {
          return new Response(new TextEncoder().encode("ab"), { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response(JSON.stringify({ ok: true, messages: [
          { ts: "5.0", thread_ts: "5.0", reply_count: 1, user: "U111", text: "root" },
        ] }), { status: 200 });
      },
    );
    const r = await h.backend.history("general");
    // mention + file behavior on a threaded reply: the reply's text names alice
    // and its file is downloaded onto the line, exactly as a live thread reply.
    const reply = r.messages.find((m) => m.text.startsWith("@alice"))!;
    expect(reply.mentions).toContain("alice");
    expect(reply.files![0]!.id).toBe("F5");
    expect(Buffer.from(readFileSync(reply.files![0]!.path!)).equals(Buffer.from("ab"))).toBe(true);
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
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines).toHaveLength(1);
    const d = lines[0] as Record<string, unknown>;
    expect(d.channel).toBe("general");
    expect(d.from).toBe("ana");
    expect(d.mentions).toContain("alice");
    expect(d.mentioned).toBe(true);
  });

  test("a message from a DIFFERENT agent (own bot_id) IS delivered and mentions the reader", async () => {
    // A peer app's post is NOT the reading agent's own post, so it must be
    // delivered; when it names the reading agent, `mentioned` is true.
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ bot_id: "B222", text: "@alice hello from another app" })); // U111 -> ana resolves, so from = ana
    await pump(8);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.from).toBe("ana");
    expect(lines[0]!.mentioned).toBe(true);
  });

  test("the reading agent's OWN identity is NOT delivered to that listener", async () => {
    // When the resolved sender name equals the consuming agent, the message is
    // suppressed (an agent must not answer itself), by NAME not by bot list.
    const h = make({ roster: { U1000: "alice" } });
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ user: "U1000", bot_id: "B999", text: "my own post" })); // from == alice == as
    await pump(8);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines).toHaveLength(0);
  });

  test("a delivery of a message at a living-status ts reaches no listener", async () => {
    // Status is never a message: a line whose ts is a recorded living status is
    // not delivered, decided by ts (the caller-passed set), not by text.
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {}, new Set(["1.1"]));
    await pump();
    emit(h, msg({ ts: "1.1", text: "working" })); // exactly the recorded status ts
    emit(h, msg({ ts: "1.2", text: "@alice real line" }));
    await pump(8);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ts).toBe("1.2");
  });

  test("a status ts absent from the ledger is still delivered", async () => {
    // Only a ts the caller marks as a status is held back; a ts not in the
    // ledger delivers normally.
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {}, new Set(["9.9"]));
    await pump();
    emit(h, msg({ ts: "1.1", text: "@alice hi" })); // 1.1 not a status
    await pump(8);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ts).toBe("1.1");
  });

  test("with no channel list, every mapped channel is delivered", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "G_S" }));
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
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
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines).toHaveLength(0);
  });

  test("an unknown channel is not delivered", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "C_NOPE" }));
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines).toHaveLength(0);
  });

  test("a plain username sender passes through unchanged", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ user: "notanid", username: "webby" }));
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect((lines[0] as Record<string, unknown>).from).toBe("webby");
  });

  test("the envelope is ACKed so Slack does not redeliver", async () => {
    const h = make();
    const p = h.backend.listen([], "alice", () => {}, () => {});
    await pump();
    h.sockets[0]?.onmessage?.(frame(msg({}), "E9"));
    expect(h.sockets[0]!.sent).toEqual([JSON.stringify({ envelope_id: "E9" })]);
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
  });

  test("a disconnect frame closes the socket cleanly", async () => {
    const h = make();
    const p = h.backend.listen([], "alice", () => {}, () => {});
    await pump();
    h.sockets[0]?.onmessage?.(JSON.stringify({ type: "disconnect" }));
    expect(h.sockets[0]!.closed).toEqual([{ code: 1000, reason: "disconnect" }]);
    // The disconnect closes the socket, which listen treats as a drop and would
    // RECONNECT (it never resolves in the healthy path); the assertion above
    // already ran, so do not await it.
    void p;
  });

  test("non-JSON frames are ignored without events", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    h.sockets[0]?.onmessage?.("garbage");
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines).toHaveLength(0);
  });

  test("a channel list filters to those channels", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen(["secret"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "C1" })); // general, not requested
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
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
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect((lines[0] as Record<string, unknown>).text).toBe("@Z999 yo");
  });

  test("a users.info success resolves a mention id outside the roster", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "<@U222> ping" })); // U222 not in roster -> users.info -> fromUsers
    await pump(14);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect((lines[0] as Record<string, unknown>).text).toBe("@fromUsers ping");
  });

  test("a DM channel maps to a dm/<agent>/<peer> channel", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "D1", text: "privately" }));
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect((lines[0] as Record<string, unknown>).channel).toBe("dm/alice/ana");
  });

  test("a connection that opened then drops RECONNECTS (backoff), staying alive", async () => {
    // Once a connection has worked, a drop is retried: listen opens a second
    // socket instead of giving up. Reachable under test because the injected
    // sleep resolves immediately.
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    expect(h.sockets).toHaveLength(1);
    // Deliver an event, then drop the socket: the stream must REOPEN rather than
    // end, and keep delivering on the new connection.
    emit(h, msg({ text: "before drop" }));
    await pump(8);
    expect(lines).toHaveLength(1);
    h.sockets[0]!.close();
    await pump(12);
    // a second connection was opened (the first dropped -> reconnect)
    expect(h.sockets.length).toBeGreaterThan(1);
    // the new socket still delivers
    emit2(h, msg({ text: "after reconnect" }));
    await pump(8);
    expect(lines[1]!.text).toBe("after reconnect");
    // never resolves in the healthy path; leave it pending on the new socket.
    void p;
  });

  function emit2(h: H, ev: SlackInboundEvent, socket?: number): void {
    emit(h, ev, socket ?? h.sockets.length - 1);
  }

  test("an inbound reply (thread_ts != ts) carries the thread id", async () => {
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ ts: "2.2", thread_ts: "1.1" }));
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines[0]!.thread).toBe("1.1");
  });

  test("a parent (thread_ts == ts) carries no thread", async () => {
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ ts: "1.1", thread_ts: "1.1" }));
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect("thread" in lines[0]!).toBe(false);
  });

  test("a plain message carries no thread field at all", async () => {
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "anything" })); // no thread_ts, default ts=1.1
    await pump(5);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect("thread" in lines[0]!).toBe(false);
  });

  test("the FIRST socket-open refusal fails listen with code 1 instead of retrying", async () => {
    // A connection that has never once succeeded must FAIL OUT (code 1 —
    // "scramble could not look"), not silently retry the same refusal into an
    // unattended loop. The report names both Slack's error and the appToken key.
    const h = make({}, async (url) => {
      if (url.includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: false, error: "invalid_token" }), { status: 200 });
      return okRouter(url);
    });
    const problems: string[] = [];
    const p = h.backend.listen([], "alice", () => {}, (pr) => problems.push(pr));
    await pump();
    const code = await p;
    expect(code).toBe(1);
    expect(problems.some((pr) => pr.includes("invalid_token") && pr.includes("appToken"))).toBe(true);
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

  test("a refused append-to open exits 1 (could not look), not the quiet-channel 64, and names invalid_auth and appToken", async () => {
    // A broken credential must not read as a silent channel: `next` against an
    // invalid app token fails nonzero with both Slack's error and the config key.
    // `make()` keeps the clock fixed so the open-refusal (a fast HTTP answer)
    // settles before any timeout — exactly the ordering a real next() sees where
    // the connection is refused in milliseconds against a seconds-long timeout.
    const h = make({}, async (url) => {
      if (url.includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: false, error: "invalid_token" }), { status: 200 });
      return okRouter(url);
    });
    const problems: string[] = [];
    const q = await h.backend.next([], "alice", 1, (pr) => problems.push(pr));
    await pump(5);
    expect(q.code).toBe(1);
    expect(problems.some((pr) => pr.includes("invalid_token") && pr.includes("appToken"))).toBe(true);
  });

  test("a live connection that then times out still exits 64 (quiet channel)", async () => {
    // With the socket OPENED (a working app token), a no-message timeout is the
    // honest quiet-channel result and stays 64.
    const h = makeTimed(); // socket open succeeds (okRouter)
    const p = h.backend.next([], "alice", 1, () => {});
    const r = await p;
    expect(r).toEqual({ code: 64 });
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

  test("listen through the slack backend streams a line and stays connected", async () => {
    const sockets: FakeSocket[] = [];
    const { io, writes } = configuredIo({
      // disable the status-expiry ticker so the reconnecting listen (which never
      // resolves) leaves no lingering timer behind; the delivered line already
      // proves the stream works.
      env: (n) => (n === "SCRAMBLE_STATUS" ? "off" : undefined),
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
    // listen reconnects on a drop and never resolves in the healthy path; the
    // delivered line is already written, so assert and leave main pending.
    expect(writes).toHaveLength(1);
    void p;
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

  test("a slack listen socket-refusal reports on stderr and exits nonzero", async () => {
    const { io, errs } = configuredIo({
      fetch: async (url) => {
        if (String(url).includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: false, error: "invalid_token" }), { status: 200 });
        return okRouter(url);
      },
      createSocket: () => new FakeSocket(),
    });
    const code = await main(["listen", "--as", "alice", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs.some((l) => l.includes("invalid_token") && l.includes("appToken"))).toBe(true);
  });

  test("a slack next socket-refusal exits 1 (could not look), not the quiet-channel 64", async () => {
    // A broken credential must surface as "scramble could not look" (code 1),
    // never as 64 (a quiet channel): the stderr names both the Slack error and
    // the appToken config key.
    const { io, errs } = configuredIo({
      fetch: async (url) => {
        if (String(url).includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
        return okRouter(url);
      },
      createSocket: () => new FakeSocket(),
    });
    const code = await main(["next", "--as", "alice", "--backend", "slack", "--timeout", "1"], io);
    expect(code).toBe(1);
    expect(errs.some((l) => l.includes("invalid_auth") && l.includes("appToken"))).toBe(true);
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
        // The inbound download rides the ACTING agent's (alice's) bot token,
        // because file access follows the app.
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer T_ALICE");
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
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
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
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.files![0]!.id).toBe("F2");
    expect(lines[0]!.files![0]!.path).toBeUndefined();
    expect(problems.some((pr) => pr.includes("not the file"))).toBe(true);
  });

  test("a message with no files carries no files field at all", async () => {
    const dir = filesDir();
    const h = make({ filesDir: dir });
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "no file here" }));
    await pump(8);
    // listen reconnects on a drop (it never resolves in the healthy
    // path), so the assertions above already ran; do not await p.
    void p;
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

// --- acting-agent credentials -------------------------------------------
// THE DEFECT: only `post` honored the acting agent's credential; every other
// call (read, threaded-reply expansion, attachment download, socket connect)
// used the config's DEFAULT token as whoever the acting agent was. These tests
// prove each path now uses the ACTING agent's credential, with the default as
// the fallback only.

describe("acting-agent credentials", () => {
  test("a read as agent B (with a token) goes out with B's token", async () => {
    // alice has her own token T_ALICE; a history read as alice must carry it.
    const h = make({}, async (url) => {
      if (String(url).includes(HISTORY)) {
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1", user: "U111", text: "hi" }] }), { status: 200 });
      }
      return okRouter(String(url));
    });
    const r = await h.backend.history("general", undefined, undefined, "alice");
    expect(r.code).toBe(0);
    const call = h.fetches.find((f) => f.url.includes(HISTORY))!;
    expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer T_ALICE");
  });

  test("a read as an agent with no token of its own uses the DEFAULT token", async () => {
    // bob owns no token in the base config, so his read must use the default.
    const h = make({}, async (url) => {
      if (String(url).includes(HISTORY)) {
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1", user: "U111", text: "hi" }] }), { status: 200 });
      }
      return okRouter(String(url));
    });
    const r = await h.backend.history("general", undefined, undefined, "bob");
    expect(r.code).toBe(0);
    const call = h.fetches.find((f) => f.url.includes(HISTORY))!;
    expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer xoxb-app");
  });

  test("a threaded-reply expansion uses the acting agent's token", async () => {
    // alice's credential must ride the conversations.replies call too.
    const h = make({}, async (url) => {
      if (String(url).includes(REPLIES)) {
        return new Response(JSON.stringify({ ok: true, messages: [
          { ts: "5.0", thread_ts: "5.0", user: "U111", text: "root dup" },
          { ts: "5.1", thread_ts: "5.0", user: "U111", text: "reply" },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, messages: [
        { ts: "5.0", thread_ts: "5.0", reply_count: 1, user: "U111", text: "root" },
      ] }), { status: 200 });
    });
    const r = await h.backend.history("general", undefined, undefined, "alice");
    expect(r.code).toBe(0);
    // the root itself renders with T_ALICE on its history call
    expect(r.messages.find((m) => m.text === "root")).toBeTruthy();
    expect(r.messages.find((m) => m.text === "reply")).toBeTruthy();
    const repl = h.fetches.find((f) => f.url.includes(REPLIES))!;
    expect((repl.init?.headers as Record<string, string>).authorization).toBe("Bearer T_ALICE");
  });

  test("the inbound attachment download rides the acting agent's token", async () => {
    // listen as alice: the download of the message's file carries T_ALICE.
    const dir = makeTmpDir("scrb-cred");
    const bytes = new TextEncoder().encode("BYTES");
    const h = make({ filesDir: dir }, async (url, init) => {
      if (String(url).includes("files.slack.com") && init?.headers) {
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer T_ALICE");
        return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      return okRouter(String(url));
    });
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "file", files: [{ id: "FC", name: "c.bin", url_private: "https://files.slack.com/fc", mimetype: "application/octet-stream" }] }));
    await pump(12);
    // listen reconnects on a drop (it never resolves in the healthy path), so
    // the assertions above already ran; do not await p.
    void p;
    expect(lines[0]!.files![0]!.path).toContain("FC-c.bin");
  });

  test("the socket connect uses the acting agent's appToken when present", async () => {
    // carol has her own appToken; a listen as carol must open with it.
    const h = make(
      { agents: { carol: { token: "T_C", appToken: "xapp-carol" }, bob: {} } },
      async (url) => {
        if (String(url).includes(SOCKET_OPEN)) {
          return new Response(JSON.stringify({ ok: true, url: "wss://s" }), { status: 200 });
        }
        return okRouter(String(url));
      },
    );
    const p = h.backend.listen([], "carol", () => {}, () => {});
    await pump();
    // listen reconnects on a drop (it never resolves in the healthy path), so
    // the assertions above already ran; do not await p.
    void p;
    const open = h.fetches.find((f) => f.url.includes(SOCKET_OPEN))!;
    expect((open.init?.headers as Record<string, string>).authorization).toBe("Bearer xapp-carol");
  });

  test("the socket connect falls back to the top-level appToken when an agent has none", async () => {
    // alice has no per-agent appToken, so her connect must use xapp-1.
    const h = make({}, async (url) => {
      if (String(url).includes(SOCKET_OPEN)) {
        return new Response(JSON.stringify({ ok: true, url: "wss://s" }), { status: 200 });
      }
      return okRouter(String(url));
    });
    const p = h.backend.listen([], "alice", () => {}, () => {});
    await pump();
    // listen reconnects on a drop (it never resolves in the healthy path), so
    // the assertions above already ran; do not await p.
    void p;
    const open = h.fetches.find((f) => f.url.includes(SOCKET_OPEN))!;
    expect((open.init?.headers as Record<string, string>).authorization).toBe("Bearer xapp-1");
  });

  test("a read with no per-agent token and no default fails naming the agent and the key", async () => {
    // token:"" (no default) and dave has no token: the read must FAIL loud.
    const h = make({ token: "", agents: { dave: { appToken: "xapp-dave" } } });
    const r = await h.backend.history("general", undefined, undefined, "dave");
    expect(r.code).toBe(1);
    expect(r.error).toContain("dave");
    expect(r.error).toContain("token");
  });
});
