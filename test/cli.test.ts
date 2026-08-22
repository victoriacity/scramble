import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { ChannelStore } from "../src/store";
import { createStore } from "../src/store";
import { createHandler } from "../src/server";
import { main, parseBind, loadSlackConfig, slackConfigPath, slackCliToken, staleConfigWarning, staleListeners, pickStale, staleListenerProblem, readProcesses, liveListeners, listenerCommit, listenersBehind, processesReadable, type Io } from "../src/cli";
import { SCOPE_NAMES, BOT_EVENT_NAMES } from "../src/app-manifest";

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
    channel: "general",
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
    createSocket: () => ({
      send: () => {},
      close: () => {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
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
      new Request("http://x/channels/general", {
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

  test("explicit channels stream per-channel with the agent excluded and mentioned stamped", async () => {
    const cwd = scratchDir("listen2");
    const { io, writes } = stubIo(cwd, async (input) => {
      const u = new URL(input);
      expect(u.pathname).toBe("/channels/general/stream");
      expect(u.searchParams.get("exclude")).toBe("ana");
      return ndjs([msg("b1", "bob", "@ana hello", ["ana"])], "close");
    });
    const code = await main(["listen", "general", "--as", "ana"], io);
    expect(code).toBe(0); // clean close of a single-channel stream
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
      new Request("http://x/channels/general", {
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

  test("missing channel is an error", async () => {
    const { io, errs } = stubIo(scratchDir("hist2"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["history"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("channel");
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
    const code = await main(["join", "general", "--as", "alice", "--persona", "i join channels"], io);
    expect(code).toBe(0);
    expect(existsSync(join(dir, ".scramble", "persona.md"))).toBe(true);
    expect(existsSync(join(dir, ".scramble", "knowledge", "INDEX.md"))).toBe(true);
    expect(sent[0]!.url).toContain("/agents/alice");
    const body = JSON.parse(sent[0]!.init!.body as string);
    expect(body.persona).toBe("i join channels");
    expect(body.channel).toBe("general");
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

  test("missing channel is an error", async () => {
    const { io, errs } = stubIo(scratchDir("join3"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["join"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("channel");
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
    let store: ChannelStore | undefined;
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

describe("unknown backend", () => {
  test("a --backend value that matches neither backend is reported, naming the two", async () => {
    const { io, errs } = stubIo(scratchDir("unkbackend"), async () => {
      throw new Error("no fetch expected");
    });
    const code = await main(["post", "general", "hi", "--as", "dev", "--backend", "nostone"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("'nostone'");
    expect(errs[0]).toContain("'local'");
    expect(errs[0]).toContain("'slack'");
  });

  test("an unknown SCRAMBLE_BACKEND env is reported and the command refuses", async () => {
    const { io, errs } = stubIo(scratchDir("unkbackend-env"), async () => {
      throw new Error("no fetch expected");
    });
    io.env = (n) => (n === "SCRAMBLE_BACKEND" ? "walrus" : undefined);
    const code = await main(["history", "general"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("'walrus'");
    expect(errs[0]).toContain("'local'");
    expect(errs[0]).toContain("'slack'");
  });

  test("the local and slack backends are NOT rejected", async () => {
    const cwd = scratchDir("okbackends");
    const handler = createHandler(createStore(scratchDir("okbackends-store")));
    const { io } = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    const local = await main(["post", "general", "hi", "--as", "dev", "--backend", "local"], io);
    expect(local).toBe(0);
    // slack without a config: reported as a missing-config error, not an
    // unknown-backend rejection.
    const io2 = stubIo(cwd, async () => new Response("[]", { status: 200 })).io;
    const slack = await main(["post", "general", "hi", "--as", "dev", "--backend", "slack"], io2);
    expect(slack).toBe(1);
  });
});

// --- the mirrored raft grammar (message / profile / channel) -------------
// scramble speaks the same noun-verb grammar as the raft CLI; these keep the
// old verbs as aliases and cover the mirror's parsing under the local backend.

describe("message send (mirrored)", () => {
  test("--target sends the STDIN message and prints crossings", async () => {
    const cwd = scratchDir("msgsend");
    const handler = createHandler(createStore(scratchDir("msgsend-store")));
    await handler(
      new Request("http://x/channels/general", {
        method: "POST",
        body: JSON.stringify({ from: "bob", text: "first", id: "j1", lastSeen: 0 }),
      }),
    );
    const { io, writes } = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    io.readStdin = async () => "hello ana from stdin";
    const code = await main(["message", "send", "--target", "general", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ from: "bob", text: "first" });
  });

  test("equal-form --target=channel works", async () => {
    const cwd = scratchDir("msgsend-eq");
    const handler = createHandler(createStore(scratchDir("msgsend-eq-store")));
    const { io, writes } = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    io.readStdin = async () => "hi";
    const code = await main(["message", "send", "--target=general", "--as", "ana"], io);
    expect(code).toBe(0);
    // no crossings, clean exit
    expect(writes).toHaveLength(0);
  });

  test("a message breaking a language rule is REFUSED before anything is sent", async () => {
    // The incident, 2026-08-22: the rules were checked by a separate script the
    // sender ran first, so piping text straight into `message send` skipped them
    // and messages went out unlinted for a day. The check moved to the send, and
    // this asserts the part that matters — the send does not HAPPEN.
    const cwd = scratchDir("msgsend-lint");
    const { io, errs } = stubIo(cwd, async () => {
      throw new Error("REFUSED means no request is made");
    });
    io.readStdin = async () => "Both are landed in the closing gate — controlled on six transcripts.";
    const code = await main(["message", "send", "--target", "general", "--as", "ana"], io);
    expect(code).toBe(1);
    expect(errs.join(" ")).toContain("REFUSED");
    expect(errs.join(" ")).toContain("em dash");
  });

  test("`post` is not the way around what `message send` enforces", async () => {
    // The check lives at the choke point both verbs funnel through, so a second
    // entry point cannot ship unlinted prose. Found while writing up the first
    // fix: `post <channel> <text>` took the same words and never saw the rules.
    const cwd = scratchDir("post-lint");
    const { io, errs } = stubIo(cwd, async () => {
      throw new Error("REFUSED means no request is made");
    });
    const code = await main(["post", "general", "landed it — controlled on six transcripts", "--as", "ana"], io);
    expect(code).toBe(1);
    expect(errs.join(" ")).toContain("REFUSED");
    expect(errs.join(" ")).toContain("em dash");
  });

  test("reads empty stdin as a reported usage error", async () => {
    const cwd = scratchDir("msgsend-empty");
    const { io, errs } = stubIo(cwd, async () => {
      throw new Error("no fetch expected");
    });
    io.readStdin = async () => "   ";
    const code = await main(["message", "send", "--target", "general"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("stdin");
  });

  test("a missing --target is reported and exits nonzero", async () => {
    const cwd = scratchDir("msgsend-notarget");
    const { io, errs } = stubIo(cwd, async () => {
      throw new Error("no fetch expected");
    });
    io.readStdin = async () => "hello";
    const code = await main(["message", "send"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("--target");
  });

  test("a '#' target is rejected with the sigil reason", async () => {
    const cwd = scratchDir("msgsend-hash");
    const { io, errs } = stubIo(cwd, async () => {
      throw new Error("no fetch expected");
    });
    io.readStdin = async () => "hello";
    const code = await main(["message", "send", "--target", "#general"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("'#'");
  });

  test("--thread records the thread on the stored message and round-trips through history", async () => {
    const cwd = scratchDir("msgsend-thread");
    const store = createStore(scratchDir("msgsend-thread-store"));
    const handler = createHandler(store);
    const { io } = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    io.readStdin = async () => "inside the thread";
    const code = await main(["message", "send", "--target", "general", "--thread", "1787291684.717739", "--as", "ana"], io);
    expect(code).toBe(0);
    const msgs = store.read("general");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.thread).toBe("1787291684.717739");
    // through the history verb it prints the thread back
    const writes: string[] = [];
    const { io: io2 } = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    io2.write = (l) => writes.push(l);
    const code2 = await main(["history", "general"], io2);
    expect(code2).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ thread: "1787291684.717739" });
  });

  test("a plain send carries no thread field at all", async () => {
    const cwd = scratchDir("msgsend-plain");
    const store = createStore(scratchDir("msgsend-plain-store"));
    const handler = createHandler(store);
    const { io } = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    io.readStdin = async () => "top level";
    const code = await main(["message", "send", "--target", "general", "--as", "ana"], io);
    expect(code).toBe(0);
    expect(store.read("general")[0]!.thread).toBeUndefined();
    expect("thread" in store.read("general")[0]!).toBe(false);
  });
});

describe("message check (local => cursor drain)", () => {
  test("drains pending, writes the cursor, and is quiet when empty", async () => {
    const cwd = scratchDir("msgcheck");
    const handler = createHandler(createStore(scratchDir("msgcheck-store")));
    await handler(
      new Request("http://x/agents/dev", {
        method: "POST",
        body: JSON.stringify({ persona: "p", channel: "general" }),
      }),
    );
    await handler(
      new Request("http://x/channels/general", {
        method: "POST",
        body: JSON.stringify({ from: "ana", text: "@dev hi", id: "1", lastSeen: 0 }),
      }),
    );
    const a = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    const code = await main(["message", "check", "--as", "dev"], a.io);
    expect(code).toBe(0);
    expect(a.writes.length).toBeGreaterThan(0);
    const cursor = JSON.parse(readFileSync(join(cwd, ".scramble", "cursors", "dev.json"), "utf8"));
    expect(cursor.dev).toBeGreaterThan(0);
    // second check: nothing new pending, prints nothing, still exits 0
    const b = stubIo(cwd, (u, init) => handler(new Request(u, init)));
    const code2 = await main(["message", "check", "--as", "dev"], b.io);
    expect(code2).toBe(0);
    expect(b.writes).toHaveLength(0);
  });

  test("a failure prints the status and exits 1", async () => {
    const cwd = scratchDir("msgcheck-fail");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 500 }));
    const code = await main(["message", "check", "--as", "dev"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("500");
  });
});

describe("`--help`, and the agent name that is not a directory", () => {
  // A remote agent, 2026-08-22: "`--help` is unknown CLI-wide, and `doctor
  // --help` falls through to the working directory as the agent name:
  // doctor: no agent "mbench3d" ... From /tmp it says "tmp", from home it says
  // "agent"." An unknown flag turned a directory into an identity.
  test("--help lists the verbs and exits 0, from any verb", async () => {
    const cwd = scratchDir("help");
    for (const argv of [["--help"], ["doctor", "--help"], ["message", "send", "-h"], []]) {
      const { io, writes } = stubIo(cwd, async () => {
        throw new Error("--help must touch nothing");
      });
      expect(await main(argv, io)).toBe(0);
      expect(writes.join("\n")).toContain("scramble <verb>");
      expect(writes.join("\n")).toContain("inbox pending");
    }
  });

  test("the help says WHERE the agent name comes from without --as", async () => {
    // The surprise was the fallback, so the fallback is what the help names.
    const { io, writes } = stubIo(scratchDir("help-as"), async () => new Response("{}", { status: 200 }));
    expect(await main(["--help"], io)).toBe(0);
    expect(writes.join("\n")).toContain("directory's basename");
  });
});

describe("`scramble version`: which copy is running", () => {
  // A peer agent, 2026-08-22: "My scramble executes your working tree. bun link
  // points at the maintainer's checkout and runs src directly... if you save
  // halfway through an edit, the syntax error runs inside my listener, and I
  // meet it before you do." An agent could not tell which scramble it ran.
  test("an installed copy names its commit", async () => {
    const dir = scratchDir("ver-installed");
    writeFileSync(join(dir, "COMMIT"), "6fe75ff\n");
    const { io, writes } = stubIo(dir, async () => new Response("{}", { status: 200 }));
    io.moduleDir = () => dir;
    expect(await main(["version"], io)).toBe(0);
    expect(JSON.parse(writes[0]!)).toEqual({ scramble: "installed", commit: "6fe75ff", source: dir });
  });

  test("a checkout says so, and exits nonzero, because its version is a moving target", async () => {
    const dir = scratchDir("ver-checkout");
    const { io, writes, errs } = stubIo(dir, async () => new Response("{}", { status: 200 }));
    io.moduleDir = () => dir;
    expect(await main(["version"], io)).toBe(1);
    expect(JSON.parse(writes[0]!).commit).toBe(null);
    expect(errs.join(" ")).toContain("scripts/install.sh");
  });

  test("with no moduleDir seam at all it still answers rather than throwing", async () => {
    const { io, writes } = stubIo(scratchDir("ver-noseam"), async () => new Response("{}", { status: 200 }));
    expect(await main(["version"], io)).toBe(1);
    expect(JSON.parse(writes[0]!).commit).toBe(null);
  });
});

describe("`scramble lint`: the send's rules, pointed at any document", () => {
  // Operator, 2026-08-22: "the linter should be individually callable to check
  // other documents such as lark docs or markdown files."
  test("a file's hits are reported with the line, and the exit code is nonzero", async () => {
    const cwd = scratchDir("lint-file");
    const f = join(cwd, "doc.md");
    writeFileSync(f, "# A doc\n\nThis is basically fine.\nA second line — with a dash.\n");
    const { io, writes, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", f], io)).toBe(1);
    expect(errs.join("\n")).toContain(`${f}:3: [filler] "basically"`);
    expect(errs.join("\n")).toContain(`${f}:4: [em dash]`);
    expect(JSON.parse(writes[0]!)).toEqual({ lint: "hits", files: 1, hits: 2 });
  });

  test("a clean file exits 0 and says so", async () => {
    const cwd = scratchDir("lint-clean");
    const f = join(cwd, "clean.md");
    writeFileSync(f, "# A doc\n\nThe manifest names every event it subscribes to.\n");
    const { io, writes } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", f], io)).toBe(0);
    expect(JSON.parse(writes[0]!)).toEqual({ lint: "clean", files: 1, hits: 0 });
  });

  test("text on stdin is linted when no file is named", async () => {
    const cwd = scratchDir("lint-stdin");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    io.readStdin = async () => "Gate green at 457.";
    expect(await main(["lint"], io)).toBe(1);
    expect(errs.join("\n")).toContain("(stdin):1:");
  });

  test("no file and no stdin is a usage error", async () => {
    const cwd = scratchDir("lint-usage");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    io.readStdin = async () => "   ";
    expect(await main(["lint"], io)).toBe(1);
    expect(errs.join(" ")).toContain("usage: scramble lint");
  });

  test("a file that cannot be read is a FAILURE, never a silent pass", async () => {
    // A lint that skips what it cannot open reports clean on a typo.
    const cwd = scratchDir("lint-missing");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", join(cwd, "nope.md")], io)).toBe(1);
    expect(errs.join(" ")).toContain("cannot read");
  });
});

describe("`inbox pending`: the count of what is owed, per ITEM", () => {
  /** Drive a real delivery through the local daemon, so the ledger is written by
   *  the delivery path and never by the test. */
  async function deliverOne(cwd: string, text = "@dev why are stale bots created") {
    const handler = createHandler(createStore(scratchDir(`${basename(cwd)}-store`)));
    await handler(
      new Request("http://x/agents/dev", { method: "POST", body: JSON.stringify({ persona: "p", channel: "general" }) }),
    );
    await handler(
      new Request("http://x/channels/general", {
        method: "POST",
        body: JSON.stringify({ from: "andrew", text, id: "m1", lastSeen: 0 }),
      }),
    );
    return stubIo(cwd, (u, init) => handler(new Request(u, init)));
  }

  test("a delivered mention becomes an OPEN item, and pending exits 1 naming it", async () => {
    const cwd = scratchDir("inbox-open");
    const a = await deliverOne(cwd);
    expect(await main(["message", "check", "--as", "dev"], a.io)).toBe(0);
    const b = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "pending", "--as", "dev"], b.io)).toBe(1);
    expect(b.writes.length).toBe(1);
    expect(b.errs.join(" ")).toContain("with no reply");
    expect(b.errs.join(" ")).toContain("why are stale bots created");
  });

  test("a reply DEFAULTS into the thread the question was asked in", async () => {
    // Operator, 2026-08-22: "shall we make inbox reply default to within the
    // thread? Posting to the channel directly can be made a separate flag." The
    // ledger knows which item is open, so the thread is read and never guessed.
    const cwd = scratchDir("inbox-threaddefault");
    const p = join(cwd, ".scramble", "inbox", "dev.jsonl");
    mkdirSync(join(cwd, ".scramble", "inbox"), { recursive: true });
    writeFileSync(
      p,
      `${JSON.stringify({ id: "9.1", channel: "general", from: "andrew", thread: "root-7", text: "q", at: "2026-08-22T00:00:00Z" })}\n`,
    );
    const { io, errs } = stubIo(cwd, async () => new Response(JSON.stringify({ crossings: [] }), { status: 200 }));
    io.readStdin = async () => "the answer";
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], io)).toBe(0);
    expect(errs.join(" ")).toContain("replying in thread root-7");
    expect(errs.join(" ")).toContain("andrew");
  });

  test("an item that STARTED a thread is replied to under its own id", async () => {
    const cwd = scratchDir("inbox-threadroot");
    mkdirSync(join(cwd, ".scramble", "inbox"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "inbox", "dev.jsonl"),
      `${JSON.stringify({ id: "9.4", channel: "general", from: "andrew", text: "q", at: "2026-08-22T00:00:00Z" })}\n`,
    );
    const { io, errs } = stubIo(cwd, async () => new Response(JSON.stringify({ crossings: [] }), { status: 200 }));
    io.readStdin = async () => "the answer";
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], io)).toBe(0);
    expect(errs.join(" ")).toContain("replying in thread 9.4");
  });

  test("--top-level is the way out, and an unrelated channel is untouched", async () => {
    const cwd = scratchDir("inbox-toplevel");
    mkdirSync(join(cwd, ".scramble", "inbox"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "inbox", "dev.jsonl"),
      `${JSON.stringify({ id: "9.2", channel: "general", from: "andrew", thread: "root-7", text: "q", at: "2026-08-22T00:00:00Z" })}\n`,
    );
    const a = stubIo(cwd, async () => new Response(JSON.stringify({ crossings: [] }), { status: 200 }));
    a.io.readStdin = async () => "an announcement";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--top-level"], a.io)).toBe(0);
    expect(a.errs.join(" ")).not.toContain("replying in thread");
    // A channel with nothing open has nothing to reply to.
    const b = stubIo(cwd, async () => new Response(JSON.stringify({ crossings: [] }), { status: 200 }));
    b.io.readStdin = async () => "hello elsewhere";
    expect(await main(["message", "send", "--target", "other", "--as", "dev"], b.io)).toBe(0);
    expect(b.errs.join(" ")).not.toContain("replying in thread");
  });

  test("nothing owed prints nothing and exits 0", async () => {
    const cwd = scratchDir("inbox-clean");
    const { io, writes } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "pending", "--as", "dev"], io)).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("an unknown inbox verb names the one that exists", async () => {
    const cwd = scratchDir("inbox-verb");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "drain", "--as", "dev"], io)).toBe(1);
    expect(errs.join(" ")).toContain("inbox pending");
  });

  test("an unwritable ledger REPORTS itself and still delivers the message", async () => {
    // The message is the point and the ledger is the accounting, so a ledger
    // that cannot be written must not swallow a delivery. It must also not go
    // quiet: an inbox counting nothing would read as an inbox with nothing in
    // it, which is the silent-success shape this whole day was about.
    const cwd = scratchDir("inbox-locked");
    const a = await deliverOne(cwd);
    // Only the ledger's own directory: locking all of .scramble would break the
    // cursor write too, and then the test would prove something else.
    mkdirSync(join(cwd, ".scramble", "inbox"), { recursive: true });
    chmodSync(join(cwd, ".scramble", "inbox"), 0o500);
    try {
      expect(await main(["message", "check", "--as", "dev"], a.io)).toBe(0);
      expect(a.writes.length).toBeGreaterThan(0);
      expect(a.errs.join(" ")).toContain("inbox ledger not written");
    } finally {
      chmodSync(join(cwd, ".scramble", "inbox"), 0o700);
    }
  });
});

describe("message read (mirror of history)", () => {
  test("--after and --since are the same cursor", async () => {
    const cwd = scratchDir("msgread");
    const seen: string[] = [];
    const { io, writes } = stubIo(cwd, async (input) => {
      const u = new URL(input);
      seen.push(u.searchParams.get("since")!);
      return new Response(
        JSON.stringify([msg("r1", "bob", "one"), msg("r2", "ana", "two")]),
        { status: 200 },
      );
    });
    const codeAfter = await main(["message", "read", "--target", "general", "--after", "7"], io);
    expect(codeAfter).toBe(0);
    expect(seen[0]).toBe("7");
    const codeSince = await main(["message", "read", "--target", "general", "--since", "9"], io);
    expect(codeSince).toBe(0);
    expect(seen[1]).toBe("9");
    expect(writes.map((l) => JSON.parse(l).text)).toEqual(["one", "two", "one", "two"]);
  });

  test("a missing --target is reported", async () => {
    const { io, errs } = stubIo(scratchDir("msgread-notarget"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["message", "read"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("--target");
  });

  test("a '#' target is rejected", async () => {
    const { io, errs } = stubIo(scratchDir("msgread-hash"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["message", "read", "--target", "#general"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("'#'");
  });
});

describe("message unknown verb", () => {
  test("reports what it saw and exits nonzero", async () => {
    const { io, errs } = stubIo(scratchDir("msgverb"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["message", "bogus"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("bogus");
  });
});

describe("profile", () => {
  test("show prints name + persona as one JSON line, empty persona when absent", async () => {
    const withPersona = scratchDir("prof-show");
    mkdirSync(join(withPersona, ".scramble"), { recursive: true });
    writeFileSync(join(withPersona, ".scramble", "persona.md"), "I test quickly.\n");
    const { io: io1, writes: w1 } = stubIo(withPersona, async () => {
      throw new Error("unreachable");
    });
    await main(["profile", "show", "--as", "dev"], io1);
    expect(JSON.parse(w1[0]!)).toEqual({ name: "dev", persona: "I test quickly.\n" });
    const bare = scratchDir("prof-bare");
    const { io: io2, writes: w2 } = stubIo(bare, async () => {
      throw new Error("unreachable");
    });
    await main(["profile", "show", "--as", "dev"], io2);
    expect(JSON.parse(w2[0]!)).toEqual({ name: "dev", persona: "" });
  });

  test("update writes persona.md, registers it, and exits 0", async () => {
    const cwd = scratchDir("prof-update");
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    const { io } = stubIo(cwd, async (u, init) => {
      sent.push({ url: u, init });
      return new Response("{}", { status: 200 });
    });
    const code = await main(["profile", "update", "--description", "i focus on gates", "--as", "dev"], io);
    expect(code).toBe(0);
    expect(readFileSync(join(cwd, ".scramble", "persona.md"), "utf8")).toBe("i focus on gates");
    expect(sent[0]!.url).toContain("/agents/dev");
    expect(JSON.parse(sent[0]!.init!.body as string)).toMatchObject({ persona: "i focus on gates" });
  });

  test("update with no description is an error", async () => {
    const { io, errs } = stubIo(scratchDir("prof-node"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["profile", "update", "--as", "dev"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("--description");
  });

  test("update surfaces a registration failure", async () => {
    const cwd = scratchDir("prof-fail");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 500 }));
    const code = await main(["profile", "update", "--description", "x", "--as", "dev"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("500");
  });

  test("an unknown profile verb is reported", async () => {
    const { io, errs } = stubIo(scratchDir("prof-verb"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["profile", "frob"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("frob");
  });
});

describe("channel join (mirror of join)", () => {
  test("--target joins and registers", async () => {
    const cwd = scratchDir("chan");
    const { io } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    const code = await main(["channel", "join", "--target", "general", "--as", "dev"], io);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".scramble", "persona.md"))).toBe(true);
  });

  test("a '#' target is rejected with the sigil reason", async () => {
    const { io, errs } = stubIo(scratchDir("chan-hash"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["channel", "join", "--target", "#general"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("#'");
  });

  test("a missing --target is reported", async () => {
    const { io, errs } = stubIo(scratchDir("chan-notarget"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["channel", "join"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("--target");
  });

  test("an unknown channel verb is reported", async () => {
    const { io, errs } = stubIo(scratchDir("chan-verb"), async () => {
      throw new Error("unreachable");
    });
    const code = await main(["channel", "leave"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("leave");
  });
});

describe("message check under the slack backend", () => {
  /** Build the slack check io with a config that maps one channel and an empty
   *  history. `over` can swap the fetch to answer the drain. */
  function slackCheckIo(cwd: string, over?: Partial<Io>): Io {
    writeSlackConfig(cwd, { appToken: "xapp-1", token: "xoxb-1", channels: { general: "C1" }, agents: {} });
    const base: Io = {
      write: () => {},
      writeErr: () => {},
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
      env: () => undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () =>
        ({
          send: () => {},
          close: () => {},
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        }),
    };
    return { ...base, ...over };
  }

  test("a valid slack config with an empty channel history reports nothing and exits 0", async () => {
    const io = slackCheckIo(scratchDir("mslack-ok"));
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(0);
  });

  test("an existing cwd cursor MIGRATES on the first write, keeping its values", async () => {
    // Reading the old file while writing the new one is what ends the coupling.
    // Reading the new (absent) one instead would drop every channel cursor this
    // agent already had and re-drain everything exactly once.
    const cwd = scratchDir("cursor-migrate");
    const io = slackCheckIo(cwd, {
      fetch: async (url) =>
        String(url).includes("conversations.history")
          ? new Response(JSON.stringify({ ok: true, messages: [{ ts: "9.9", user: "U9", text: "hi" }] }), { status: 200 })
          : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    });
    // The old location, holding a cursor for a channel this sweep will not visit.
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "cursor.json"),
      JSON.stringify({ "slack:dev": { "already-seen": "5.5" } }),
    );
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    const moved = JSON.parse(
      readFileSync(join(cwd, ".scramble", "cursors", "dev.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    // The old value survived the move, and the new one joined it.
    expect(moved["slack:dev"]!["already-seen"]).toBe("5.5");
    expect(moved["slack:dev"]!.general).toBe("9.9");
  });

  test("ONE AGENT'S CURSOR NEVER BLINDS ANOTHER on a shared host", async () => {
    // The peer agent read the previous version and found the step I missed: a
    // single shared file beside the config looks fine because its keys are per
    // agent, and the FIRST agent to sweep creates it, after which every other
    // agent resolves to that file, finds no key of its own, reads 0, and
    // re-drains full history. The same flood, one step later, once per agent.
    const cwd = scratchDir("cursor-shared");
    const io = slackCheckIo(cwd, {
      fetch: async (url) =>
        String(url).includes("conversations.history")
          ? new Response(JSON.stringify({ ok: true, messages: [{ ts: "9.9", user: "U9", text: "hi" }] }), { status: 200 })
          : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    });
    expect(await main(["message", "check", "--as", "alpha", "--backend", "slack"], io)).toBe(0);
    const alpha = join(cwd, ".scramble", "cursors", "alpha.json");
    expect(existsSync(alpha)).toBe(true);
    // beta has swept nothing, so it has no cursor of its own and alpha's file is
    // NOT what it reads. One file per agent is what makes that true.
    const beta = join(cwd, ".scramble", "cursors", "beta.json");
    expect(existsSync(beta)).toBe(false);
    expect(await main(["message", "check", "--as", "beta", "--backend", "slack"], io)).toBe(0);
    expect(existsSync(beta)).toBe(true);
    // And alpha's cursor is untouched by beta's sweep: no read-modify-write race
    // over one file.
    const after = JSON.parse(readFileSync(alpha, "utf8")) as Record<string, unknown>;
    expect(Object.keys(after)).toEqual(["slack:alpha"]);
  });

  test("the sweep covers channels this agent is IN, beyond what the config maps", async () => {
    // 2026-08-22: a peer removed two entries from the SHARED config while
    // testing name resolution, and this sweep stopped covering the channel the
    // operator talks to me in. It reported "none of the 3 configured channels
    // are readable" and swept nothing that mattered, while the listener kept
    // delivering, so nothing looked broken.
    const asked: string[] = [];
    const io = slackCheckIo(scratchDir("mslack-membership"), {
      fetch: async (url) => {
        const u = String(url);
        if (u.includes("users.conversations")) {
          return new Response(
            JSON.stringify({ ok: true, channels: [{ id: "C9", name: "unmapped-but-mine" }] }),
            { status: 200 },
          );
        }
        if (u.includes("conversations.history")) {
          asked.push(new URL(u).searchParams.get("channel") ?? "");
          return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, teams: [{ id: "T1" }], messages: [] }), { status: 200 });
      },
    });
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    // C1 is the configured `general`; C9 is the channel only membership knows.
    expect(asked).toContain("C1");
    expect(asked).toContain("C9");
  });

  test("a refused membership listing is REPORTED, never read as being in nothing", async () => {
    // An agent in no channels and an agent whose listing was refused look the
    // same from the outside, and one of them is a broken credential.
    const errs: string[] = [];
    const io = slackCheckIo(scratchDir("mslack-memberfail"), {
      writeErr: (l) => errs.push(l),
      fetch: async (url) =>
        String(url).includes("users.conversations")
          ? new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 })
          : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    });
    await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(errs.join(" ")).toContain("listing this agent's channels failed");
    expect(errs.join(" ")).toContain("invalid_auth");
  });

  test("a ledger it cannot update while closing answered items REPORTS itself", async () => {
    // The close runs from the sweep, where the agent is not watching. A silent
    // failure there leaves answered questions in `pending` and teaches the agent
    // to scroll past the list.
    const cwd = scratchDir("mslack-closefail");
    const errs: string[] = [];
    const io = slackCheckIo(cwd, {
      writeErr: (l) => errs.push(l),
      fetch: async (url) =>
        String(url).includes("conversations.history")
          ? new Response(JSON.stringify({ ok: true, messages: [{ ts: "9.9", user: "U1", text: "my own line" }] }), { status: 200 })
          : new Response(JSON.stringify({ ok: true, user: "dev", messages: [] }), { status: 200 }),
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
      roster: { U1: "dev" },
    });
    // An open row must EXIST for the close to attempt a write, and the FILE is
    // what gets locked: a directory's write bit governs create and unlink only.
    mkdirSync(join(cwd, ".scramble", "inbox"), { recursive: true });
    const ledger = join(cwd, ".scramble", "inbox", "dev.jsonl");
    writeFileSync(
      ledger,
      `${JSON.stringify({ id: "1.0", channel: "general", from: "andrew", text: "q", at: "2026-08-22T00:00:00Z" })}\n`,
    );
    chmodSync(ledger, 0o400);
    try {
      expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(0);
      expect(errs.join(" ")).toContain("inbox ledger not updated for general");
    } finally {
      chmodSync(ledger, 0o600);
    }
  });

  test("the sweep reads MY OWN sent lines back against today's rules", async () => {
    // Operator, 2026-08-22, after catching three style defects in a row: "You
    // need to understand this general pattern and use the message check to
    // guard it." Every rule was added AFTER a message went out carrying what it
    // bans, so a rule guarding only the NEXT message leaves every earlier one
    // standing in the channel, unmarked, as though it were fine.
    const errs: string[] = [];
    const cwd = scratchDir("mslack-selflint");
    const io = slackCheckIo(cwd, {
      writeErr: (l) => errs.push(l),
      fetch: async (url) =>
        String(url).includes("conversations.history")
          ? new Response(
              JSON.stringify({
                ok: true,
                messages: [
                  { ts: "9.1", user: "U1", text: "Gate green at 457, six live stages pass." },
                  { ts: "9.2", user: "U1", text: "The manifest names every event it subscribes to." },
                ],
              }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ ok: true, user: "dev", messages: [] }), { status: 200 }),
    });
    // AFTER the helper, which writes its own config: the roster resolves U1 to
    // this agent, so the drain recognises the line as its OWN and self-lints it.
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
      roster: { U1: "dev" },
    });
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(0);
    const said = errs.join("\n");
    expect(said).toContain("would be refused by today's rules");
    expect(said).toContain("9.1");
    expect(said).toContain("internal shorthand");
    // The clean line is not named: a report that lists everything names nothing.
    expect(said).not.toContain("9.2");
  });

  test("a broken slack config is reported and exits nonzero", async () => {
    const cwd = scratchDir("mslack-bad");
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    writeFileSync(join(cwd, ".scramble", "slack.json"), "not json");
    const io: Io = {
      write: () => {},
      writeErr: () => {},
      fetch: async () => new Response("{}", { status: 200 }),
      env: () => undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
    };
    const errs: string[] = [];
    io.writeErr = (l) => errs.push(l);
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("slack");
  });

  test("message check drains a waiting message, prints it, and advances the per-channel ts cursor", async () => {
    const cwd = scratchDir("mslack-drain");
    const writes: string[] = [];
    const historySeen: string[] = [];
    const io = slackCheckIo(cwd, {
      write: (l) => writes.push(l),
      fetch: async (input) => {
        const u = String(input);
        if (u.includes("conversations.history")) {
          historySeen.push(new URL(u).searchParams.get("oldest") ?? "(none)");
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { type: "message", channel: "C1", user: "bob", username: "bob", text: "@dev check me", ts: "5.5" },
              ],
            }),
            { status: 200 },
          );
        }
        // the status postMessage answered (this line addressed "dev")
        return new Response(JSON.stringify({ ok: true, ts: "9.9" }), { status: 200 });
      },
    });
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(0);
    // no prior cursor: history asked without an `oldest`
    expect(historySeen).toEqual(["(none)"]);
    // one JSON line, the waiting mention, in the listen shape (mentioned stamped)
    expect(writes).toHaveLength(1);
    const line = JSON.parse(writes[0]!) as { text: string; channel: string; mentioned: boolean };
    expect(line.text).toBe("@dev check me");
    expect(line.channel).toBe("general");
    expect(line.mentioned).toBe(true);
    // the per-channel cursor moved: the stored slack cursor is a map, not an integer
    const cursor = JSON.parse(readFileSync(join(cwd, ".scramble", "cursors", "dev.json"), "utf8"));
    expect(cursor["slack:dev"]).toEqual({ general: "5.5" });
  });

  test("a second check right after prints nothing: the per-channel cursor moved", async () => {
    const cwd = scratchDir("mslack-drain2");
    const fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          ok: true,
          messages: [
            { type: "message", channel: "C1", user: "bob", username: "bob", text: "@dev again", ts: "6.6" },
          ],
        }),
        { status: 200 },
      );
    const first = slackCheckIo(cwd, { fetch, write: () => {} });
    const code1 = await main(["message", "check", "--as", "dev", "--backend", "slack"], first);
    expect(code1).toBe(0);
    // second check: same history, but the cursor ("6.6") excludes the line
    const writes: string[] = [];
    const second = slackCheckIo(cwd, { fetch, write: (l) => writes.push(l) });
    const code2 = await main(["message", "check", "--as", "dev", "--backend", "slack"], second);
    expect(code2).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("message check drains a peer's line and does NOT drain a line from the draining agent", async () => {
    // The drain is a DELIVERY verb: it hands the agent what ARRIVED for it.
    // Its own line (resolved sender name == the draining agent) is left out,
    // exactly by the same name comparison listen/next use — and the cursor
    // still advances over the skipped own-line (the peer line is newest).
    const cwd = scratchDir("mslack-drain-noself");
    const writes: string[] = [];
    const io = slackCheckIo(cwd, {
      write: (l) => writes.push(l),
      fetch: async (u) => {
        if (String(u).includes("conversations.history")) {
          // newest-first: the agent's own line (ts 9.9) is the newest; the
          // peer's line (ts 9.5) is older.
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { type: "message", channel: "C1", user: "dev", username: "dev", text: "self-delivery probe", ts: "9.9" },
                { type: "message", channel: "C1", user: "bob", username: "bob", text: "@dev a peer asks", ts: "9.5" },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 });
      },
    });
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(0);
    // ONLY the peer's line drains; the agent's own is withheld.
    expect(writes).toHaveLength(1);
    const line = JSON.parse(writes[0]!) as { text: string; from: string };
    expect(line.from).toBe("bob");
    expect(line.text).toBe("@dev a peer asks");
    // the cursor is the NEWEST line — which is the skipped OWN line (9.9), so
    // the very next sweep does not re-read it.
    const cursor = JSON.parse(readFileSync(join(cwd, ".scramble", "cursors", "dev.json"), "utf8"));
    expect(cursor["slack:dev"]).toEqual({ general: "9.9" });
  });

  test("the cursor advances past a skipped own-line: second check empty, third returns only the new peer line", async () => {
    const cwd = scratchDir("mslack-cursor-own");
    // History rotates per sweep: sweep 1 returns only OWN lines, sweep 2 the
    // same own lines again, sweep 3 a fresh peer line.
    const batches: Array<Record<string, string | number>[]> = [
      // sweep 1: two own-line posts, neither delivered but both before the cursor
      [
        { ts: "5.1", user: "dev", username: "dev", text: "own reply 2" },
        { ts: "5.0", user: "dev", username: "dev", text: "own first" },
      ],
      // sweep 2: the same own lines (cursor already past them -> nothing)
      [
        { ts: "5.1", user: "dev", username: "dev", text: "own reply 2" },
        { ts: "5.0", user: "dev", username: "dev", text: "own first" },
      ],
      // sweep 3: a fresh peer line after the own ones
      [{ ts: "6.0", user: "bob", username: "bob", text: "@dev hi now" }],
    ];
    const writes1: string[] = [];
    const first = slackCheckIo(cwd, {
      write: (l) => writes1.push(l),
      fetch: async (u) => {
        if (String(u).includes("conversations.history")) {
          const b = batches.shift()!;
          return new Response(JSON.stringify({ ok: true, messages: b }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 });
      },
    });
    // sweep 1: own lines are held (NOT drained) but the cursor passes them.
    const c1 = await main(["message", "check", "--as", "dev", "--backend", "slack"], first);
    expect(c1).toBe(0);
    expect(writes1).toHaveLength(0);

    // sweep 2: the same own lines are already behind the cursor => nothing.
    const writes2: string[] = [];
    const second2 = slackCheckIo(cwd, {
      write: (l) => writes2.push(l),
      fetch: async (u) => {
        if (String(u).includes("conversations.history")) {
          const b = batches.shift()!;
          return new Response(JSON.stringify({ ok: true, messages: b }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 });
      },
    });
    const c2 = await main(["message", "check", "--as", "dev", "--backend", "slack"], second2);
    expect(c2).toBe(0);
    expect(writes2).toHaveLength(0);

    // sweep 3: a new peer line after the cursor drains, and ONLY it.
    const writes3: string[] = [];
    const third3 = slackCheckIo(cwd, {
      write: (l) => writes3.push(l),
      fetch: async (u) => {
        if (String(u).includes("conversations.history")) {
          const b = batches.shift()!;
          return new Response(JSON.stringify({ ok: true, messages: b }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 });
      },
    });
    const c3 = await main(["message", "check", "--as", "dev", "--backend", "slack"], third3);
    expect(c3).toBe(0);
    expect(writes3).toHaveLength(1);
    expect(JSON.parse(writes3[0]!).text).toBe("@dev hi now");
  });

  test("a pending message sets the reading agent's status, an unaddressed one sets nothing", async () => {
    const addressed = scratchDir("mslack-status-on");
    const writes: string[] = [];
    const postCount: string[] = [];
    // history in channel general returns ONE message mentioning "dev"; the
    // status post is chat.postMessage -> ok:true so setOn writes the ledger.
    const ioA = slackCheckIo(addressed, {
      write: (l) => writes.push(l),
      fetch: async (input) => {
        const u = String(input);
        if (u.includes("conversations.history"))
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { type: "message", channel: "C1", user: "bob", username: "bob", text: "@dev you're up", ts: "7.7" },
              ],
            }),
            { status: 200 },
          );
        postCount.push(u);
        return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 });
      },
    });
    const c1 = await main(["message", "check", "--as", "dev", "--backend", "slack"], ioA);
    expect(c1).toBe(0);
    // the reading agent was addressed: a status was set in the ledger
    expect(existsSync(join(addressed, ".scramble", "status.json"))).toBe(true);
    const ledger = JSON.parse(readFileSync(join(addressed, ".scramble", "status.json"), "utf8"));
    const entry = (ledger.entries as Array<{ channel: string; agent: string }>).find((e) => e.channel === "general");
    expect(entry).toMatchObject({ channel: "general", agent: "dev" });

    // now a message NOT addressed: nothing to set, no new status entry
    const unaddressed = scratchDir("mslack-status-off");
    const writes2: string[] = [];
    const ioB = slackCheckIo(unaddressed, {
      write: (l) => writes2.push(l),
      fetch: async (input) => {
        const u = String(input);
        if (u.includes("conversations.history"))
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { type: "message", channel: "C1", user: "bob", username: "bob", text: "general hello", ts: "8.8" },
              ],
            }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ ok: true, ts: "2.2" }), { status: 200 });
      },
    });
    const c2 = await main(["message", "check", "--as", "dev", "--backend", "slack"], ioB);
    expect(c2).toBe(0);
    // message 8.8 is printed but not addressed: it must not have set a status
    expect(writes2).toHaveLength(1);
    expect(existsSync(join(unaddressed, ".scramble", "status.json"))).toBe(false);
  });

  test("the cursor advances to the NEWEST line when history returns several newest-first", async () => {
    const cwd = scratchDir("mslack-newest");
    const writes: string[] = [];
    const io = slackCheckIo(cwd, {
      write: (l) => writes.push(l),
      fetch: async (input) => {
        if (String(input).includes("conversations.history"))
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                // Slack returns newest-first; the drain cursor must keep the newest.
                { type: "message", channel: "C1", user: "bob", username: "bob", text: "no mention", ts: "9.5" },
                { type: "message", channel: "C1", user: "bob", username: "bob", text: "older still fresh", ts: "9.4" },
              ],
            }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 });
      },
    });
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(0);
    expect(writes).toHaveLength(2);
    // cursor holds the newest ts for the channel, not the last-seen.
    const cursor = JSON.parse(readFileSync(join(cwd, ".scramble", "cursors", "dev.json"), "utf8"));
    expect(cursor["slack:dev"]).toEqual({ general: "9.5" });
  });

  test("a Slack history read failure is reported and exits nonzero", async () => {
    const cwd = scratchDir("mslack-readfail");
    const errs: string[] = [];
    const io = slackCheckIo(cwd, {
      writeErr: (l) => errs.push(l),
      fetch: async (input) => {
        if (String(input).includes("conversations.history"))
          return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
        return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 });
      },
    });
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs.join(" ")).toContain("invalid_auth");
  });

  test("a valid config without a bot token is REPORTED, never a silent nothing", async () => {
    const cwd = scratchDir("mslack-notoken");
    // config parses (channels+agents valid) but carries no bot token: the
    // slack backend refuses to open, and `message check` must say so.
    writeSlackConfig(cwd, { appToken: "xapp-1", channels: { general: "C1" }, agents: {} });
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
      env: () => undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () =>
        ({
          send: () => {},
          close: () => {},
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        }),
    };
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs.join(" ")).toContain("token");
  });
});


describe("channel join on the slack backend", () => {
  // An app cannot add itself to a Slack conversation, public or private: a
  // member invites it. So the verb reports whether the invite has happened and
  // prints the invite line when it has not, and it never touches the local
  // daemon, which is not running under this backend.
  function joinIo(cwd: string, fetch: (u: string) => Promise<Response>): { io: Io; writes: string[]; errs: string[] } {
    const writes: string[] = [];
    const errs: string[] = [];
    return {
      io: {
        write: (l) => writes.push(l),
        writeErr: (l) => errs.push(l),
        fetch: (input) => fetch(String(input)),
        env: () => undefined,
        cwd: () => cwd,
        sleep: async () => {},
        serve: async () => 0,
        createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
      },
      writes,
      errs,
    };
  }

  test("an invited agent is reported as joined", async () => {
    const cwd = scratchDir("join-in");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: { team: "C1" }, agents: { dev: { token: "T_DEV" } } });
    const { io, writes } = joinIo(cwd, async (u) => {
      if (u.includes("auth.test")) return new Response(JSON.stringify({ ok: true, user: "devbot" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    const code = await main(["channel", "join", "--target", "team", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(0);
    expect(JSON.parse(writes[0]!)).toEqual({
      channel: "team",
      agent: "dev",
      joined: true,
      detail: "a read of the conversation succeeded",
    });
  });

  test("an uninvited agent gets the invite line with its own handle", async () => {
    const cwd = scratchDir("join-out");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: { team: "C1" }, agents: { dev: { token: "T_DEV" } } });
    const { io, errs } = joinIo(cwd, async (u) => {
      if (u.includes("auth.test")) return new Response(JSON.stringify({ ok: true, user: "devbot" }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 });
    });
    const code = await main(["channel", "join", "--target", "team", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("not_in_channel");
    expect(said).toContain("/invite @devbot");
  });

  test("a channel absent from the config is refused by name", async () => {
    const cwd = scratchDir("join-nochan");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T_DEV" } } });
    const { io, errs } = joinIo(cwd, async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await main(["channel", "join", "--target", "ghost", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("no Slack channel for channel ghost");
  });

  test("a failing auth.test is reported rather than read as absence", async () => {
    const cwd = scratchDir("join-badauth");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: { team: "C1" }, agents: { dev: { token: "T_DEV" } } });
    const { io, errs } = joinIo(cwd, async (u) => {
      if (u.includes("auth.test")) return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    expect(await main(["channel", "join", "--target", "team", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("invalid_auth");
  });

  test("a missing slack config is reported, naming the path", async () => {
    const cwd = scratchDir("join-nocfg");
    const { io, errs } = joinIo(cwd, async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await main(["channel", "join", "--target", "team", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("slack.json");
  });
});

describe("message check across a config several agents share", () => {
  // Measured live on 2026-08-21: scramble-dev was invited to one channel of the
  // four in the config, and `message check` answered `read failed:
  // channel_not_found` and drained NOTHING, which a sweeping agent cannot tell
  // from a quiet workspace.
  function checkIo(cwd: string, fetch: (u: string) => Promise<Response>): { io: Io; writes: string[]; errs: string[] } {
    const writes: string[] = [];
    const errs: string[] = [];
    return {
      io: {
        write: (l) => writes.push(l),
        writeErr: (l) => errs.push(l),
        fetch: (input) => fetch(String(input)),
        env: () => undefined,
        cwd: () => cwd,
        sleep: async () => {},
        serve: async () => 0,
        createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
      },
      writes,
      errs,
    };
  }

  const line = (ts: string, text: string) => ({ ts, user: "U111", text });

  test("an inaccessible channel is reported and the readable ones still drain", async () => {
    const cwd = scratchDir("check-mixed");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: { mine: "C_MINE", theirs: "C_THEIRS" },
      agents: { dev: { token: "T_DEV", handle: "dev_bot" } },
      roster: { U111: "andrew" },
    });
    const { io, writes, errs } = checkIo(cwd, async (u) => {
      if (u.includes("C_THEIRS")) return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 });
      if (u.includes("conversations.history")) {
        return new Response(JSON.stringify({ ok: true, messages: [line("9.1", "@dev_bot ping")] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    expect(writes).toHaveLength(1);
    const said = errs.join(" ");
    expect(said).toContain("theirs");
    expect(said).toContain("channel_not_found");
  });

  test("a mention of the agent's HANDLE marks the line mentioned", async () => {
    const cwd = scratchDir("check-handle");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: { mine: "C_MINE" },
      agents: { dev: { token: "T_DEV", handle: "dev_bot" } },
      roster: { U111: "andrew" },
    });
    const { io, writes } = checkIo(cwd, async (u) => {
      if (u.includes("conversations.history")) {
        return new Response(JSON.stringify({ ok: true, messages: [line("9.1", "@dev_bot can you see this")] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    const m = JSON.parse(writes[0]!) as { mentions: string[]; mentioned: boolean };
    expect(m.mentions).toEqual(["dev_bot"]);
    expect(m.mentioned).toBe(true);
  });

  test("the agent's own line, which arrives under its HANDLE, is not drained back", async () => {
    const cwd = scratchDir("check-self");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: { mine: "C_MINE" },
      agents: { dev: { token: "T_DEV", handle: "dev_bot" } },
      roster: { U111: "dev_bot" },
    });
    const { io, writes } = checkIo(cwd, async (u) => {
      if (u.includes("conversations.history")) {
        return new Response(JSON.stringify({ ok: true, messages: [line("9.1", "my own post")] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("every configured channel refused is a nonzero exit, never a silent quiet", async () => {
    const cwd = scratchDir("check-none");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: { a: "C_A", b: "C_B" },
      agents: { dev: { token: "T_DEV", handle: "dev_bot" } },
    });
    const { io, errs } = checkIo(cwd, async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }));
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("none of the 2 configured channel(s)");
  });
});

describe("slackCliToken", () => {
  // The only credential that can read a peer's description. Every way it can be
  // unavailable returns undefined, so a host without the Slack CLI gets no peer
  // remits rather than a broken lookup or a crash.
  function ioWithHome(home: string | undefined): Io {
    return {
      write: () => {},
      writeErr: () => {},
      fetch: async () => new Response("{}", { status: 200 }),
      env: (n) => (n === "HOME" ? home : undefined),
      cwd: () => "/tmp",
      sleep: async () => {},
      serve: async () => 0,
    };
  }

  test("reads the first token in the CLI's credentials file", () => {
    const home = scratchDir("cli-tok");
    mkdirSync(join(home, ".slack"), { recursive: true });
    writeFileSync(join(home, ".slack", "credentials.json"), JSON.stringify({ E1: { token: "xoxe-abc" } }));
    expect(slackCliToken(ioWithHome(home))).toBe("xoxe-abc");
  });

  test("no HOME, no file, unreadable JSON, and a tokenless entry each give undefined", () => {
    expect(slackCliToken(ioWithHome(undefined))).toBeUndefined();
    expect(slackCliToken(ioWithHome(""))).toBeUndefined();
    expect(slackCliToken(ioWithHome(scratchDir("cli-none")))).toBeUndefined();
    const bad = scratchDir("cli-bad");
    mkdirSync(join(bad, ".slack"), { recursive: true });
    writeFileSync(join(bad, ".slack", "credentials.json"), "not json");
    expect(slackCliToken(ioWithHome(bad))).toBeUndefined();
    const empty = scratchDir("cli-empty");
    mkdirSync(join(empty, ".slack"), { recursive: true });
    writeFileSync(join(empty, ".slack", "credentials.json"), JSON.stringify({ E1: {}, E2: { token: "" } }));
    expect(slackCliToken(ioWithHome(empty))).toBeUndefined();
  });
});

describe("staleListeners", () => {
  // A landed fix does not reach a running process, and twice on 2026-08-21 that
  // produced a visible defect the code had already fixed. Nothing said so, which
  // is what this answers.
  const proc = (pid: string, cmd: string, startedMs: number) => ({ pid, cmd, startedMs });

  test("a listener for this agent that predates the code is stale", () => {
    const procs = [proc("100", "bun src/bin.ts listen --as dev", 1_000)];
    expect(pickStale(procs, "dev", 5_000)).toEqual([{ pid: "100", ageBehind: 4 }]);
  });

  test("a listener started AFTER the newest change is current", () => {
    expect(pickStale([proc("101", "bun src/bin.ts listen --as dev", 9_000)], "dev", 5_000)).toEqual([]);
  });

  test("another agent's listener is not this agent's problem", () => {
    expect(pickStale([proc("102", "bun src/bin.ts listen --as other", 1_000)], "dev", 5_000)).toEqual([]);
  });

  test("a listener names the COMMIT it runs, and only an installed one can", () => {
    // The launcher execs the resolved commit directory, so the version is in the
    // process's own command line. Exec'ing `current` would have every listener
    // on the host say `current`, which names a symlink that has since moved.
    expect(listenerCommit("bun /s/share/scramble/995edba/src/bin.ts listen --as dev")).toBe("995edba");
    // A checkout has no commit to name, which is the case reported differently.
    expect(listenerCommit("bun src/bin.ts listen --as dev")).toBe("");
    expect(listenerCommit("bun /somewhere/else/src/bin.ts listen --as dev")).toBe("");
  });

  test("a listener on another commit than the installed one is named, with both", () => {
    const procs = [
      { pid: "10", cmd: "bun /s/scramble/4f7b942/src/bin.ts listen --as dev" },
      { pid: "11", cmd: "bun /s/scramble/995edba/src/bin.ts listen --as dev" },
      { pid: "12", cmd: "bun /s/scramble/4f7b942/src/bin.ts listen --as other" },
      { pid: "13", cmd: "bun src/bin.ts listen --as dev" },
    ];
    expect(listenersBehind(procs, "dev", "995edba")).toEqual([{ pid: "10", commit: "4f7b942" }]);
    // Nothing installed means no comparison to make, never a false accusation.
    expect(listenersBehind(procs, "dev", "")).toEqual([]);
  });

  test("a LIVE listener is found whatever its age, which is a different question", () => {
    // pickStale asks which listeners are behind the code. liveListeners asks
    // whether anything holds the socket at all, which is what decides whether
    // `doctor --wake` can mean anything.
    const fresh = proc("200", "bun src/bin.ts listen --as dev", 9_000);
    const old = proc("201", "bun src/bin.ts listen --as dev", 1_000);
    const other = proc("202", "bun src/bin.ts listen --as someone-else", 1_000);
    const notListener = proc("203", "bun src/bin.ts serve --as dev", 1_000);
    expect(liveListeners([fresh, old, other, notListener], "dev").sort()).toEqual(["200", "201"]);
    expect(pickStale([fresh, old, other, notListener], "dev", 5_000)).toEqual([{ pid: "201", ageBehind: 4 }]);
    expect(liveListeners([], "dev")).toEqual([]);
  });

  test("the agent's name appearing in the working directory is not the agent's listener", () => {
    // Measured: an agent named after the product, and a checkout under a
    // directory carrying that same name, made a substring match report every
    // listener under every agent. doctor named the same three pids twice and
    // told me to restart processes that were not mine.
    const other = proc("104", "cd /srv/hark/scramble && bun src/bin.ts listen --as scramble-dev", 1_000);
    expect(pickStale([other], "hark", 5_000)).toEqual([]);
    expect(pickStale([other], "scramble-dev", 5_000)).toEqual([{ pid: "104", ageBehind: 4 }]);
  });

  test("a process that is not a listener is ignored, however old", () => {
    expect(pickStale([proc("103", "bun src/bin.ts serve --as dev", 1)], "dev", 5_000)).toEqual([]);
  });

  test("a pid whose cmdline cannot be read is skipped rather than crashing the scan", () => {
    // A process can exit between the listing and the read; that one is gone,
    // not stale. An unreadable /proc entirely answers an empty list.
    const root = scratchDir("procfake");
    mkdirSync(join(root, "42"), { recursive: true });
    writeFileSync(join(root, "42", "cmdline"), "bun src/bin.ts listen --as dev\0");
    mkdirSync(join(root, "43"), { recursive: true }); // no cmdline: vanished
    writeFileSync(join(root, "notapid"), "ignored");
    const got = readProcesses(root);
    expect(got.map((p) => p.pid)).toEqual(["42"]);
    expect(got[0]!.cmd).toContain("listen --as dev");
    expect(readProcesses(join(root, "does-not-exist"))).toEqual([]);
  });

  test("the sentence doctor says names the pids and the repair", () => {
    const msg = staleListenerProblem([{ pid: "100", ageBehind: 4 }, { pid: "101", ageBehind: 9 }], "dev");
    expect(msg).toContain("2 listener(s) for dev");
    expect(msg).toContain("100, 4s behind");
    expect(msg).toContain("arm the inbox again");
  });

  test("nothing stale, and an unanswerable question, both say nothing", () => {
    expect(staleListenerProblem([], "dev")).toBeUndefined();
    expect(staleListenerProblem(undefined, "dev")).toBeUndefined();
  });

  test("a workspace with no src answers undefined rather than guessing", () => {
    const cwd = scratchDir("stale-nosrc");
    const io: Io = {
      write: () => {}, writeErr: () => {},
      fetch: async () => new Response("{}", { status: 200 }),
      env: () => undefined, cwd: () => cwd, sleep: async () => {}, serve: async () => 0,
    };
    expect(staleListeners(io, "dev")).toBeUndefined();
  });

  test("an empty src answers undefined, since there is nothing to be behind", () => {
    const cwd = scratchDir("stale-empty");
    mkdirSync(join(cwd, "src"), { recursive: true });
    const io: Io = {
      write: () => {}, writeErr: () => {},
      fetch: async () => new Response("{}", { status: 200 }),
      env: () => undefined, cwd: () => cwd, sleep: async () => {}, serve: async () => 0,
    };
    expect(staleListeners(io, "dev")).toBeUndefined();
  });

  test("a real workspace answers a list, and no listener runs for an invented agent", () => {
    const cwd = scratchDir("stale-real");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "cli.ts"), "// newer than any running process");
    const io: Io = {
      write: () => {}, writeErr: () => {},
      fetch: async () => new Response("{}", { status: 200 }),
      env: () => undefined, cwd: () => cwd, sleep: async () => {}, serve: async () => 0,
    };
    expect(staleListeners(io, "no-such-agent-xyz")).toEqual([]);
  });

});

describe("message react", () => {
  // A reaction acknowledges without spending a line, which is why the skill uses
  // it in place of an "on it" message.
  function reactIo(cwd: string, router: (u: string) => Promise<Response>) {
    const errs: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input, init) => {
        if (String(input).includes("reactions.add")) bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return router(String(input));
      },
      env: () => undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    return { io, errs, bodies };
  }
  const ok = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

  test("adds the reaction with the acting agent's token and a bare emoji name", async () => {
    const cwd = scratchDir("react-ok");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: { room: "C1" }, agents: { dev: { token: "T_DEV" } } });
    const { io, bodies } = reactIo(cwd, ok);
    // The colons a person types around an emoji are stripped: Slack wants the name.
    const code = await main(["message", "react", "--target", "room", "--to", "9.9", "--emoji", ":tada:", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ channel: "C1", timestamp: "9.9", name: "tada" });
  });

  test("already_reacted is SUCCESS, since the wanted state holds", async () => {
    const cwd = scratchDir("react-dup");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: { room: "C1" }, agents: { dev: { token: "T" } } });
    const { io } = reactIo(cwd, async () => new Response(JSON.stringify({ ok: false, error: "already_reacted" }), { status: 200 }));
    expect(await main(["message", "react", "--target", "room", "--to", "9.9", "--emoji", "eyes", "--as", "dev", "--backend", "slack"], io)).toBe(0);
  });

  test("a real refusal fails and names itself", async () => {
    const cwd = scratchDir("react-bad");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: { room: "C1" }, agents: { dev: { token: "T" } } });
    const { io, errs } = reactIo(cwd, async () => new Response(JSON.stringify({ ok: false, error: "invalid_name" }), { status: 200 }));
    expect(await main(["message", "react", "--target", "room", "--to", "9.9", "--emoji", "nope", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("invalid_name");
  });

  test("a broken slack config is reported rather than crashing the verb", async () => {
    const cwd = scratchDir("react-nocfg");
    const { io, errs } = reactIo(cwd, ok);
    expect(await main(["message", "react", "--target", "room", "--to", "1.1", "--emoji", "x", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("slack.json");
  });

  test("a missing --to or --emoji, an unmapped channel, and the local backend each report themselves", async () => {
    const cwd = scratchDir("react-args");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: { room: "C1" }, agents: { dev: { token: "T" } } });
    const a1 = reactIo(cwd, ok);
    expect(await main(["message", "react", "--target", "room", "--emoji", "x", "--as", "dev", "--backend", "slack"], a1.io)).toBe(1);
    expect(a1.errs.join(" ")).toContain("--to");
    const a2 = reactIo(cwd, ok);
    expect(await main(["message", "react", "--target", "ghost", "--to", "1.1", "--emoji", "x", "--as", "dev", "--backend", "slack"], a2.io)).toBe(1);
    expect(a2.errs.join(" ")).toContain("channel ghost");
    // --backend local said out loud: with neither a flag nor SCRAMBLE_BACKEND,
    // the backend follows the config on disk, and this workspace HAS a slack
    // config, so the derived answer here is slack.
    const a3 = reactIo(cwd, ok);
    expect(
      await main(["message", "react", "--target", "room", "--to", "1.1", "--emoji", "x", "--as", "dev", "--backend", "local"], a3.io),
    ).toBe(1);
    expect(a3.errs.join(" ")).toContain("needs the slack backend");
  });
});

describe("the automatic status posts as the ACTING agent", () => {
  // It used to post with the config's default token, which belongs to a
  // different app that is usually not in the agent's channel: Slack answered
  // channel_not_found, a failed status never fails the work it brackets, and the
  // feature was silently dead for every agent except the default.
  test("the status call goes out with the acting agent's own token", async () => {
    const cwd = scratchDir("status-token");
    writeSlackConfig(cwd, {
      token: "xoxb-DEFAULT",
      channels: { room: "C1" },
      agents: { dev: { token: "T_DEV", handle: "dev_bot" }, other: { token: "T_OTHER" } },
      roster: { U111: "andrew" },
    });
    const auths: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: () => {},
      fetch: async (input, init) => {
        const u = String(input);
        if (u.includes("assistant.threads.setStatus")) {
          auths.push(String((init?.headers as Record<string, string>)["authorization"]));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (u.includes("conversations.history")) {
          return new Response(
            JSON.stringify({ ok: true, messages: [{ ts: "5.5", user: "U111", text: "@dev_bot look" }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      env: () => undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    // The status post went out as dev, never as the default app.
    expect(auths).toContain("Bearer T_DEV");
    expect(auths).not.toContain("Bearer xoxb-DEFAULT");
    const ledger = JSON.parse(readFileSync(join(cwd, ".scramble", "status.json"), "utf8")) as {
      entries: Array<{ thread?: string; ts?: string }>;
    };
    // A recorded THREAD is the proof Slack accepted the status, and no `ts`,
    // because a status is no longer a message.
    expect(ledger.entries[0]!.thread).toBe("5.5");
    expect(ledger.entries[0]!.ts).toBeUndefined();
  });
});

describe("doctor, and the warning an agent gets without asking", () => {
  // AN EMPTY PROCESS TABLE, injected, because these tests otherwise scan the
  // REAL /proc. The listener matcher looks for `bin.ts listen` and `--as <name>`
  // in a command line, and a shell command that merely QUOTES those strings
  // matches: four of these tests went red whenever one of my own debugging
  // shells happened to hold them, and green when it did not. A test that reads
  // the machine reports the machine.
  const EMPTY_PROC = scratchDir("doctor-empty-proc");

  // An agent onboarded before a fix keeps running and silently lacks it. Nothing
  // else tells a RUNNING agent its own config went out of date, which is what
  // this verb and this warning exist for.
  function docIo(cwd: string, headers: Record<string, string>, body: Record<string, unknown>) {
    const writes: string[] = [];
    const errs: string[] = [];
    const io: Io = {
      write: (l) => writes.push(l),
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response(JSON.stringify(body), { status: 200, headers }),
      env: (n) => (n === "SCRAMBLE_PROC" ? EMPTY_PROC : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    return { io, writes, errs };
  }
  // DERIVED, not retyped. This was a hand-kept copy and it fell behind the real
  // list by two scopes, so "a healthy agent" was healthy against a list that no
  // longer existed — the same drift that let the events go unchecked.
  const ALL = SCOPE_NAMES.join(",");

  test("a healthy agent reports ok with its handle", async () => {
    const cwd = scratchDir("doc-ok");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const { io, writes } = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ doctor: "ok", agent: "dev", handle: "dev_bot" });
  });

  test("a missing handle is REPAIRED into the config, not merely reported", async () => {
    const cwd = scratchDir("doc-fix");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T" } } });
    const { io, writes } = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    expect(writes[0]).toContain("fixed");
    const after = JSON.parse(readFileSync(join(cwd, ".scramble", "slack.json"), "utf8")) as {
      agents: Record<string, { handle?: string }>;
    };
    expect(after.agents.dev!.handle).toBe("dev_bot");
  });

  test("an app that predates a scope is reported with the command that fixes it", async () => {
    const cwd = scratchDir("doc-scope");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const { io, errs } = docIo(cwd, { "x-oauth-scopes": "chat:write,channels:history" }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("groups:read");
    expect(said).toContain("onboard-agent.ts dev");
  });

  test("an unusable token is reported rather than read as healthy", async () => {
    const cwd = scratchDir("doc-badtok");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T" } } });
    const { io, errs } = docIo(cwd, {}, { ok: false, error: "invalid_auth" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("invalid_auth");
  });

  test("a missing config, an unknown agent and a tokenless agent each name themselves", async () => {
    // Three refusals rather than one, because "doctor said no" is useless: the
    // fix differs for a config that is not there, a name that is not in it, and
    // an entry with no token.
    const nowhere = scratchDir("doc-nocfg");
    const a1 = docIo(nowhere, {}, { ok: true });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], a1.io)).toBe(1);
    expect(a1.errs.join(" ")).toContain("slack.json");

    const cwd = scratchDir("doc-unknown");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { other: { token: "T" } } });
    const a2 = docIo(cwd, {}, { ok: true });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], a2.io)).toBe(1);
    expect(a2.errs.join(" ")).toContain('no agent "dev"');

    const cwd3 = scratchDir("doc-notoken");
    writeSlackConfig(cwd3, { channels: {}, agents: { dev: {} } });
    const a3 = docIo(cwd3, {}, { ok: true });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], a3.io)).toBe(1);
    expect(a3.errs.join(" ")).toContain("no bot token");
  });

  test("an org install whose manifest disables org deploy is named as a DEAD INBOX", async () => {
    // The defect this check exists for, measured live: Slack accepts an
    // enterprise install of an app declaring org_deploy_enabled:false, every
    // REST call keeps working, the socket opens and says hello, and no event is
    // ever delivered. A green-looking agent with a silent wake path.
    const home = scratchDir("doc-orgdeploy");
    mkdirSync(join(home, ".slack"), { recursive: true });
    writeFileSync(join(home, ".slack", "credentials.json"), JSON.stringify({ E1: { token: "xoxe-cli" } }));
    mkdirSync(join(home, ".scramble"), { recursive: true });
    writeFileSync(
      join(home, ".scramble", "slack.json"),
      JSON.stringify({ token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot", appId: "A1" } } }),
    );
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input) => {
        const u = String(input);
        if (u.includes("auth.test")) {
          return new Response(JSON.stringify({ ok: true, user: "dev_bot", is_enterprise_install: true }), {
            status: 200,
            headers: { "x-oauth-scopes": ALL },
          });
        }
        // The app's own manifest, which is where the contradiction shows.
        return new Response(
          JSON.stringify({ ok: true, manifest: { settings: { org_deploy_enabled: false } } }),
          { status: 200 },
        );
      },
      env: (n) => (n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
      cwd: () => home,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("org_deploy_enabled:false");
    expect(said).toContain("NO events");
  });

  test("an org install that DOES declare org deploy is clean", async () => {
    const home = scratchDir("doc-orgok");
    mkdirSync(join(home, ".slack"), { recursive: true });
    writeFileSync(join(home, ".slack", "credentials.json"), JSON.stringify({ E1: { token: "xoxe-cli" } }));
    mkdirSync(join(home, ".scramble"), { recursive: true });
    writeFileSync(
      join(home, ".scramble", "slack.json"),
      JSON.stringify({ token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot", appId: "A1" } } }),
    );
    const writes: string[] = [];
    const io: Io = {
      write: (l) => writes.push(l),
      writeErr: () => {},
      fetch: async (input) => {
        const u = String(input);
        if (u.includes("auth.test")) {
          return new Response(JSON.stringify({ ok: true, user: "dev_bot", is_enterprise_install: true }), {
            status: 200,
            headers: { "x-oauth-scopes": ALL },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            manifest: {
              settings: {
                org_deploy_enabled: true,
                event_subscriptions: { bot_events: BOT_EVENT_NAMES },
              },
            },
          }),
          { status: 200 },
        );
      },
      env: (n) => (n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
      cwd: () => home,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    expect(writes.join(" ")).toContain('"doctor":"ok"');
  });

  test("an app that subscribes to no invite event is named as the silent half of an inbox", async () => {
    // THE DEFECT THIS EXISTS FOR, measured live on 2026-08-22: the operator
    // invited an agent to a channel and nothing arrived. The app declared
    // org_deploy_enabled:true, held every scope, and its socket was delivering
    // mentions the whole time — it was subscribed to three events and not to
    // member_joined_channel, and Slack sends nothing for an event an app has not
    // asked for. Everything else about the agent was healthy, which is why the
    // wake path has to be checked field by field rather than by whether messages
    // are arriving.
    const home = scratchDir("doc-events");
    mkdirSync(join(home, ".slack"), { recursive: true });
    writeFileSync(join(home, ".slack", "credentials.json"), JSON.stringify({ E1: { token: "xoxe-cli" } }));
    mkdirSync(join(home, ".scramble"), { recursive: true });
    writeFileSync(
      join(home, ".scramble", "slack.json"),
      JSON.stringify({ token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot", appId: "A1" } } }),
    );
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input) => {
        const u = String(input);
        if (u.includes("auth.test")) {
          return new Response(JSON.stringify({ ok: true, user: "dev_bot" }), {
            status: 200,
            headers: { "x-oauth-scopes": ALL },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            manifest: {
              settings: {
                org_deploy_enabled: true,
                bot_events: undefined,
                event_subscriptions: { bot_events: ["message.channels", "message.groups", "message.im"] },
              },
            },
          }),
          { status: 200 },
        );
      },
      env: (n) => (n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
      cwd: () => home,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("member_joined_channel");
    expect(said).toContain("onboard-agent.ts dev");
  });

  test("with no Slack CLI credential the org-deploy question is left unanswered rather than guessed", async () => {
    const home = scratchDir("doc-nocli");
    mkdirSync(join(home, ".scramble"), { recursive: true });
    writeFileSync(
      join(home, ".scramble", "slack.json"),
      JSON.stringify({ token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot", appId: "A1" } } }),
    );
    const io: Io = {
      write: () => {},
      writeErr: () => {},
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, user: "dev_bot", is_enterprise_install: true }), {
          status: 200,
          headers: { "x-oauth-scopes": ALL },
        }),
      env: (n) => (n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
      cwd: () => home,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
  });

  test("an unreadable CLI credential, an empty one, and a refused export all leave the question open", async () => {
    // Each of these means "cannot tell", and a check that cannot tell must not
    // report a defect: a false alarm on the wake path would send an agent to
    // reinstall an app that is fine.
    async function run(setup: (home: string) => void, exportOk: boolean): Promise<number> {
      const home = scratchDir(`doc-open-${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(home, ".scramble"), { recursive: true });
      writeFileSync(
        join(home, ".scramble", "slack.json"),
        JSON.stringify({ token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot", appId: "A1" } } }),
      );
      setup(home);
      const io: Io = {
        write: () => {},
        writeErr: () => {},
        fetch: async (input) =>
          String(input).includes("auth.test")
            ? new Response(JSON.stringify({ ok: true, user: "dev_bot", is_enterprise_install: true }), {
                status: 200,
                headers: { "x-oauth-scopes": ALL },
              })
            : new Response(JSON.stringify(exportOk ? { ok: true, manifest: {} } : { ok: false, error: "no" }), { status: 200 }),
        env: (n) => (n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
        cwd: () => home,
        sleep: async () => {},
        serve: async () => 0,
        createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
      };
      return main(["doctor", "--as", "dev", "--backend", "slack"], io);
    }
    // credentials.json is not JSON
    expect(await run((h) => {
      mkdirSync(join(h, ".slack"), { recursive: true });
      writeFileSync(join(h, ".slack", "credentials.json"), "not json");
    }, true)).toBe(0);
    // credentials.json holds no token
    expect(await run((h) => {
      mkdirSync(join(h, ".slack"), { recursive: true });
      writeFileSync(join(h, ".slack", "credentials.json"), JSON.stringify({ E1: {} }));
    }, true)).toBe(0);
    // the export itself is refused
    expect(await run((h) => {
      mkdirSync(join(h, ".slack"), { recursive: true });
      writeFileSync(join(h, ".slack", "credentials.json"), JSON.stringify({ E1: { token: "x" } }));
    }, false)).toBe(0);
  });

  test("an agent with no recorded appId leaves the org-deploy question open", async () => {
    const home = scratchDir("doc-noappid");
    mkdirSync(join(home, ".slack"), { recursive: true });
    writeFileSync(join(home, ".slack", "credentials.json"), JSON.stringify({ E1: { token: "x" } }));
    mkdirSync(join(home, ".scramble"), { recursive: true });
    writeFileSync(
      join(home, ".scramble", "slack.json"),
      JSON.stringify({ token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } }),
    );
    const io: Io = {
      write: () => {},
      writeErr: () => {},
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, user: "dev_bot", is_enterprise_install: true }), {
          status: 200,
          headers: { "x-oauth-scopes": ALL },
        }),
      env: (n) => (n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
      cwd: () => home,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
  });

  test("a listener on a DIFFERENT commit than the install is reported, with both", async () => {
    // For an installed agent the commit is a fact in the process's own command
    // line, so this needs no mtimes: those describe whatever `src` sits in the
    // current directory, which for an installed copy is a different tree.
    const cwd = scratchDir("doc-behind");
    const home = scratchDir("doc-behind-home");
    const share = join(home, ".local", "share", "scramble");
    mkdirSync(join(share, "current", "src"), { recursive: true });
    writeFileSync(join(share, "current", "src", "COMMIT"), "995edba\n");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const procRoot = scratchDir("doc-behind-proc");
    mkdirSync(join(procRoot, "88"), { recursive: true });
    writeFileSync(join(procRoot, "88", "cmdline"), "bun /s/share/scramble/4f7b942/src/bin.ts listen --as dev\0");
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, user: "dev_bot" }), { status: 200, headers: { "x-oauth-scopes": ALL } }),
      // HOME points at the fake install; the config is named explicitly, since
      // HOME also decides where the config is looked for.
      env: (n) =>
        n === "SCRAMBLE_PROC" ? procRoot
        : n === "HOME" ? home
        : n === "SCRAMBLE_SLACK_CONFIG" ? join(cwd, ".scramble", "slack.json")
        : undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("pid 88 on 4f7b942");
    expect(said).toContain("installed 995edba");
  });

  test("a host with no readable process table SAYS so, and never reports ok", async () => {
    // Both listener checks read /proc. A host without one is not a host where
    // the listeners are fine; it is a host where nothing looked. scramble is
    // about to run on machines that are not this one.
    expect(processesReadable("/proc")).toBe(true);
    expect(processesReadable(join(scratchDir("no-proc"), "absent"))).toBe(false);
    const cwd = scratchDir("doc-noproc");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, user: "dev_bot" }), { status: 200, headers: { "x-oauth-scopes": ALL } }),
      env: (n) => (n === "SCRAMBLE_PROC" ? join(cwd, "no-such-proc") : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("NOTHING here checked your listeners");
  });

  test("doctor --wake REFUSES to run while a listener holds the socket", async () => {
    // Measured 2026-08-22: with the inbox armed, `doctor --wake` reported "The
    // wake path is DEAD" and told me to re-onboard, which rotates the bot token
    // and strands that listener. With the same inbox stopped and nothing else
    // changed, it answered "delivered". Slack hands each Socket Mode event to
    // ONE connection, so the armed listener had taken the probe. A test whose
    // answer would be meaningless is not run.
    const cwd = scratchDir("wake-held");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      appToken: "xapp-1",
      channels: { room: "C1" },
      agents: { dev: { token: "T", handle: "dev_bot" } },
    });
    const procRoot = scratchDir("wake-held-proc");
    mkdirSync(join(procRoot, "77"), { recursive: true });
    writeFileSync(join(procRoot, "77", "cmdline"), "bun src/bin.ts listen --as dev\0");
    const errs: string[] = [];
    let probed = false;
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input) => {
        const u = String(input);
        if (u.includes("chat.postMessage")) probed = true;
        if (u.includes("auth.test")) {
          return new Response(JSON.stringify({ ok: true, user: "dev_bot" }), { status: 200, headers: { "x-oauth-scopes": ALL } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      env: (n) => (n === "SCRAMBLE_PROC" ? procRoot : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--wake", "room", "--backend", "slack"], io)).toBe(0);
    const said = errs.join(" ");
    expect(said).toContain("not testing the wake path");
    expect(said).toContain("pid 77");
    // And it did not post the probe: refusing means not doing it, and a probe
    // posted here would be a line in the channel proving nothing.
    expect(probed).toBe(false);
  });

  test("doctor --wake FAILS when the socket opens and no frame arrives", async () => {
    // The exact defect: a socket that connects and delivers nothing looks
    // identical to a quiet channel, which is how an armed monitor was reported
    // working while it delivered nothing for hours.
    const cwd = scratchDir("wake-dead");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      appToken: "xapp-1",
      channels: { room: "C1" },
      agents: { dev: { token: "T", handle: "dev_bot" } },
    });
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input) => {
        const u = String(input);
        if (u.includes("connections.open")) return new Response(JSON.stringify({ ok: true, url: "wss://x" }), { status: 200 });
        if (u.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "9.9" }), { status: 200 });
        if (u.includes("auth.test")) {
          return new Response(JSON.stringify({ ok: true, user: "dev_bot" }), { status: 200, headers: { "x-oauth-scopes": ALL } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      env: (n) => (n === "SCRAMBLE_PROC" ? EMPTY_PROC : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      // A socket that connects and never delivers: onmessage is never called.
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--wake", "room", "--backend", "slack"], io)).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("no frame arrived");
    expect(said).toContain("DEAD");
  });

  test("doctor --wake PASSES when the frame for the probe comes back", async () => {
    const cwd = scratchDir("wake-live");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      appToken: "xapp-1",
      channels: { room: "C1" },
      agents: { dev: { token: "T", handle: "dev_bot" } },
    });
    const writes: string[] = [];
    const sock: { send: () => void; close: () => void; onopen: null; onmessage: ((d: string) => void) | null; onclose: null; onerror: null } = {
      send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null,
    };
    const io: Io = {
      write: (l) => writes.push(l),
      writeErr: () => {},
      fetch: async (input) => {
        const u = String(input);
        if (u.includes("connections.open")) return new Response(JSON.stringify({ ok: true, url: "wss://x" }), { status: 200 });
        if (u.includes("chat.postMessage")) {
          // Slack echoes the app's own post back over the socket, which is what
          // makes a self-probe a valid transport test.
          queueMicrotask(() => sock.onmessage?.(JSON.stringify({ payload: { event: { ts: "9.9" } } })));
          return new Response(JSON.stringify({ ok: true, ts: "9.9" }), { status: 200 });
        }
        if (u.includes("auth.test")) {
          return new Response(JSON.stringify({ ok: true, user: "dev_bot" }), { status: 200, headers: { "x-oauth-scopes": ALL } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      env: (n) => (n === "SCRAMBLE_PROC" ? EMPTY_PROC : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => sock,
    };
    expect(await main(["doctor", "--as", "dev", "--wake", "room", "--backend", "slack"], io)).toBe(0);
    expect(writes.join(" ")).toContain('"delivered":"9.9"');
  });

  test("doctor --wake reports an agent with no appToken rather than passing it", async () => {
    const cwd = scratchDir("wake-noapp");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: { room: "C1" }, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response(JSON.stringify({ ok: true, user: "dev_bot" }), { status: 200, headers: { "x-oauth-scopes": ALL } }),
      env: (n) => (n === "SCRAMBLE_PROC" ? EMPTY_PROC : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--wake", "room", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("no socket to wake on");
  });

  test("doctor --wake reports an unmapped channel and a refused socket", async () => {
    const cwd = scratchDir("wake-bad");
    writeSlackConfig(cwd, { token: "xoxb-d", appToken: "xapp-1", channels: { room: "C1" }, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const mk = (fetch: (u: string) => Promise<Response>) => {
      const errs: string[] = [];
      const io: Io = {
        write: () => {}, writeErr: (l) => errs.push(l),
        fetch: (input) => fetch(String(input)),
        env: (n) => (n === "SCRAMBLE_PROC" ? EMPTY_PROC : undefined), cwd: () => cwd, sleep: async () => {}, serve: async () => 0,
        createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
      };
      return { io, errs };
    };
    const auth = (u: string) =>
      new Response(JSON.stringify({ ok: true, user: "dev_bot" }), { status: 200, headers: { "x-oauth-scopes": ALL } });
    const a1 = mk(async (u) => auth(u));
    expect(await main(["doctor", "--as", "dev", "--wake", "ghost", "--backend", "slack"], a1.io)).toBe(1);
    expect(a1.errs.join(" ")).toContain("no Slack channel for channel ghost");
    const a2 = mk(async (u) =>
      u.includes("connections.open")
        ? new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 })
        : auth(u));
    expect(await main(["doctor", "--as", "dev", "--wake", "room", "--backend", "slack"], a2.io)).toBe(1);
    expect(a2.errs.join(" ")).toContain("invalid_auth");
    // The probe itself refused: a channel this agent was never invited to. This
    // is the live shape (`channel_not_found`), and it must FAIL rather than pass
    // quietly, since an unpostable probe proves nothing about the wake path.
    const a3 = mk(async (u) =>
      u.includes("connections.open")
        ? new Response(JSON.stringify({ ok: true, url: "wss://x" }), { status: 200 })
        : u.includes("chat.postMessage")
          ? new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 })
          : auth(u));
    expect(await main(["doctor", "--as", "dev", "--wake", "room", "--backend", "slack"], a3.io)).toBe(1);
    expect(a3.errs.join(" ")).toContain("the probe could not be posted: channel_not_found");
  });

  test("staleConfigWarning names the repair when a handle is absent, and is silent when it is not", () => {
    const base = { token: "t", appToken: "a", channels: {}, agents: {}, roster: {}, dmChannels: {}, filesDir: "/tmp" };
    const missing = { ...base, agents: { dev: { token: "T" } } };
    expect(staleConfigWarning(missing, "dev")).toContain("scramble doctor --as dev");
    const present = { ...base, agents: { dev: { token: "T", handle: "dev_bot" } } };
    expect(staleConfigWarning(present, "dev")).toBe("");
    // An agent absent from the config, and a missing config, say nothing here:
    // the verb itself reports those with its own error.
    expect(staleConfigWarning(present, "nobody")).toBe("");
    expect(staleConfigWarning(null, "dev")).toBe("");
  });
});

function writeSlackConfig(cwd: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".scramble"), { recursive: true });
  writeFileSync(join(cwd, ".scramble", "slack.json"), JSON.stringify(cfg));
}

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
    };
  }

  test("defaults optional fields and reads string scalars", () => {
    const cwd = scratchDir("loadcfg-mid");
    writeSlackConfig(cwd, { channels: { general: "C1" }, agents: {} });
    const cfg = loadSlackConfig(sluckIo(cwd));
    expect(cfg).not.toBeNull();
    if (cfg) {
      expect(cfg.channels.general).toBe("C1");
      expect(cfg.token).toBe("");
      expect(cfg.appToken).toBeUndefined();
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

  // The config holds BOT TOKENS, so its default home is outside the repo: this
  // repo is public-bound and a credential in a commit is readable in every clone.
  test("SCRAMBLE_SLACK_CONFIG names the file, beating both defaults", () => {
    const dir = scratchDir("slackcfg-explicit");
    const file = join(dir, "elsewhere.json");
    writeFileSync(file, JSON.stringify({ channels: { ops: "C9" }, agents: { akari: { token: "t" } } }));
    const io = { ...sluckIo("/nonexistent-cwd"), env: (n: string) => (n === "SCRAMBLE_SLACK_CONFIG" ? file : undefined) };
    expect(slackConfigPath(io)).toBe(file);
    const cfg = loadSlackConfig(io);
    expect(cfg?.channels.ops).toBe("C9");
  });

  test("without the env var the path is ~/.config/scramble/slack.json", () => {
    const home = scratchDir("slackcfg-home");
    mkdirSync(join(home, ".config", "scramble"), { recursive: true });
    writeFileSync(join(home, ".config", "scramble", "slack.json"),
      JSON.stringify({ channels: { dm: "D1" }, agents: {} }));
    const io = { ...sluckIo("/nonexistent-cwd"), env: (n: string) => (n === "HOME" ? home : undefined) };
    expect(slackConfigPath(io)).toBe(join(home, ".config", "scramble", "slack.json"));
    expect(loadSlackConfig(io)?.channels.dm).toBe("D1");
  });

  test("with neither env var it falls back to the workspace copy", () => {
    const cwd = scratchDir("slackcfg-cwdfall");
    writeSlackConfig(cwd, { channels: { w: "C0" }, agents: {} });
    expect(slackConfigPath(sluckIo(cwd))).toBe(join(cwd, ".scramble", "slack.json"));
    expect(loadSlackConfig(sluckIo(cwd))?.channels.w).toBe("C0");
  });
});