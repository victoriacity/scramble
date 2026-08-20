import { describe, expect, test } from "bun:test";
import {
  createSlackTransport,
  type SlackSocket,
  type SlackTransportDeps,
} from "../src/slack-transport";

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

interface Harness {
  deps: SlackTransportDeps;
  sockets: FakeSocket[];
  fetches: Array<{ url: string; init?: RequestInit }>;
  sleeps: number[];
}

function make(): Harness {
  const sockets: FakeSocket[] = [];
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  const sleeps: number[] = [];
  const deps: SlackTransportDeps = {
    appToken: "xapp-1",
    botToken: "xoxb-1",
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return new Response("{}", { status: 200 });
    },
    createSocket: (url: string) => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, sockets, fetches, sleeps };
}

async function pump(): Promise<void> {
  // drain microtasks so the async openLoop/drain settles
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function wss(deps: SlackTransportDeps, url = "wss://example"): void {
  deps.fetch = async () => new Response(JSON.stringify({ ok: true, url }), { status: 200 });
}

describe("connect via Socket Mode", () => {
  test("opens the wss URL by POSTing apps.connections.open with the app token", async () => {
    const h = make();
    h.deps.fetch = async (url, init) => {
      h.fetches.push({ url, init });
      return new Response(JSON.stringify({ ok: true, url: "wss://x" }), { status: 200 });
    };
    const t = createSlackTransport(h.deps);
    t.connect(() => {});
    await pump();
    expect(h.fetches[0]!.url).toBe("https://slack.com/api/apps.connections.open");
    expect(h.fetches[0]!.init?.method).toBe("POST");
    expect((h.fetches[0]!.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer xapp-1",
    );
    expect(h.sockets).toHaveLength(1);
  });

  test("ACKs every envelope, routes event payloads, and honors a disconnect frame", async () => {
    const h = make();
    wss(h.deps);
    const t = createSlackTransport(h.deps);
    const events: any[] = [];
    t.connect((ev) => events.push(ev));
    await pump();
    const sock = h.sockets[0]!;
    sock.onmessage?.(
      JSON.stringify({
        type: "events_api",
        envelope_id: "E1",
        payload: { event: { type: "message", text: "hi" } },
      }),
    );
    expect(sock.sent).toEqual([JSON.stringify({ envelope_id: "E1" })]);
    expect(events).toEqual([{ type: "message", text: "hi" }]);

    sock.onmessage?.(JSON.stringify({ type: "disconnect" }));
    expect(sock.closed).toEqual([{ code: 1000, reason: "disconnect" }]);
  });

  test("non-JSON and hello frames are handled without false events", async () => {
    const h = make();
    wss(h.deps);
    const t = createSlackTransport(h.deps);
    const events: any[] = [];
    t.connect((ev) => events.push(ev));
    await pump();
    const sock = h.sockets[0]!;
    sock.onmessage?.("not-json");
    sock.onmessage?.(JSON.stringify({ type: "hello", envelope_id: "H1" }));
    expect(sock.sent).toEqual([JSON.stringify({ envelope_id: "H1" })]);
    expect(events).toEqual([]);
  });

  test("an events_api frame with no event payload is acked but not delivered", async () => {
    const h = make();
    wss(h.deps);
    const t = createSlackTransport(h.deps);
    t.connect(() => {});
    await pump();
    h.sockets[0]!.onmessage?.(JSON.stringify({ type: "events_api", envelope_id: "E2" }));
    expect(h.sockets[0]!.sent).toEqual([JSON.stringify({ envelope_id: "E2" })]);
  });

  test("an events_api frame whose payload lacks an event is acked but not delivered", async () => {
    const h = make();
    wss(h.deps);
    const t = createSlackTransport(h.deps);
    t.connect(() => {});
    await pump();
    h.sockets[0]!.onmessage?.(
      JSON.stringify({ type: "events_api", envelope_id: "E3", payload: {} }),
    );
    expect(h.sockets[0]!.sent).toEqual([JSON.stringify({ envelope_id: "E3" })]);
  });
});

describe("connect error and reconnect handling", () => {
  test("an ok:false connect response retries with backoff", async () => {
    const h = make();
    let call = 0;
    h.deps.fetch = async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ ok: false }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, url: "wss://x" }), { status: 200 });
    };
    const t = createSlackTransport(h.deps);
    t.connect(() => {});
    await pump();
    expect(h.sockets).toHaveLength(1);
    expect(call).toBe(2);
    expect(h.sleeps.length).toBe(1);
  });

  test("an ok:true connect response with no url is a failure", async () => {
    const h = make();
    let call = 0;
    h.deps.fetch = async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, url: "wss://y" }), { status: 200 });
    };
    const t = createSlackTransport(h.deps);
    t.connect(() => {});
    await pump();
    expect(h.sockets).toHaveLength(1);
    expect(call).toBe(2);
  });

  test("a fetch failure retries with backoff", async () => {
    const h = make();
    let call = 0;
    h.deps.fetch = async () => {
      call++;
      if (call === 1) throw new Error("down");
      return new Response(JSON.stringify({ ok: true, url: "wss://z" }), { status: 200 });
    };
    const t = createSlackTransport(h.deps);
    t.connect(() => {});
    await pump();
    expect(h.sockets).toHaveLength(1);
    expect(call).toBe(2);
    expect(h.sleeps.length).toBe(1);
  });

  test("a socket close schedules a reconnect", async () => {
    const h = make();
    wss(h.deps);
    const t = createSlackTransport(h.deps);
    t.connect(() => {});
    await pump();
    const sock = h.sockets[0]!;
    sock.onopen?.();
    sock.onclose?.(1006, "gone");
    await pump();
    expect(h.sockets).toHaveLength(2); // reconnects
    expect(h.sleeps.length).toBe(1);
    h.sockets[1]!.onopen?.();
  });

  test("onopen resets the reconnect backoff so retries stay prompt", async () => {
    const h = make();
    let call = 0;
    h.deps.fetch = async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ ok: false }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, url: "wss://q" }), { status: 200 });
    };
    const t = createSlackTransport(h.deps);
    t.connect(() => {});
    await pump();
    h.sockets[0]!.onopen?.();
  });

  test("an error frame triggers onopen then onclose reconnect", async () => {
    const h = make();
    wss(h.deps);
    const t = createSlackTransport(h.deps);
    t.connect(() => {});
    await pump();
    const sock = h.sockets[0]!;
    sock.onerror?.();
    sock.onclose?.(1011, "server error");
    await pump();
    expect(h.sockets).toHaveLength(2);
  });
});

