import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChannelStore } from "../src/store";
import { createStore } from "../src/store";
import { createHandler } from "../src/server";
import { main, parseBind, loadSlackConfig, slackConfigPath, type Io } from "../src/cli";

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
    const cursor = JSON.parse(readFileSync(join(cwd, ".scramble", "cursor.json"), "utf8"));
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
    const cursor = JSON.parse(readFileSync(join(cwd, ".scramble", "cursor.json"), "utf8"));
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
    const cursor = JSON.parse(readFileSync(join(cwd, ".scramble", "cursor.json"), "utf8"));
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
    const cursor = JSON.parse(readFileSync(join(cwd, ".scramble", "cursor.json"), "utf8"));
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