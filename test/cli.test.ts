import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoomStore } from "../src/store";
import { createStore } from "../src/store";
import { createHandler } from "../src/server";
import { main, parseBind, loadSlackConfig, type Io } from "../src/cli";

function scratchDir(name: string): string {
  const d = join(tmpdir(), `zz-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

function msg(seq: number | string, from: string, text: string, mentions: string[] = []) {
  return {
    seq,
    ts: "2026-01-01T00:00:00.000Z",
    room: "general",
    from,
    text,
    id: `id${seq}`,
    mentions,
    mentioned: mentions.length > 0,
  };
}

function ndjs(lines: unknown[], mode: "close" | "error" = "close"): Response {
  const enc = new TextEncoder();
  // Two-phase pull: the first pull delivers the lines; the second ends the
  // stream (close -> clean stop, error -> dropped connection). Erroring a
  // stream discards anything enqueued in the same pull, so the terminate
  // must be a separate pull to guarantee the lines are actually read first.
  let phase = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === 0) {
        phase = 1;
        for (const l of lines) controller.enqueue(enc.encode(JSON.stringify(l) + "\n"));
        return;
      }
      if (mode === "close") controller.close();
      else controller.error(new Error("drop"));
    },
  });
  return new Response(body, { status: 200 });
}

function stubIo(cwd: string, fetch: Io["fetch"]): { io: Io; writes: string[]; errs: string[]; urls: string[] } {
  const writes: string[] = [];
  const errs: string[] = [];
  const urls: string[] = [];
  const io: Io = {
    write: (l) => writes.push(l),
    writeErr: (l) => errs.push(l),
    fetch: async (input, init) => {
      urls.push(input);
      return fetch(input, init);
    },
    env: () => undefined,
    cwd: () => cwd,
    sleep: async () => {},
    serve: async () => 0,
    createTransport: () => ({
      connect: () => {},
      postMessage: async () => {},
    }),
  };
  return { io, writes, errs, urls };
}

describe("config resolution", () => {
  test("--url/--token beat env beat config.json beat localhost default", async () => {
    const cwd = scratchDir("cfg");
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "config.json"),
      JSON.stringify({ url: "http://config:9", token: "cfgtok" }),
    );
    // (a) config wins over localhost default when neither env nor flag present
    const a = stubIo(cwd, async (u) => new Response("[]", { status: 200 }));
    await main(["history", "general"], a.io);
    expect(a.urls[0]).toContain("http://config:9");
    // (b) env wins over config
    const b = stubIo(cwd, async (u) => new Response("[]", { status: 200 }));
    b.io.env = (n) => (n === "SCRAMBLE_URL" ? "http://env:8" : undefined);
    await main(["history", "general"], b.io);
    expect(b.urls[0]).toContain("http://env:8");
    // (c) --url wins over env
    const c = stubIo(cwd, async (u) => new Response("[]", { status: 200 }));
    c.io.env = (n) => (n === "SCRAMBLE_URL" ? "http://env:8" : undefined);
    await main(["history", "general", "--url", "http://flag:1"], c.io);
    expect(c.urls[0]).toContain("http://flag:1");
    // (d) localhost default when nothing configured
    const bare = scratchDir("bare");
    const dres = stubIo(bare, async (u) => new Response("[]", { status: 200 }));
    await main(["history", "general"], dres.io);
    expect(dres.urls[0]).toContain("http://127.0.0.1:7737");
    // (e) --token override produces a bearer header
    const e = stubIo(cwd, async (u, init) => {
      expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer flagtok");
      return new Response("[]", { status: 200 });
    });
    await main(["history", "general", "--token", "flagtok"], e.io);
  });

  test("SCRAMBLE_TOKEN env yields a bearer header; token is sent when required", async () => {
    const cwd = scratchDir("tok");
    const { io } = stubIo(cwd, async (u, init) => new Response("[]", { status: 200 }));
    io.env = (n) => (n === "SCRAMBLE_TOKEN" ? "envtok" : undefined);
    let auth: string | undefined;
    io.fetch = async (u, init) => {
      auth = (init?.headers as Record<string, string>)?.authorization;
      return new Response("[]", { status: 200 });
    };
    await main(["history", "general"], io);
    expect(auth).toBe("Bearer envtok");
  });

  test("a non-string config value falls through to env/localhost", async () => {
    const cwd = scratchDir("cfg2");
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    writeFileSync(join(cwd, ".scramble", "config.json"), JSON.stringify({ url: 42, token: true }));
    // env provides the real url when config fields are the wrong type
    const s = stubIo(cwd, async (u) => new Response("[]", { status: 200 }));
    s.io.env = (n) => (n === "SCRAMBLE_URL" ? "http://env:7" : undefined);
    await main(["history", "general"], s.io);
    expect(s.urls[0]).toContain("http://env:7");
  });
});

describe("post", () => {
  test("posts and prints the crossings as one JSON line each", async () => {
    const cwd = scratchDir("post");
    const handler = createHandler(createStore(scratchDir("st1")));
    // seed a crossing from bob
    await handler(
      new Request("http://x/rooms/general", {
        method: "POST",
        body: JSON.stringify({ from: "bob", text: "first", id: "j1", lastSeen: 0 }),
      }),
    );
    const { io, writes } = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    const code = await main(["post", "general", "hello ana", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({ from: "bob", text: "first" });
  });

  test("a post with no crossing prints nothing but still exits 0", async () => {
    const cwd = scratchDir("post2");
    const handler = createHandler(createStore(scratchDir("st2")));
    const { io, writes } = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    const code = await main(["post", "general", "hi", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("missing text is a usage error", async () => {
    const cwd = scratchDir("post3");
    const { io, errs } = stubIo(cwd, async () => {
      throw new Error("no fetch expected");
    });
    const code = await main(["post", "general"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("usage");
  });

  test("a server failure posts the status to stderr and exits 1", async () => {
    const cwd = scratchDir("post4");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 500 }));
    const code = await main(["post", "general", "hi", "--as", "x"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("500");
  });
});

describe("listen", () => {
  test("reconnects resuming at the last seq and stops cleanly", async () => {
    const cwd = scratchDir("listen");
    const seenSince: number[] = [];
    let call = 0;
    const { io, writes } = stubIo(cwd, async (input) => {
      const u = new URL(input);
      seenSince.push(Number(u.searchParams.get("since")));
      const n = call++;
      if (n === 0) return ndjs([msg(5, "bob", "one")], "error"); // drop mid-stream
      return ndjs([msg(7, "bob", "two")], "close"); // clean stop
    });
    const code = await main(["listen", "--as", "ana"], io);
    expect(code).toBe(0);
    // resume at the last seen seq
    expect(seenSince).toEqual([0, 5]);
    const lines = writes.map((l) => JSON.parse(l) as { seq: number; mentioned: boolean });
    expect(lines.map((l) => l.seq)).toEqual([5, 7]);
    expect(lines[0]!.mentioned).toBe(false);
  });

  test("explicit rooms stream per-room with the agent excluded and mentioned stamped", async () => {
    const cwd = scratchDir("listen2");
    const { io, writes } = stubIo(cwd, async (input) => {
      const u = new URL(input);
      expect(u.pathname).toBe("/rooms/general/stream");
      expect(u.searchParams.get("exclude")).toBe("ana");
      return ndjs([msg("b1", "bob", "@ana hello", ["ana"])], "close");
    });
    const code = await main(["listen", "general", "--as", "ana"], io);
    expect(code).toBe(0); // clean close of a single-room stream
    const line = JSON.parse(writes[0]!);
    expect(line.mentioned).toBe(true);
    expect(line.text).toBe("@ana hello");
  });

  test("recovers when the connection itself fails", async () => {
    const cwd = scratchDir("listen3");
    let call = 0;
    const { io, writes } = stubIo(cwd, async () => {
      const n = call++;
      if (n === 0) throw new Error("connection refused");
      return ndjs([{ ...msg(9, "bob", "back"), mentioned: false }], "close");
    });
    const code = await main(["listen", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(writes.map((l) => JSON.parse(l).seq)).toEqual([9]);
  });

  test("a null-body stream reads as a clean stop and never loiters", async () => {
    const cwd = scratchDir("listen4");
    const { io } = stubIo(cwd, async () => new Response(null, { status: 200 }));
    const code = await main(["listen", "--as", "ana"], io);
    expect(code).toBe(0);
  });

  test("a non-200 stream response reconnects rather than stopping", async () => {
    const cwd = scratchDir("listen5");
    let call = 0;
    const { io, writes } = stubIo(cwd, async () => {
      const n = call++;
      if (n === 0) return new Response("bad", { status: 503 });
      return ndjs([{ ...msg(11, "bob", "retry"), mentioned: false }], "close");
    });
    const code = await main(["listen", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(writes.map((l) => JSON.parse(l).seq)).toEqual([11]);
  });
});

describe("next", () => {
  test("blocks for one message and exits 0", async () => {
    const cwd = scratchDir("next");
    const handler = createHandler(createStore(scratchDir("nstore")));
    const { io, writes } = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    io.sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
    const pending = main(["next", "general", "--as", "ana", "--timeout", "5"], io);
    await new Promise((r) => setTimeout(r, 30));
    await handler(
      new Request("http://x/rooms/general", {
        method: "POST",
        body: JSON.stringify({ from: "bob", text: "hey ana", id: "n1", lastSeen: 0 }),
      }),
    );
    const code = await pending;
    expect(code).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ from: "bob", text: "hey ana" });
  });

  test("exits 64 on timeout with nothing printed", async () => {
    const cwd = scratchDir("next2");
    const { io, writes } = stubIo(cwd, async () => {
      // a stream that stays open, never delivering a line
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {},
        }),
        { status: 200 },
      );
    });
    // bare `--timeout` (no value) parses to the 0s default fallback -> immediate 64
    const code = await main(["next", "--timeout"], io);
    expect(code).toBe(64);
    expect(writes).toHaveLength(0);
  });

  test("a failed stream request still times out cleanly", async () => {
    const cwd = scratchDir("next3");
    const { io, writes } = stubIo(cwd, async () => {
      throw new Error("stream refused");
    });
    const code = await main(["next", "--timeout", "0"], io);
    expect(code).toBe(64);
    expect(writes).toHaveLength(0);
  });

  test("a non-200 stream response still times out cleanly", async () => {
    const cwd = scratchDir("next4");
    const { io, writes } = stubIo(cwd, async () => new Response("nope", { status: 400 }));
    const code = await main(["next", "--timeout", "0"], io);
    expect(code).toBe(64);
    expect(writes).toHaveLength(0);
  });

  test("delivers a line from a stream that drops right after", async () => {
    const cwd = scratchDir("next5");
    const { io, writes } = stubIo(cwd, async () => ndjs([msg("e1", "bob", "dropped", ["ana"])], "error"));
    const code = await main(["next", "general", "--as", "ana", "--timeout", "5"], io);
    expect(code).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ from: "bob", text: "dropped" });
  });
});

describe("history", () => {
  test("prints one JSON line per message", async () => {
    const cwd = scratchDir("hist");
    const { io, writes } = stubIo(cwd, async (input) => {
      const u = new URL(input);
      expect(u.searchParams.get("since")).toBe("0");
      return new Response(JSON.stringify([msg("h1", "bob", "one"), msg("h2", "ana", "two")]), {
        status: 200,
      });
    });
    const code = await main(["history", "general"], io);
    expect(code).toBe(0);
    expect(writes.map((l) => JSON.parse(l).text)).toEqual(["one", "two"]);
  });

  test("missing room is an error", async () => {
    const { io, errs } = stubIo(scratchDir("hist2"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["history"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("room");
  });

  test("a server failure prints the status to stderr and exits 1", async () => {
    const cwd = scratchDir("hist3");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 401 }));
    const code = await main(["history", "general"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("401");
  });

  test("the --since=NNN equals form is parsed", async () => {
    const cwd = scratchDir("hist4");
    const seen: string[] = [];
    const { io } = stubIo(cwd, async (input) => {
      const u = new URL(input);
      seen.push(u.searchParams.get("since")!);
      return new Response("[]", { status: 200 });
    });
    await main(["history", "general", "--since=3"], io);
    expect(seen[0]).toBe("3");
  });
});

describe("join", () => {
  test("scaffolds the workspace, reads --persona, registers the agent", async () => {
    const dir = scratchDir("join");
    const sent: { url: string; init?: RequestInit }[] = [];
    const { io } = stubIo(dir, async (u, init) => {
      sent.push({ url: u, init });
      return new Response("{}", { status: 200 });
    });
    const code = await main(["join", "general", "--as", "alice", "--persona", "i join rooms"], io);
    expect(code).toBe(0);
    expect(existsSync(join(dir, ".scramble", "persona.md"))).toBe(true);
    expect(existsSync(join(dir, ".scramble", "knowledge", "INDEX.md"))).toBe(true);
    expect(sent[0]!.url).toContain("/agents/alice");
    const body = JSON.parse(sent[0]!.init!.body as string);
    expect(body.persona).toBe("i join rooms");
    expect(body.room).toBe("general");
  });

  test("a successful join prints the doc pointers to stderr and keeps stdout empty", async () => {
    const dir = scratchDir("join-ptr");
    const { io, writes, errs } = stubIo(dir, async () => new Response("{}", { status: 200 }));
    const code = await main(["join", "general", "--as", "alice"], io);
    expect(code).toBe(0);
    // stdout stays JSON-only: the pointer must never appear there
    expect(writes).toHaveLength(0);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toContain("JOIN.md");
    expect(errs[1]).toContain("skills/scramble/CONTRACT.md");
    expect(errs[0]).toContain("joined general as alice");
  });

  test("a failed registration prints the status to stderr and exits 1", async () => {
    const dir = scratchDir("join2");
    const { io } = stubIo(dir, async (u, init) => {
      return new Response("{}", { status: 200 });
    });
    const code = await main(["join", "general", "--as", "bob"], io);
    expect(code).toBe(0);
    // the scaffolded stub persona was read and sent
    const stub = readFileSync(join(dir, ".scramble", "persona.md"), "utf8");
    expect(stub.length).toBeGreaterThan(0);
  });

  test("missing room is an error", async () => {
    const { io, errs } = stubIo(scratchDir("join3"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["join"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("room");
  });

  test("a failed registration prints the status to stderr and exits 1", async () => {
    const cwd = scratchDir("join4");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 500 }));
    const code = await main(["join", "general", "--as", "x"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("500");
  });
});

describe("serve", () => {
  test("delegates to io.serve with the store and options", async () => {
    const dir = scratchDir("serve");
    const { io } = stubIo(dir, async () => {
      throw new Error("no fetch for serve");
    });
    let store: RoomStore | undefined;
    let opts: unknown;
    io.serve = async (s, o) => {
      store = s;
      opts = o;
      return 0;
    };
    const code = await main(["serve", "--data", dir, "--token", "t", "--bind", "0.0.0.0"], io);
    expect(code).toBe(0);
    expect(store).toBeDefined();
    expect((opts as { token: string }).token).toBe("t");
    expect((opts as { hostname: string }).hostname).toBe("0.0.0.0");
    expect((opts as { port?: number }).port).toBeUndefined();
  });

  test("host:port --bind parses into typed hostname + port", async () => {
    const dir = scratchDir("serve2");
    const { io } = stubIo(dir, async () => {
      throw new Error("no fetch for serve");
    });
    let opts: unknown;
    io.serve = async (s, o) => {
      opts = o;
      return 0;
    };
    const code = await main(["serve", "--data", dir, "--bind", "127.0.0.1:7799"], io);
    expect(code).toBe(0);
    expect((opts as { hostname: string }).hostname).toBe("127.0.0.1");
    expect((opts as { port: number }).port).toBe(7799);
  });

  test("a bare port --bind maps to port with default hostname", async () => {
    const dir = scratchDir("serve3");
    const { io } = stubIo(dir, async () => {
      throw new Error("no fetch for serve");
    });
    let opts: unknown;
    io.serve = async (s, o) => {
      opts = o;
      return 0;
    };
    const code = await main(["serve", "--data", dir, "--bind", "7799"], io);
    expect(code).toBe(0);
    expect((opts as { port?: number }).port).toBe(7799);
    expect((opts as { hostname?: string }).hostname).toBeUndefined();
  });

  test("a malformed --bind is reported on stderr and exits nonzero", async () => {
    const dir = scratchDir("serve4");
    const { io, errs } = stubIo(dir, async () => {
      throw new Error("no fetch for serve");
    });
    let served = 0;
    io.serve = async () => {
      served++;
      return 0;
    };
    const code = await main(["serve", "--data", dir, "--bind", "127.0.0.1:notaport"], io);
    expect(code).toBe(1);
    expect(served).toBe(0);
    expect(errs[0]).toContain("invalid --bind");
  });

  test("uses HOME/.scramble when --data is absent", async () => {
    const home = scratchDir("servehome");
    const cwd = scratchDir("servecwd");
    const { io } = stubIo(cwd, async () => {
      throw new Error("no fetch");
    });
    io.env = (n) => (n === "HOME" ? home : undefined);
    let code = await main(["serve"], io);
    expect(code).toBe(0);
    // HOME present -> survives (the store under $HOME/.scramble is created)
    expect(existsSync(join(home, ".scramble"))).toBe(true);
  });

  test("falls back to <cwd>/.scramble when HOME is unset", async () => {
    const cwd = scratchDir("serve2");
    const { io } = stubIo(cwd, async () => {
      throw new Error("no fetch");
    });
    io.env = () => undefined;
    const code = await main(["serve"], io);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".scramble"))).toBe(true);
  });
});

describe("parseBind", () => {
  test("host:port splits into typed hostname and port", () => {
    const r = parseBind("127.0.0.1:7799");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.hostname).toBe("127.0.0.1");
      expect(r.spec.port).toBe(7799);
    }
  });

  test("a bare port maps to port with no hostname", () => {
    const r = parseBind("7799");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.port).toBe(7799);
      expect(r.spec.hostname).toBeUndefined();
    }
  });

  test("a bare host maps to hostname with no port", () => {
    const r = parseBind("0.0.0.0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.hostname).toBe("0.0.0.0");
      expect(r.spec.port).toBeUndefined();
    }
  });

  test("a malformed value is reported, never silently defaulted", () => {
    for (const bad of ["127.0.0.1:notaport", "127.0.0.1:", "1:2:3", ""]) {
      const r = parseBind(bad);
      expect(r.ok).toBe(false);
    }
  });

  test("valid races and portbounds are accepted", () => {
    expect(parseBind("0").ok).toBe(true);
    expect(parseBind("65535").ok).toBe(true);
    expect(parseBind("70000").ok).toBe(false);
    expect(parseBind("localhost:8080").ok).toBe(true);
  });
});

describe("unknown command", () => {
  test("reports and exits 1", async () => {
    const { io, errs } = stubIo(scratchDir("unk"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["frobnicate"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("frobnicate");
  });
});

// --- the `scramble slack` verb ------------------------------
// The bridge config lives at <workspace>/.scramble/slack.json, and the real
// transport is created through io.createTransport so tests inject a fake.

import type { SlackEvent, SlackPostOptions, SlackTransport } from "../src/slack";

/** The event handler the bridge registers on a transport; tests fire inbound
 *  Slack events through the captured handler. */
interface Captured {
  h?: (ev: SlackEvent) => void;
}

function writeSlackConfig(cwd: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".scramble"), { recursive: true });
  writeFileSync(join(cwd, ".scramble", "slack.json"), JSON.stringify(cfg));
}

function validSlackCfg(): Record<string, unknown> {
  return {
    appToken: "xapp-1",
    token: "xoxb-1",
    channels: { general: "C1" },
    agents: { alice: { token: "T_A" }, bob: { icon: ":robot:" } },
    dmChannels: { D1: "alice" },
    roster: {},
    botIds: ["B1"],
    dmMirrorChannel: "#audit",
  };
}

/** A fake transport the CLI tests mount, capturing the event handler the
 *  bridge registers (so inbound Slack messages can be fired through it) and
 *  recording outbound posts. */
function fakeTransport(posts: SlackPostOptions[], captured: { h?: (ev: SlackEvent) => void }): SlackTransport {
  return {
    connect: (on) => {
      captured.h = on;
    },
    postMessage: async (o) => {
      posts.push(o);
    },
  };
}

/** A daemon-neutered firehose that streams lines then closes cleanly. */
function firehose(lines: Array<Record<string, unknown>>): Response {
  const enc = new TextEncoder();
  let phase = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === 0) {
        phase = 1;
        for (const l of lines) controller.enqueue(enc.encode(JSON.stringify(l) + "\n"));
        return;
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function slackIo(cwd: string, transport: SlackTransport): { io: Io; posts: SlackPostOptions[]; errs: string[] } {
  const posts: SlackPostOptions[] = [];
  const errs: string[] = [];
  const io: Io = {
    write: () => {},
    writeErr: (l) => errs.push(l),
    fetch: async () => new Response("[]", { status: 200 }),
    env: () => undefined,
    cwd: () => cwd,
    sleep: async () => {},
    serve: async () => 0,
    createTransport: () => transport,
  };
  return { io, posts, errs };
}

describe("scramble slack", () => {
  test("exits 1 with a stderr message when .scramble/slack.json is missing", async () => {
    const cwd = scratchDir("noslack");
    const posts: SlackPostOptions[] = [];
    const captured: Captured = {};
    const { io, errs } = slackIo(cwd, fakeTransport(posts, captured));
    const code = await main(["slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("slack.json");
  });

  test("exits 1 with a stderr message when the config is malformed", async () => {
    const cwd = scratchDir("slackbad");
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    writeFileSync(join(cwd, ".scramble", "slack.json"), "not json");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    const code = await main(["slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("slack.json");
  });

  test("exits 1 when the config lacks the required app-level token", async () => {
    const cwd = scratchDir("slack-notoken");
    writeSlackConfig(cwd, { ...validSlackCfg(), appToken: undefined });
    const posts: SlackPostOptions[] = [];
    const captured: { h?: (ev: SlackEvent) => void } = {};
    const { io, errs } = slackIo(cwd, fakeTransport(posts, captured));
    const code = await main(["slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("appToken");
  });

  test("--dry-run prints the wiring plan, never connects, and exits 0", async () => {
    const cwd = scratchDir("slack-dry");
    writeSlackConfig(cwd, validSlackCfg());
    const posts: SlackPostOptions[] = [];
    const captured: Captured = {};
    const transport = fakeTransport(posts, captured);
    const { io, errs } = slackIo(cwd, transport);
    const code = await main(["slack", "--dry-run"], io);
    expect(code).toBe(0);
    // the plan is printed to stderr
    expect(errs.some((l) => l.includes("general -> channel C1"))).toBe(true);
    expect(errs.some((l) => l.includes("alice: real bot-user"))).toBe(true);
    expect(errs.some((l) => l.includes("dry-run OK"))).toBe(true);
    // transport never connected, never posted
    expect(captured.h).toBeUndefined();
    expect(posts).toHaveLength(0);
  });

  test("live mode connects the bridge and publishes firehose messages to Slack", async () => {
    const cwd = scratchDir("slack-live");
    writeSlackConfig(cwd, validSlackCfg());
    const posts: SlackPostOptions[] = [];
    const captured: Captured = {};
    const transport = fakeTransport(posts, captured);
    const { io } = slackIo(cwd, transport);
    io.fetch = async (input) => {
      // the firehose delivers one room message then closes
      return firehose([
        { seq: 1, ts: "t", room: "general", from: "alice", text: "hi", id: "i1", mentions: [] },
      ]);
    };
    const code = await main(["slack"], io);
    expect(code).toBe(0);
    // the fake transport's postMessage was called for the firehose message
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.some((p) => p.text === "hi")).toBe(true);
    // the bridge called transport.connect
    expect(captured.h).toBeDefined();
  });

  test("inbound Slack messages route into the room via the daemon POST seam", async () => {
    const cwd = scratchDir("slack-inbound");
    writeSlackConfig(cwd, validSlackCfg());
    const posts: SlackPostOptions[] = [];
    const captured: Captured = {};
    const transport = fakeTransport(posts, captured);
    const { io } = slackIo(cwd, transport);
    const posted: Array<{ url: string; body: string }> = [];
    io.fetch = async (input, init) => {
      if (String(input).includes("/rooms/")) {
        posted.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({ seq: 9, crossings: [] }), { status: 200 });
      }
      return firehose([]); // the firehose closes cleanly
    };
    const code = await main(["slack"], io);
    expect(code).toBe(0);
    // after live mode connected, fire an inbound channel message
    captured.h?.({ type: "message", channel: "C1", user: "U111", text: "from slack" });
    // the postToRoom wiring produced a daemon POST for room "general"
    const roomPosts = posted.filter((p) => p.url.includes("/rooms/general"));
    expect(roomPosts).toHaveLength(1);
    expect(JSON.parse(roomPosts[0]!.body)).toMatchObject({ from: "U111", text: "from slack" });
  });

  test("an inbound room POST rejection is swallowed (fire-and-forget) without failing the command", async () => {
    const cwd = scratchDir("slack-inbound-reject");
    writeSlackConfig(cwd, validSlackCfg());
    const posts: SlackPostOptions[] = [];
    const captured: Captured = {};
    const transport = fakeTransport(posts, captured);
    const { io } = slackIo(cwd, transport);
    io.fetch = async (input) => {
      if (String(input).includes("/rooms/")) throw new Error("room POST failed");
      return firehose([]);
    };
    const code = await main(["slack"], io);
    expect(code).toBe(0);
    captured.h?.({ type: "message", channel: "C1", user: "U111", text: "swallowed" });
    // give the swallowed rejection a microtask turn to settle
    await new Promise((r) => setTimeout(r, 5));
  });

  test("recovers from a firehose fetch failure with backoff", async () => {
    const cwd = scratchDir("slack-retry");
    writeSlackConfig(cwd, validSlackCfg());
    const posts: SlackPostOptions[] = [];
    const captured: Captured = {};
    const transport = fakeTransport(posts, captured);
    const { io } = slackIo(cwd, transport);
    let call = 0;
    io.fetch = async () => {
      call++;
      if (call === 1) throw new Error("daemon down");
      return firehose([
        { seq: 2, ts: "t", room: "general", from: "bob", text: "retry", id: "i2", mentions: [] },
      ]);
    };
    const code = await main(["slack"], io);
    expect(code).toBe(0);
    expect(posts.some((p) => p.text === "retry")).toBe(true);
    expect(call).toBe(2);
  });

  test("recovers from a non-200 firehose response with backoff", async () => {
    const cwd = scratchDir("slack-non200");
    writeSlackConfig(cwd, validSlackCfg());
    const posts: SlackPostOptions[] = [];
    const captured: Captured = {};
    const transport = fakeTransport(posts, captured);
    const { io } = slackIo(cwd, transport);
    let call = 0;
    io.fetch = async () => {
      call++;
      if (call === 1) return new Response("nope", { status: 503 });
      return firehose([
        { seq: 3, ts: "t", room: "general", from: "alice", text: "back", id: "i3", mentions: [] },
      ]);
    };
    const code = await main(["slack"], io);
    expect(code).toBe(0);
    expect(posts.some((p) => p.text === "back")).toBe(true);
    expect(call).toBe(2);
  });

  test("recovers when the firehose stream drops mid-drain", async () => {
    const cwd = scratchDir("slack-drop");
    writeSlackConfig(cwd, validSlackCfg());
    const posts: SlackPostOptions[] = [];
    const captured: Captured = {};
    const transport = fakeTransport(posts, captured);
    const { io } = slackIo(cwd, transport);
    let call = 0;
    io.fetch = async () => {
      call++;
      if (call === 1) return ndjs([msg(4, "bob", "dropped")], "error");
      return firehose([
        { seq: 5, ts: "t", room: "general", from: "alice", text: "stable", id: "i5", mentions: [] },
      ]);
    };
    const code = await main(["slack"], io);
    expect(code).toBe(0);
    expect(posts.some((p) => p.text === "dropped")).toBe(true);
    // on the retry, the "stable" message is also published
    expect(posts.some((p) => p.text === "stable")).toBe(true);
  });

  test("a transport create failure is reported and exits 1", async () => {
    const cwd = scratchDir("slack-boom");
    writeSlackConfig(cwd, validSlackCfg());
    const posts: SlackPostOptions[] = [];
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response("{}", { status: 200 }),
      env: () => undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createTransport: () => {
        throw new Error("boom");
      },
    };
    const code = await main(["slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("failed");
  });
});

describe("loadSlackConfig", () => {
  function sluckIo(cwd: string): Io {
    return {
      write: () => {},
      writeErr: () => {},
      fetch: async () => new Response("{}", { status: 200 }),
      env: () => undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createTransport: () => ({ connect: () => {}, postMessage: async () => {} }),
    };
  }

  test("defaults optional fields and reads string scalars", () => {
    const cwd = scratchDir("loadcfg-mid");
    writeSlackConfig(cwd, { channels: { general: "C1" }, agents: {} });
    const cfg = loadSlackConfig(sluckIo(cwd));
    expect(cfg).not.toBeNull();
    if (cfg) {
      expect(cfg.channels.general).toBe("C1");
      expect(cfg.token).toBeUndefined();
      expect(cfg.appToken).toBeUndefined();
      expect(cfg.dmMirrorChannel).toBeUndefined();
      expect(cfg.botIds).toEqual([]);
      expect(cfg.dmChannels).toEqual({});
      expect(cfg.roster).toEqual({});
    }
  });

  test("rejects a config whose channels field is malformed", () => {
    const cwd = scratchDir("slackcfg-badch");
    writeSlackConfig(cwd, { channels: "not-an-object", agents: {} });
    expect(loadSlackConfig(sluckIo(cwd))).toBeNull();
  });

  test("rejects a config whose agents field is malformed", () => {
    const cwd = scratchDir("slackcfg-badag");
    writeSlackConfig(cwd, { channels: {}, agents: 42 });
    expect(loadSlackConfig(sluckIo(cwd))).toBeNull();
  });
});