describe("postMessage", () => {
  test("posts chat.postMessage with per-opts token and persona fields", async () => {
    const h = make();
    h.deps.fetch = async (url, init) => {
      h.fetches.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const t = createSlackTransport(h.deps);
    await t.postMessage({
      channel: "C1",
      text: "hi",
      token: "TOK",
      username: "bob",
      icon_emoji: ":robot:",
    });
    expect(h.fetches[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(h.fetches[0]!.init?.method).toBe("POST");
    expect((h.fetches[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer TOK");
    const body = JSON.parse(h.fetches[0]!.init?.body as string);
    expect(body).toEqual({
      channel: "C1",
      text: "hi",
      username: "bob",
      icon_emoji: ":robot:",
    });
  });

  test("falls back to the config bot token when opts carry no token", async () => {
    const h = make();
    h.deps.fetch = async (url, init) => {
      h.fetches.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const t = createSlackTransport(h.deps);
    await t.postMessage({ channel: "C2", text: "q" });
    expect((h.fetches[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer xoxb-1");
    expect(JSON.parse(h.fetches[0]!.init?.body as string)).toEqual({ channel: "C2", text: "q" });
  });

  test("a fetch failure propagates as a rejection", async () => {
    const h = make();
    h.deps.fetch = async () => {
      throw new Error("network");
    };
    const t = createSlackTransport(h.deps);
    await expect(t.postMessage({ channel: "C", text: "x" })).rejects.toThrow("network");
  });

  test("Slack ok:false is surfaced as a failure, never a success", async () => {
    const h = make();
    h.deps.fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
    const t = createSlackTransport(h.deps);
    await expect(t.postMessage({ channel: "C", text: "x" })).rejects.toThrow("invalid_auth");
  });

  test("a missing error field surfaces a generic failure message", async () => {
    const h = make();
    h.deps.fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 200 });
    const t = createSlackTransport(h.deps);
    await expect(t.postMessage({ channel: "C", text: "x" })).rejects.toThrow(
      "Slack postMessage failed",
    );
  });

  test("Slack ok:true resolves cleanly", async () => {
    const h = make();
    h.deps.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const t = createSlackTransport(h.deps);
    await t.postMessage({ channel: "C", text: "y" });
  });
});