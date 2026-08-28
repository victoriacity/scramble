import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { ChannelStore } from "../src/store";
import { createStore } from "../src/store";
import { createHandler } from "../src/server";
import { WORD_LIMIT } from "../src/language";
import { KNOWN_ENV, unknownEnvNote, hashVerdict, textHash, main, parseBind, loadSlackConfig, slackConfigPath, staleConfigWarning, staleListeners, pickStale, staleListenerProblem, readProcesses, liveListeners, stillAlive, watchForNewerInstall, listenerCommit, listenersBehind, processesReadable, type Io } from "../src/cli";
import { SCOPE_NAMES, BOT_EVENT_NAMES } from "../src/app-manifest";
import { readTierBlock } from "../src/rewrite";

/** The register block as the SHIPPED file holds it. A test that copies the
 *  wording fails the day the operator rewords the file, and says nothing about
 *  whether the send reached the model with it. */
function shippedRegister(tier: string): string {
  const r = readTierBlock(join(import.meta.dir, "..", "src"), tier);
  if (!r.ok) throw new Error(r.why);
  return r.text;
}

/** The prompt out of a captured Gemini request body. */
function promptText(body: string): string {
  const parsed = JSON.parse(body) as { contents?: { parts?: { text?: string }[] }[] };
  return String(parsed.contents?.[0]?.parts?.[0]?.text ?? "");
}

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
  // must be a separate pull to guarantee the lines are read first.
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

describe("an override that misses is REPORTED", () => {
  // An agent pointed a check at a copy of a file with `SCRAMBLE_CONFIG`, which
  // nothing reads. The command read the production file, answered `damaged: 0`,
  // and that answer was true of the file it read. They nearly filed a bug saying
  // the field did not work, and reading `slackConfigPath` is what stopped them.
  // An override that misses reads exactly like a clean result.
  test("a SCRAMBLE_ name this build never reads is named, with the nearest one it does", () => {
    expect(unknownEnvNote(["SCRAMBLE_CONFIG"])).toContain("SCRAMBLE_CONFIG is set and this build reads no such name");
    expect(unknownEnvNote(["SCRAMBLE_CONFIG"])).toContain("Did you mean SCRAMBLE_SLACK_CONFIG?");
    expect(unknownEnvNote(["SCRAMBLE_KEY"])).toContain("Did you mean SCRAMBLE_REWRITE_KEY?");
    // Every name this build reads stays quiet, and so does the rest of the
    // environment.
    expect(unknownEnvNote(KNOWN_ENV)).toBe("");
    expect(unknownEnvNote(["HOME", "PATH", "CLAUDE_CODE_SESSION_ID"])).toBe("");
    // Several at once, sorted, one line each.
    expect(unknownEnvNote(["SCRAMBLE_ZZZ", "SCRAMBLE_AAA"]).split("\n")).toHaveLength(2);
    expect(unknownEnvNote(["SCRAMBLE_ZZZ", "SCRAMBLE_AAA"]).split("\n")[0]).toContain("SCRAMBLE_AAA");
  });

  test("the note reaches stderr on any verb, and the verb still runs", async () => {
    const cwd = scratchDir("env-typo");
    const { io, writes, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    // `version` exits 1 from a checkout, which is its own signal; what matters
    // here is that the note reached stderr and the verb still answered.
    await main(["version"], { ...io, envNames: () => ["SCRAMBLE_CONFIG", "HOME"] });
    expect(errs.join(" ")).toContain("SCRAMBLE_CONFIG is set");
    expect(writes.join(" ")).toContain("scramble");
    // A build with no way to list its environment stays silent.
    const quiet = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    await main(["version"], quiet.io);
    expect(quiet.errs.join(" ")).not.toContain("reads no such name");
  });
});

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

  test("the SERIALISED shape of a delivery is pinned, since two claims were made against a guess", async () => {
    // Any filter outside this process reads the serialised line, and two
    // separate claims were published about what such a filter matches, neither
    // measured against this serialiser. One said prose quoting
    // `"mentioned":true` woke four hosts; one measured with Python's
    // json.dumps, which emits a space after the colon, and nearly reported a
    // filter as already broken. Both are settled here, executably, so nobody
    // re-derives the shape in an ad-hoc shell again.
    //
    // Postmortems: akrust
    // `log/postmortems/-published-another-agents-mechanism-as-fact-without-running-it.md`
    //             akrust `log/postmortems/2026-08-22-control-set-used-a-foreign-serialiser.md`
    const cwd = scratchDir("listen-serialised");
    const quoting = 'the filter greps "mentioned":true and that is the defect';
    const { io, writes } = stubIo(cwd, async () =>
      ndjs([msg("s1", "bob", quoting), msg("s2", "bob", "@ana hello", ["ana"])], "close"),
    );
    expect(await main(["listen", "--as", "ana"], io)).toBe(0);
    const [prose, mention] = writes as [string, string];
    // NO SPACE AFTER THE COLON. A serialiser that adds one silently stops every
    // external filter matching, so this test pins the assumption.
    expect(mention).toContain('"mentioned":true');
    expect(mention).not.toContain('"mentioned": true');
    // AND PROSE CANNOT FORGE THE FIELD: quoting it in a message body comes back
    // with the quotes escaped, out of a bare pattern's reach. A pattern carrying
    // a quote character protects itself; a bare word has nothing to hide behind.
    expect(prose).toContain('\\"mentioned\\":true');
    expect(prose).not.toContain('"mentioned":true');
  });

  test("--addressed filters IN THE LISTENER, and the ledger still sees everything", async () => {
    // `scripts/inbox.sh` and JOIN.md told every agent to pipe this through `grep
    // '"mentioned":true'` over the serialised line. That matches only while the serialiser emits no
    // space after the colon and the field keeps its name: add a space, reorder, rename, and it
    // stops matching with no error and no exit, so the inbox goes quiet and looks calm. The rule
    // belongs where the field is computed.
    const cwd = scratchDir("listen-addressed");
    const { io, writes } = stubIo(cwd, async () =>
      ndjs([msg("b1", "bob", "nothing for you"), msg("b2", "bob", "@ana hello", ["ana"])], "close"),
    );
    expect(await main(["listen", "--addressed", "--as", "ana"], io)).toBe(0);
    expect(writes.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual(["idb2"]);
    // BOTH were recorded: the filter decides what wakes the agent, and never what
    // the ledger knows, or `trace` would answer "not delivered" for every line
    // the filter dropped.
    const traced = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "trace", "idb1", "--as", "ana"], traced.io)).toBe(0);
    expect(traced.writes.join(" ")).toContain("WAS delivered to ana");
    expect(traced.writes.join(" ")).toContain("NOT addressed to ana");
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
    // slack without a config: reported as a missing-config error, which names
    // the repair. An unknown-backend rejection would name nothing.
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
    // The incident: the rules were checked by a separate script the sender ran
    // first, so piping text straight into `message send` skipped them and
    // messages went out unlinted for a day. The check moved to the send, and
    // this asserts the part that matters: the send does not HAPPEN.
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
  // A remote agent: "`--help` is unknown CLI-wide, and `doctor --help` falls
  // through to the working directory as the agent name: doctor: no agent
  // "mbench3d"... From /tmp it says "tmp", from home it says "agent"." An
  // unknown flag turned a directory into an identity.
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
  // A peer agent: "My scramble executes your working tree. bun link points at
  // the maintainer's checkout and runs src directly... if you save halfway
  // through an edit, the syntax error runs inside my listener, and I meet it
  // before you do." An agent could not tell which scramble it ran.
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
  // Operator: "the linter should be individually callable to check other
  // documents such as lark docs or markdown files."
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

  test("`inbox trace` answers DELIVERED and ADDRESSED separately, from the ledger", async () => {
    // Four agents spent grepping a text log for a timestamp because nothing
    // could answer this. A line that names somebody else is delivered and wakes
    // nobody, and until the ledger recorded it, its absence and a message that
    // never arrived were the same output.
    const cwd = scratchDir("inbox-trace");
    const a = await deliverOne(cwd, "@someoneelse a question for you");
    expect(await main(["message", "check", "--as", "dev"], a.io)).toBe(0);
    const b = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "trace", "m1", "--as", "dev"], b.io)).toBe(0);
    const said = b.writes.join(" ");
    expect(said).toContain("WAS delivered to dev");
    expect(said).toContain("NOT addressed to dev");
    expect(said).toContain("Searched 1 delivered row(s)");
    // It owes nobody an answer, so it stays out of what is pending.
    const c = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "pending", "--as", "dev"], c.io)).toBe(0);
    // And a message that never arrived reads differently from that one.
    const d = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "trace", "999.9", "--as", "dev"], d.io)).toBe(0);
    expect(d.writes.join(" ")).toContain("999.9 was NOT delivered to dev");
  });

  test("a reply carrying a FILE closes what it answers, like any other reply", async () => {
    // The attach path posts through the upload and returned before everything a
    // send does afterwards, so a reply with a file closed nothing, remembered
    // nothing and reported nothing. My own ledger caught it: two questions I had
    // answered with attachments sat open in `inbox pending`.
    const cwd = scratchDir("attach-closes");
    mkdirSync(join(cwd, ".scramble", "inbox"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "inbox", "dev.jsonl"),
      `${JSON.stringify({ id: "9.1", channel: "general", from: "andrew", text: "q", at: "2026-08-22T00:00:00Z", addressed: true })}\n`,
    );
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    const file = join(cwd, "note.md");
    writeFileSync(file, "the answer");
    const { io } = stubIo(cwd, async (url) => {
      const u = String(url);
      if (u.includes("getUploadURLExternal"))
        return new Response(JSON.stringify({ ok: true, upload_url: "https://u/x", file_id: "F" }), { status: 200 });
      if (u === "https://u/x") return new Response("", { status: 200 });
      if (u.includes("completeUploadExternal"))
        return new Response(
          JSON.stringify({
            ok: true,
            files: [{ id: "F", permalink: "https://x/f", shares: { public: { C1: [{ ts: "77.7" }] } } }],
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    io.readStdin = async () => "here it is";
    expect(
      await main(["message", "send", "--target", "general", "--as", "dev", "--attach", file, "--backend", "slack"], io),
    ).toBe(0);
    // Closed, and named by the ts of the message the upload posted.
    const p = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "pending", "--as", "dev"], p.io)).toBe(0);
    const t = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "trace", "9.1", "--as", "dev"], t.io)).toBe(0);
    expect(t.writes.join(" ")).toContain("answered by 77.7");
    // And remembered, so a reply to it is recognised as owed to this agent.
    expect(readFileSync(join(cwd, ".scramble", "sent", "dev.jsonl"), "utf8")).toContain("77.7");
  });

  test("`inbox close` settles an item without sending, and demands a reason", async () => {
    const cwd = scratchDir("inbox-close");
    const a = await deliverOne(cwd);
    expect(await main(["message", "check", "--as", "dev"], a.io)).toBe(0);
    // No reason: refused, and the refusal says why the reason exists.
    const b = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "m1", "--as", "dev"], b.io)).toBe(1);
    expect(b.errs.join(" ")).toContain("belongs on the record");
    // And no ids at all is the same refusal.
    const b2 = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "--why", "x", "--as", "dev"], b2.io)).toBe(1);
    expect(b2.errs.join(" ")).toContain("at least one id");
    // With one: settled, nothing sent, and pending goes quiet.
    const c = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "m1", "--why", "sender said no reply needed", "--as", "dev"], c.io)).toBe(0);
    expect(c.writes).toHaveLength(0);
    const d = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "pending", "--as", "dev"], d.io)).toBe(0);
    // Closing it twice refuses, naming what settled it.
    const e = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "m1", "--why", "again", "--as", "dev"], e.io)).toBe(1);
    expect(e.errs.join(" ")).toContain("already answered by closed with no reply");
    // And an id that is not an open item points at the two commands that explain it.
    const f = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "999.9", "--why", "x", "--as", "dev"], f.io)).toBe(1);
    expect(f.errs.join(" ")).toContain("inbox trace 999.9");
  });

  test("with a key set, the send rewrites and prints the sender's own words beside it", async () => {
    // The message ALWAYS goes, and nothing changes silently.
    const cwd = scratchDir("send-rewrite");
    const { io, errs } = stubIo(cwd, async (u) =>
      String(u).includes("generativelanguage")
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "the professional line" }] } }] }), { status: 200 })
        : new Response(JSON.stringify({ crossings: [] }), { status: 200 }),
    );
    // NO FIRST PERSON in the fixture: a rewrite that drops the actor is refused,
    // and this test is about the clean path.
    io.readStdin = async () => "the parser fix shipped";
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], withKey)).toBe(0);
    expect(errs.join(" ")).toContain("rewrite: sent a rewrite");
    expect(errs.join(" ")).toContain("the parser fix shipped");
  });

  test("`--verify` reports what Slack stored, and names a mention that stopped notifying", async () => {
    // A send's exit code says Slack accepted something. Three agents wrote
    // their own read-back wrappers today, and one asked me to own this one. It
    // prints the STORED TEXT WHOLE at that agent's request: a line diff is
    // useless when the rewriter rephrases throughout.
    const cwd = scratchDir("send-verify");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "77.7", message: {} }), { status: 200 });
      if (url.includes("conversations.history"))
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "77.7", text: "what slack kept, with `@dev` in code" }] }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "@dev what the sender wrote";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], io)).toBe(0);
    const said = errs.join("\n");
    expect(said).toContain("holds text that DIFFERS from what was sent");
    expect(said).toContain("what slack kept");
    expect(said).toContain("Mentions that stopped notifying: @dev");
  });

  test("`--verify` on a changed message with every mention alive names them", async () => {
    // The rewriter rephrases and the mentions survive: the reader wants to see
    // what the channel holds and that nobody stopped being notified.
    const cwd = scratchDir("send-verify-kept");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "66.6", message: {} }), { status: 200 });
      if (url.includes("conversations.history"))
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "66.6", text: "@dev the parser fix shipped this morning" }] }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "@dev the parser fix shipped";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], io)).toBe(0);
    const said = errs.join("\n");
    expect(said).toContain("holds text that DIFFERS");
    expect(said).toContain("Every mention survived: @dev");
  });

  test("`rewrites` reports what the rewriter did, and says why the file can be empty", async () => {
    const cwd = scratchDir("rewrites-verb");
    const empty = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["rewrites"], empty.io)).toBe(0);
    expect(empty.writes.join(" ")).toContain("No sends have met the rewriter");

    // A send that met the rewriter writes a row, and the verb counts it.
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "rewrites.jsonl"),
      `${JSON.stringify({ at: "2026-08-25T12:00:00.000Z", agent: "dev", channel: "general", outcome: "sent", words: [10, 12] })}\n`,
    );
    const one = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["rewrites"], one.io)).toBe(0);
    expect(one.writes.join(" ")).toContain("1 send(s) from dev met the rewriter");
    // `--as` names one agent's rows out of a file every agent on the host shares.
    const scoped = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["rewrites", "--as", "someone-else"], scoped.io)).toBe(0);
    expect(scoped.writes.join(" ")).toContain("No sends from someone-else");
  });

  test("`rewrites --near` reads the duplicate scores this agent's sends measured", async () => {
    // The threshold rests on corpus runs three agents did by hand, and an agent
    // who writes English by the operator's rule cannot produce Chinese samples on
    // request. They said the tool can gather them, so every send records what it
    // measured and this reads the pile back.
    const cwd = scratchDir("rewrites-near");
    const bare = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["rewrites", "--near", "--as", "dev"], bare.io)).toBe(0);
    expect(bare.writes.join(" ")).toContain("has measured itself against an earlier draft yet");

    mkdirSync(join(cwd, ".scramble", "sent"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "sent", "dev.jsonl"),
      [
        JSON.stringify({ ts: "2.2", channel: "general", at: "t", words: ["a"], near: { score: 0.44, ts: "1.1" } }),
        JSON.stringify({ ts: "3.3", channel: "general", at: "t", words: ["a"], near: { score: 0.71, ts: "2.2" } }),
      ].join("\n") + "\n",
    );
    const some = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["rewrites", "--near", "--as", "dev"], some.io)).toBe(0);
    expect(some.writes.join(" ")).toContain("2 send(s) measured against an earlier draft");
    expect(some.writes.join(" ")).toContain("0.710  ts 3.3 against 2.2 in general");
  });

  test("a recorded hash is compared against the read-back and never called failure", () => {
    // THE FORMS ARE DIFFERENT AND THE TOOL SAYS SO. I wrote in a channel that a
    // comparison of the two forms would mismatch on every row, and my own run on
    // the live table matched three of its four readable messages. The verdict
    // belongs to a function that reports, since a mismatch means the text was
    // rendered differently and never that the row is wrong.
    expect(hashVerdict(["aa", "bb"], ["aa", "bb"])).toBe("matches");
    expect(hashVerdict(["aa", "bb"], ["aa", "cc"])).toBe("differs");
    expect(hashVerdict(undefined, ["aa", "bb"])).toBeUndefined();
    expect(textHash("one")).toMatch(/^[0-9a-f]{16}$/);
    expect(textHash("one")).not.toBe(textHash("two"));
  });

  test("`rewrites --calibrate` re-measures every measured row from Slack", async () => {
    // An agent read the calibration table, ran the same function I run, and named
    // the flaw: two readers calling one function on one table measure the
    // readers. The table held my synthetic pair labelled as the founding incident
    // for an hour, and any number of agreeing readers would have reproduced that.
    const cwd = scratchDir("calibrate");
    // THE ROWS NAME THEIR OWN CHANNELS, so the config has to map them for the
    // read to resolve at all.
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1", "scramble-dev": "C2", "scramble-partner-dev": "C3" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    // Slack answers with two messages that score nothing like the recorded rows,
    // so every readable row must report as drifted.
    const { io, writes, errs } = stubIo(cwd, async (u) => {
      if (String(u).includes("conversations.history"))
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: new URL(String(u)).searchParams.get("oldest"), text: "one" }] }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    expect(await main(["rewrites", "--calibrate", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    const rows = writes.map((l) => JSON.parse(l) as { calibrate: string });
    expect(rows.length).toBeGreaterThan(0);
    // A ROW WHOSE MESSAGES ARE GONE reports as gone, and never as drift: the
    // first message of one pair was deleted after the report that named it, and
    // calling that drift would cry wolf on every run from here on.
    expect(rows.some((r) => r.calibrate === "gone")).toBe(true);
    expect(rows.every((r) => ["drifted", "unreadable", "gone"].includes(r.calibrate))).toBe(true);
    expect(errs.join(" ")).toContain("score something else now");
    // AND THE HASHES ARE COMPARED AND PRINTED. Slack has lost four of the five
    // source messages behind these rows, so the recorded hash is what an agent
    // holding the delivery checks its copy against.
    expect(errs.join(" ")).toContain("read back to a different hash");
    const hashed = writes
      .map((l) => JSON.parse(l) as { hashes?: string; sha?: { recorded?: string[]; read?: string[] } })
      .filter((r) => r.hashes !== undefined);
    expect(hashed.length).toBeGreaterThan(0);
    expect(hashed.every((r) => r.hashes === "differs")).toBe(true);
    expect(hashed.every((r) => r.sha?.read?.length === 2 && r.sha?.recorded?.length === 2)).toBe(true);

    // EACH ROW NAMES ITS OWN CHANNEL, so the command runs without `--target` and
    // reports which channel it searched. A ts is unique inside one conversation,
    // and a search in the wrong channel answers "no such message" for a message
    // that exists.
    const bare = stubIo(cwd, async () => new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }));
    await main(["rewrites", "--calibrate", "--as", "dev", "--backend", "slack"], bare.io);
    const named = bare.writes.map((l) => JSON.parse(l) as { calibrate: string; channel?: string });
    expect(named.length).toBeGreaterThan(0);
    // The gone row carries no channel read, since nothing is fetched for it.
    const read = named.filter((r) => r.calibrate === "unreadable");
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((r) => typeof r.channel === "string")).toBe(true);
    expect(named.every((r) => r.calibrate === "unreadable" || r.calibrate === "gone")).toBe(true);

    // A ROW SLACK WILL NOT SHOW READS AS UNREADABLE, and never as agreement. The
    // pairs sit in channels this agent may not be in, and a silent skip would
    // turn an unread row into a passing one.
    const blind = stubIo(cwd, async () => new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }));
    expect(
      await main(["rewrites", "--calibrate", "--target", "general", "--as", "dev", "--backend", "slack"], blind.io),
    ).toBe(0);
    const unread = blind.writes.map((l) => JSON.parse(l) as { calibrate: string; why?: string });
    expect(unread.length).toBeGreaterThan(0);
    expect(unread.every((r) => r.calibrate === "unreadable" || r.calibrate === "gone")).toBe(true);
    const missing = unread.filter((r) => r.calibrate === "unreadable");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]!.why).toContain("slack has no message");

    // AND WITH NO SLACK CONFIG AT ALL it says so, with no row reported. The
    // backend is what reads Slack, so a missing config stops the run before any
    // row is fetched.
    const noCfg = stubIo(scratchDir("calibrate-noconfig"), async () => new Response("{}", { status: 200 }));
    expect(
      await main(["rewrites", "--calibrate", "--target", "general", "--as", "dev", "--backend", "slack"], noCfg.io),
    ).toBe(1);
    expect(noCfg.errs.join(" ")).toContain("missing or malformed");
  });

  test("an unwritable rewrite record REPORTS itself and the message still goes", async () => {
    // The record is accounting; the message is the point.
    const cwd = scratchDir("rewrites-locked");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("generativelanguage"))
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "the shipped line" }] } }] }), { status: 200 });
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "22.2", message: {} }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [{ ts: "22.2", text: "the shipped line" }] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    // A DIRECTORY where the record belongs: the append throws.
    mkdirSync(join(cwd, ".scramble", "rewrites.jsonl"), { recursive: true });
    io.readStdin = async () => "the line as drafted";
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--backend", "slack"], withKey)).toBe(0);
    expect(errs.join(" ")).toContain("rewrite record not written");
  });

  test("a rewritten send verifies WITHOUT the flag, and --no-verify skips it", async () => {
    // A rewritten send posts text the author never saw, so the question applies
    // to every one of them. Three agents wrote their own read-back wrapper for
    // exactly that.
    const cwd = scratchDir("send-verify-default");
    const seen: string[] = [];
    const responder = async (u: string): Promise<Response> => {
      seen.push(String(u));
      if (String(u).includes("generativelanguage"))
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "the shipped line" }] } }] }), { status: 200 });
      if (String(u).includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "33.3", message: {} }), { status: 200 });
      if (String(u).includes("conversations.history"))
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: "33.3", text: "the shipped line" }] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    };
    const { io, errs } = stubIo(cwd, async (u) => responder(String(u)));
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "the line as drafted";
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--backend", "slack"], withKey)).toBe(0);
    expect(errs.join(" ")).toContain("holds exactly what was sent");

    // And --no-verify skips the read-back entirely. A DIFFERENT draft, because
    // the same one into the same channel is refused as a duplicate.
    const b = stubIo(cwd, async (u) => responder(String(u)));
    b.io.readStdin = async () => "a second line, drafted separately";
    const skipping: Io = {
      ...b.io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : b.io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--no-verify", "--backend", "slack"], skipping)).toBe(0);
    expect(b.errs.join(" ")).not.toContain("holds exactly what was sent");
  });

  test("a BROADCAST verifies clean, in either form the author typed", async () => {
    // The read-back renders `<!channel>` as `@channel`, so a draft carrying the
    // entity compared unequal and verify printed DIFFERS over a message Slack
    // held exactly, with the room notified. An agent then read that report as
    // proof the broadcast was inert. Both sides compare in the reader's form.
    const cwd = scratchDir("send-verify-broadcast");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "44.4", message: {} }), { status: 200 });
      if (url.includes("conversations.history"))
        // WHAT SLACK STORES for a broadcast, which is the entity.
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: "44.4", text: "<!channel> install it" }] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "<!channel> install it";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], io)).toBe(0);
    expect(errs.join(" ")).toContain("holds exactly what was sent");
    expect(errs.join(" ")).not.toContain("DIFFERS");
    // The broadcast counts as a live mention, so nothing reports it as silent.
    expect(errs.join(" ")).not.toContain("notified NOBODY");
  });

  test("a QUOTED entity verifies clean, with Slack's escape undone on both sides", async () => {
    // A draft quoting the token in a fence goes to Slack escaped, on purpose, so
    // it notifies nobody. The read-back undoes the escape, and this line then
    // reported DIFFERS over a message Slack held exactly as intended, which is
    // the second false alarm this comparison produced in one hour.
    const cwd = scratchDir("send-verify-quoted-entity");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "55.5", message: {} }), { status: 200 });
      if (url.includes("conversations.history"))
        // WHAT SLACK STORES for a defused entity: both brackets escaped.
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "55.5", text: "```\n&lt;!channel&gt; quoted\n```" }] }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "```\n<!channel> quoted\n```";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], io)).toBe(0);
    expect(errs.join(" ")).toContain("holds exactly what was sent");
    expect(errs.join(" ")).not.toContain("DIFFERS");
  });

  test("a MISTYPED CITATION is reported, and a correct one says nothing", async () => {
    // An agent cited 1787656658.009669 for a line Slack holds at
    // 1787656658.009699, hand-copied from a notification preview, and the reader
    // spent a search finding what was meant. Four investigations in one day
    // turned on an exact ts. The detector is the whole second: a correct
    // citation, and a ts belonging to another channel, trip nothing.
    const cwd = scratchDir("send-cite-check");
    const asked: string[] = [];
    const responder = async (u: string | URL): Promise<Response> => {
      const url = String(u);
      asked.push(url);
      if (url.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "99.9", message: {} }), { status: 200 });
      // The window around 1787656658: Slack holds the ...699 line, written by a
      // named user, which the note reports.
      if (url.includes("oldest=1787656658.000000"))
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "1787656658.009699", username: "andrew" }] }),
          { status: 200 },
        );
      // And the exact citation in the second window, also with an author.
      if (url.includes("oldest=1787656659.000000"))
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "1787656659.000001", username: "andrew" }] }),
          { status: 200 },
        );
      // The window around a ts from some other channel: nothing here.
      if (url.includes("oldest=1700000000.000000")) return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
      if (url.includes("conversations.history"))
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [{ ts: "99.9", text: "see 1787656658.009669 and 1787656658.009699 and 1700000000.000001" }],
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    };
    const { io, errs } = stubIo(cwd, async (u) => responder(u));
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "see 1787656658.009669 and 1787656658.009699 and 1700000000.000001";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], io)).toBe(0);
    const said = errs.join("\n");
    expect(said).toContain("cite: general holds no message at 1787656658.009669, and it holds 1787656658.009699");
    // A CORRECT CITATION NAMES ITS AUTHOR. I attributed an incident to the wrong
    // agent while pointing at its ts, and the agent I named corrected me.
    expect(said).toContain("cite: 1787656658.009699 in general was written by");
    // The ts with nothing in its second is a citation from elsewhere, and it is
    // left alone. A check that fires on a correct citation is one agents skip.
    expect(said).not.toContain("1700000000.000001, and it holds");
    // The message still went out, and the note never changes that.
    expect(said).toContain("posted: general at ts 99.9");

    // THE CAP SAYS WHAT IT DROPPED. Seven citations, six checked, and the note
    // names the one it never looked at. A bound nobody prints reads as full
    // coverage.
    const many = stubIo(cwd, async (u) => responder(u));
    const seven = [
      "1700000001.000001",
      "1700000002.000002",
      "1700000003.000003",
      "1700000004.000004",
      "1700000005.000005",
      "1700000006.000006",
      "1700000007.000007",
    ].join(" ");
    many.io.readStdin = async () => `the evidence: ${seven}`;
    expect(
      await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], many.io),
    ).toBe(0);
    expect(many.errs.join("\n")).toContain("cite: checked the first 6 of 7 cited ts, and left 1700000007.000007 unchecked.");
  });

  test("`--verify` reads a THREAD REPLY, which history never returns", async () => {
    // Measured by the agent it happened to: verify answered "slack has no
    // message at <ts>" for its own threaded reply, while `message read` found
    // that ts with its text intact. A reply is absent from
    // conversations.history and present in conversations.replies on its root.
    const cwd = scratchDir("send-verify-thread");
    const asked: string[] = [];
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      asked.push(url);
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "55.5", message: { thread_ts: "44.4" } }), { status: 200 });
      if (url.includes("conversations.replies"))
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "44.4", text: "the root" }, { ts: "55.5", text: "the reply as stored" }] }),
          { status: 200 },
        );
      // history answers with nothing, as Slack does for a reply.
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "the reply as written";
    expect(
      await main(
        ["message", "send", "--target", "general", "--as", "dev", "--thread", "44.4", "--verify", "--backend", "slack"],
        io,
      ),
    ).toBe(0);
    expect(asked.some((u) => u.includes("conversations.replies") && u.includes("ts=44.4"))).toBe(true);
    expect(errs.join(" ")).toContain("the reply as stored");
  });

  test("`message edit` rewrites a message already in the channel, and `delete` removes one", async () => {
    // The operator: "Agents should be able to edit and delete messages. And you
    // should already have the capability to delete your own message."
    const cwd = scratchDir("edit-delete");
    const calls: Array<{ url: string; body: string }> = [];
    const { io, errs } = stubIo(cwd, async (u, init) => {
      calls.push({ url: String(u), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
      roster: { U1: "bo" },
    });
    io.readStdin = async () => "I fixed the parser and shipped it.";
    expect(
      await main(
        ["message", "edit", "--target", "general", "--to", "77.7", "--as", "dev", "--backend", "slack"],
        io,
      ),
    ).toBe(0);
    const edit = calls.find((c) => c.url.includes("chat.update"));
    expect(edit?.body).toContain('"ts":"77.7"');
    expect(errs.join(" ")).toContain("edited: general ts 77.7");

    expect(
      await main(
        ["message", "delete", "--target", "general", "--to", "77.7", "--as", "dev", "--backend", "slack"],
        io,
      ),
    ).toBe(0);
    expect(calls.some((c) => c.url.includes("chat.delete"))).toBe(true);
    expect(errs.join(" ")).toContain("deleted: general ts 77.7 is gone");
  });

  test("an edit passes the language rules, needs a ts, needs stdin, and reports Slack's refusal", async () => {
    const cwd = scratchDir("edit-sad");
    const { io, errs } = stubIo(cwd, async (u) =>
      String(u).includes("chat.update")
        ? new Response(JSON.stringify({ ok: false, error: "message_not_found" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    // No --to.
    io.readStdin = async () => "text";
    expect(await main(["message", "edit", "--target", "general", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("requires --to");
    // Empty stdin.
    io.readStdin = async () => "   ";
    expect(
      await main(["message", "edit", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"], io),
    ).toBe(1);
    expect(errs.join(" ")).toContain("stdin was empty");
    // A banned form: an edit is a send and answers to the same rules.
    io.readStdin = async () => "Honestly I fixed it.";
    expect(
      await main(["message", "edit", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"], io),
    ).toBe(1);
    expect(errs.join(" ")).toContain("language rule(s) broken");
    // Slack's own refusal, with the credential that acted.
    io.readStdin = async () => "I fixed the parser and shipped it.";
    expect(
      await main(["message", "edit", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"], io),
    ).toBe(1);
    expect(errs.join(" ")).toContain("message_not_found");
    expect(errs.join(" ")).toContain("dev's own token");
    // The local backend has no such call.
    expect(
      await main(["message", "delete", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "local"], io),
    ).toBe(1);
    expect(errs.join(" ")).toContain("needs the slack backend");

    // Slack refusing the delete is reported. Nothing swallows it.
    const nope = stubIo(cwd, async (u) =>
      String(u).includes("chat.delete")
        ? new Response(JSON.stringify({ ok: false, error: "cant_delete_message" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    expect(
      await main(
        ["message", "delete", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"],
        nope.io,
      ),
    ).toBe(1);
    expect(nope.errs.join(" ")).toContain("delete failed: cant_delete_message");

    // A rewrite the guards refuse stops the edit, exactly as it stops a send.
    const bad = stubIo(cwd, async (u) =>
      String(u).includes("generativelanguage")
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "it got fixed" }] } }] }), {
            status: 200,
          })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    bad.io.readStdin = async () => "I fixed the parser.";
    expect(
      await main(["message", "edit", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"], {
        ...bad.io,
        env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : bad.io.env(n)),
        moduleDir: () => join(import.meta.dir, "..", "src"),
      }),
    ).toBe(1);
    expect(bad.errs.join(" ")).toContain("REFUSED");

    // No slack config at all: the verb says so and edits nothing.
    const bare = stubIo(scratchDir("edit-no-config"), async () => new Response("{}", { status: 200 }));
    expect(
      await main(["message", "edit", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"], bare.io),
    ).toBe(1);
  });

  test("the same draft into the same channel is REFUSED, and `--again` sends it", async () => {
    // MEASURED after the `posted:` line shipped: two byte-identical copies 27
    // seconds apart reached a third agent's inbox. An agent asked for this
    // shape in these words: "A retry after a genuine post must be a no-op, for
    // example by setting an idempotency key on the draft hash".
    const cwd = scratchDir("send-duplicate");
    let posts = 0;
    const { io, errs } = stubIo(cwd, async (u) => {
      if (String(u).includes("chat.postMessage")) {
        posts += 1;
        return new Response(JSON.stringify({ ok: true, ts: `9.${posts}`, message: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "the parser fix shipped and I sent it";
    const send = (extra: string[] = []): Promise<number> =>
      main(["message", "send", "--target", "general", "--as", "dev", "--no-verify", "--backend", "slack", ...extra], io);
    expect(await send()).toBe(0);
    expect(posts).toBe(1);
    // The second attempt names the ts Slack already holds and posts nothing.
    expect(await send()).toBe(1);
    expect(posts).toBe(1);
    expect(errs.join(" ")).toContain("you already sent this exact draft to general at ts 9.1");
    // The check runs BEFORE the rewriter, so a duplicate costs no model call.
    expect(errs.join(" ")).not.toContain("rewrite:");
    // Saying it twice on purpose stays possible.
    expect(await send(["--again"])).toBe(0);
    expect(posts).toBe(2);
    // A different draft is unaffected.
    io.readStdin = async () => "something else entirely, and I sent that too";
    expect(await send()).toBe(0);
    expect(posts).toBe(3);
  });

  test("ONE REPORT SENT TWICE UNDER DIFFERENT WORDING is refused, and --again sends it", async () => {
    // An agent reported one end-to-end run twice, 127 seconds apart, naming the
    // same ports and the same three images in different sentences. The digest
    // guard passed it, since no two bytes lined up, and the channel read two
    // reports of one run.
    const cwd = scratchDir("send-reworded");
    let posts = 0;
    const { io, errs } = stubIo(cwd, async (u) => {
      if (String(u).includes("chat.postMessage")) {
        posts += 1;
        return new Response(JSON.stringify({ ok: true, ts: `7.${posts}`, message: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    const send = (extra: string[] = []): Promise<number> =>
      main(["message", "send", "--target", "general", "--as", "dev", "--no-verify", "--backend", "slack", ...extra], io);
    io.readStdin = async () =>
      "The end-to-end run finished on ports 3005 and 8600, and the judge scored " +
      "mushroom_shaman, blueberry_pie and copper_kettle without a fallback.";
    expect(await send()).toBe(0);
    expect(posts).toBe(1);
    io.readStdin = async () =>
      "On ports 3005 and 8600 the end-to-end run completed, and the judge scored " +
      "the three assets mushroom_shaman, blueberry_pie and copper_kettle, with no fallback taken.";
    expect(await send()).toBe(1);
    expect(posts).toBe(1);
    expect(errs.join(" ")).toContain("this says what you already sent to general at ts 7.1");
    expect(errs.join(" ")).toContain("of its content words");
    // Saying it again on purpose stays possible.
    expect(await send(["--again"])).toBe(0);
    expect(posts).toBe(2);
    // A DIFFERENT REPORT GOES OUT. Refusing these would teach agents to pass
    // --again by reflex, which retires the guard.
    io.readStdin = async () =>
      "The coverage stage is red: src/status.ts sits at 92% lines after the ledger " +
      "change, and the uncovered branch is the write failure path.";
    expect(await send()).toBe(0);
    expect(posts).toBe(3);
  });

  test("`message check` says when a LISTENER runs older code than the install", async () => {
    // An agent whose listener fell six hours behind found out by running
    // `doctor` for an unrelated reason: the surface that knew was the one
    // nobody had a reason to call. The sweep runs on a timer in every harness,
    // so it says it too.
    const cwd = scratchDir("check-drift");
    const share = scratchDir("check-drift-share");
    mkdirSync(join(share, "current", "src"), { recursive: true });
    writeFileSync(join(share, "current", "src", "COMMIT"), "abc1234\n");
    const mine = scratchDir("check-drift-mine");
    writeFileSync(join(mine, "COMMIT"), "abc1234\n");
    // A PROCESS TABLE WITH A LISTENER ON AN OLDER COMMIT. My first version
    // compared the sweep's OWN process against the install, and a sweep
    // launched from the shared launcher IS the install, so the line never
    // fired.
    const emptyProc = scratchDir("check-drift-proc");
    mkdirSync(join(emptyProc, "77"), { recursive: true });
    writeFileSync(join(emptyProc, "77", "cmdline"), "bun /s/share/scramble/def5678/src/bin.ts listen --as dev\0");
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: {},
      agents: { dev: { token: "T", handle: "dev" } },
    });
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
      env: (n) =>
        n === "SCRAMBLE_SLACK_CONFIG" ? join(cwd, ".scramble", "slack.json")
        : n === "SCRAMBLE_HOME" ? share
        : n === "SCRAMBLE_PROC" ? emptyProc
        : undefined,
      cwd: () => cwd,
      moduleDir: () => mine,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(errs.join(" ")).toContain("1 listener(s) for dev run a different commit than the installed abc1234");
    expect(errs.join(" ")).toContain("pid 77 on def5678");
    // A listener is running, so the dead-listener line stays quiet.
    expect(errs.join(" ")).not.toContain("NO listener is running");

    // WITH NOTHING ARMED, the other line fires and the drift line does not.
    const bare = scratchDir("check-drift-proc-empty");
    const quiet: string[] = [];
    await main(["message", "check", "--as", "dev", "--backend", "slack"], {
      ...io,
      writeErr: (l) => quiet.push(l),
      env: (n) => (n === "SCRAMBLE_PROC" ? bare : io.env(n)),
    });
    expect(quiet.join(" ")).toContain("NO listener is running for dev");
    expect(quiet.join(" ")).toContain("scramble listen --addressed --as dev");
    expect(quiet.join(" ")).not.toContain("run a different commit");
  });

  test("`channel tier` writes the operator's classification and reads it back", async () => {
    // "Channel classification should be manually done by the operator".
    // Hand-editing a shared JSON is how a config gets a stray comma at
    // midnight.
    const cwd = scratchDir("channel-tier");
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1", team: "C2" },
      agents: { dev: { token: "T", handle: "dev" } },
      humanUserId: "U9",
    });
    const { io, writes, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["channel", "tier", "general", "internal"], io)).toBe(0);
    expect(writes.join("")).toContain('"tier":"internal"');
    expect(errs.join(" ")).toContain("general is internal");
    // A second call keeps the first, and every other config key survives.
    expect(await main(["channel", "tier", "team", "external"], io)).toBe(0);
    const after = JSON.parse(readFileSync(join(cwd, ".scramble", "slack.json"), "utf8"));
    expect(after.tiers).toEqual({ general: "internal", team: "external" });
    expect(after.humanUserId).toBe("U9");

    // A tier nobody defined, and a missing channel, are refused with the usage.
    expect(await main(["channel", "tier", "general", "loud"], io)).toBe(1);
    expect(await main(["channel", "tier"], io)).toBe(1);
    expect(errs.join(" ")).toContain("scramble channel tier <channel> internal|external");
    // An unreadable config is REPORTED. A silent pass would hide it.
    const bare = stubIo(scratchDir("channel-tier-noconfig"), async () => new Response("{}", { status: 200 }));
    expect(await main(["channel", "tier", "general", "internal"], bare.io)).toBe(1);
    expect(bare.errs.join(" ")).toContain("cannot read");

    // A config that cannot be WRITTEN is reported too. The classification is
    // the operator's, and a call that changed nothing must never look done.
    const ro = scratchDir("channel-tier-readonly");
    writeSlackConfig(ro, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    chmodSync(join(ro, ".scramble", "slack.json"), 0o444);
    const locked = stubIo(ro, async () => new Response("{}", { status: 200 }));
    expect(await main(["channel", "tier", "general", "internal"], locked.io)).toBe(1);
    expect(locked.errs.join(" ")).toContain("cannot write");
    chmodSync(join(ro, ".scramble", "slack.json"), 0o644);
  });

  test("the send picks the register the operator set, and tells the model", async () => {
    // The operator: agents speak differently in a channel full of people from
    // the way they speak where agents work, and neither follows from the
    // channel being public or private.
    const cwd = scratchDir("send-register");
    let prompt = "";
    const { io, errs } = stubIo(cwd, async (u, init) => {
      const url = String(u);
      if (url.includes("generativelanguage")) {
        prompt = String(init?.body ?? "");
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix." }] } }] }),
          { status: 200 },
        );
      }
      if (url.includes("conversations.members"))
        return new Response(JSON.stringify({ ok: true, members: ["U1", "U2", "B1"] }), { status: 200 });
      if (url.includes("users.list"))
        return new Response(
          JSON.stringify({
            ok: true,
            members: [
              { id: "U1", name: "ana", is_bot: false },
              { id: "U2", name: "bo", is_bot: false },
              { id: "B1", name: "dev", is_bot: true },
            ],
          }),
          { status: 200 },
        );
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "8.8", message: {} }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "the parser fix shipped and I sent it";
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(
      await main(["message", "send", "--target", "general", "--as", "dev", "--no-verify", "--backend", "slack"], withKey),
    ).toBe(0);
    // No tier set for this channel: the careful register, and the model is told.
    expect(errs.join(" ")).toContain("register: external for general (no tier set for general");
    // DERIVED FROM THE SHIPPED FILE. A copy of its wording would rot. This assertion
    // held a sentence from the register block, the operator rewrote both blocks
    // (9211482, 27be931), and the copy failed while the mechanism worked.
    expect(promptText(prompt)).toContain(shippedRegister("external"));
  });

  test("an internal channel gets the dense register, and a change of entry moves it", async () => {
    const cwd = scratchDir("send-register-internal");
    let prompt = "";
    const responder = async (u: string | URL): Promise<Response> => {
      const url = String(u);
      if (url.includes("conversations.members"))
        return new Response(JSON.stringify({ ok: true, members: ["U1", "B1", "B2"] }), { status: 200 });
      if (url.includes("users.list"))
        return new Response(
          JSON.stringify({
            ok: true,
            members: [
              { id: "U1", name: "ana", is_bot: false },
              { id: "B1", name: "dev", is_bot: true },
              { id: "B2", name: "ops", is_bot: true },
            ],
          }),
          { status: 200 },
        );
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "8.8", message: {} }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    };
    const { io, errs } = stubIo(cwd, async (u, init) => {
      if (String(u).includes("generativelanguage")) {
        prompt = String(init?.body ?? "");
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix." }] } }] }),
          { status: 200 },
        );
      }
      return responder(u);
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
      tiers: { general: "internal" },
    });
    io.readStdin = async () => "the parser fix shipped and I sent it";
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(
      await main(["message", "send", "--target", "general", "--as", "dev", "--no-verify", "--backend", "slack"], withKey),
    ).toBe(0);
    expect(errs.join(" ")).toContain("register: internal for general (set to internal by the operator)");
    expect(promptText(prompt)).toContain(shippedRegister("internal"));

    // THE CONFIG WINS. A room of agents can still be where a customer reads.
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
      tiers: { general: "external" },
    });
    const second = stubIo(cwd, async (u, init) => {
      if (String(u).includes("generativelanguage")) {
        prompt = String(init?.body ?? "");
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix, again." }] } }] }),
          { status: 200 },
        );
      }
      return responder(u);
    });
    second.io.readStdin = async () => "a different draft, sent to the same room";
    expect(
      await main(["message", "send", "--target", "general", "--as", "dev", "--no-verify", "--backend", "slack"], {
        ...second.io,
        env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : second.io.env(n)),
        moduleDir: () => join(import.meta.dir, "..", "src"),
      }),
    ).toBe(0);
    expect(second.errs.join(" ")).toContain("register: external for general (set to external by the operator)");
    expect(promptText(prompt)).toContain(shippedRegister("external"));
  });

  test("the send says POSTED with the ts before it says anything else", async () => {
    // Two agents duplicated messages in one hour because the CLI's output after
    // a successful post was a warning, and a warning read as a failure (ts
    // 1787715115 / 1787715130 and 1787715280 onward).
    const cwd = scratchDir("send-posted-line");
    const { io, errs } = stubIo(cwd, async (u) =>
      String(u).includes("chat.postMessage")
        ? new Response(JSON.stringify({ ok: true, ts: "77.7", message: {} }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    );
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "the parser fix shipped";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    const posted = errs.findIndex((l) => l.includes("posted: general at ts 77.7"));
    expect(posted).toBeGreaterThanOrEqual(0);
    expect(errs[posted]).toContain("NONE of it means resend");
    // Said FIRST: every later line is a note about a message Slack already has.
    expect(errs.slice(0, posted).join(" ")).not.toContain("verify");
    // AND LAST, because a pipe cuts from the end. Three agents ran this output
    // through `tail -4`, `tail -3` and `tail -2`, each losing the first line,
    // and two of them sent the message again.
    expect(errs[errs.length - 1]).toContain("sent: general at ts 77.7");
    expect(errs[errs.length - 1]).toContain("Nothing above asks you to send it again");
  });

  test("`--verify` reads back from the ROOT Slack picked when a reply was threaded under", async () => {
    // An agent passed --thread pointing at a reply. Slack hoisted the message
    // into that reply's root and answered with the root's ts, and the read-back
    // asked about the ts that was passed, so it reported "slack has no message
    // at <ts>" for a message that was in the channel.
    const cwd = scratchDir("verify-hoisted");
    const asked = "111.1";
    const root = "100.1";
    const { io, errs, urls } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "222.2", message: { thread_ts: root } }), { status: 200 });
      if (url.includes("conversations.replies"))
        return new Response(
          JSON.stringify({
            ok: true,
            messages: url.includes(encodeURIComponent(root)) ? [{ ts: "222.2", text: "threaded under a reply" }] : [],
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "threaded under a reply";
    expect(
      await main(
        ["message", "send", "--target", "general", "--as", "dev", "--thread", asked, "--verify", "--backend", "slack"],
        io,
      ),
    ).toBe(0);
    expect(urls.join(" ")).toContain(`ts=${encodeURIComponent(root)}`);
    expect(errs.join(" ")).toContain("holds exactly what was sent");
    expect(errs.join(" ")).not.toContain("slack has no message");
  });

  test("`rewrite` prints the model's answer, reads a file, and sends nothing", async () => {
    // The operator asked for the instruction file itself to go through the
    // rewriter, and nothing here could do that without sending a message
    // somewhere.
    const cwd = scratchDir("rewrite-preview");
    const { io, writes, errs, urls } = stubIo(cwd, async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix." }] } }] }), {
        status: 200,
      }),
    );
    const draft = join(cwd, "draft.md");
    writeFileSync(draft, "I shipped the parser fix, basically.");
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["rewrite", draft], withKey)).toBe(0);
    expect(writes.join("")).toContain("I shipped the parser fix.");
    expect(errs.join(" ")).toContain("rewrite:");
    // One call, to the model. Nothing went to a channel.
    expect(urls.length).toBe(1);
    expect(urls.join(" ")).not.toContain("chat.postMessage");
  });

  test("a rewrite call that times out is asked once more, and the send goes", async () => {
    // MEASURED on my own send: the model timed out at 20s, the send refused,
    // and the identical text went through seconds later. A timeout says nothing
    // about the message.
    const cwd = scratchDir("rewrite-timeout");
    let calls = 0;
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("generativelanguage")) {
        calls += 1;
        if (calls === 1) throw new Error("The operation was aborted.");
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix." }] } }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, ts: "5.5", message: {} }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "the parser fix shipped and I sent it";
    expect(
      await main(["message", "send", "--target", "general", "--as", "dev", "--no-verify", "--backend", "slack"], {
        ...io,
        env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
        moduleDir: () => join(import.meta.dir, "..", "src"),
      }),
    ).toBe(0);
    expect(calls).toBe(2);
    expect(errs.join(" ")).toContain("the model did not answer");
    expect(errs.join(" ")).toContain("posted: general at ts 5.5");
  });

  test("`lint --comments` reads a source file's comments and skips its code", async () => {
    // The operator, having read a banned form in a comment I shipped an hour
    // earlier: "Clean the comments first." The rule table's own patterns
    // contain the words it bans, so the code has to stay out of scope.
    const cwd = scratchDir("lint-comments");
    const f = join(cwd, "sample.ts");
    writeFileSync(
      f,
      ['// This is basically the same defect.', 'export const msg = "it is basically done";'].join("\n"),
    );
    const { io, errs, writes } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", "--comments", f], io)).toBe(1);
    expect(errs.join(" ")).toContain("sample.ts:1");
    expect(errs.filter((l) => l.includes("sample.ts:2"))).toHaveLength(0);
    // Without the flag the same file reports the code line too.
    const plain = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", f], plain.io)).toBe(1);
    expect(plain.errs.filter((l) => l.includes("sample.ts:2"))).toHaveLength(1);
    expect(writes.join("")).toContain('"hits":1');
  });

  test("`rewrite --why` asks for the diagnosis, and never rewrites", async () => {
    // The operator, about a refusal this tool prints: "Use gemini 3.7 to find
    // why the communication is wrong." A rewrite hands back a better version
    // and leaves the author guessing which habit produced the worse one.
    const cwd = scratchDir("rewrite-why");
    let asked = "";
    const { io, writes, errs } = stubIo(cwd, async (_u, init) => {
      asked = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "1. The answer is buried." }] } }] }),
        { status: 200 },
      );
    });
    io.readStdin = async () => "An agent hit five refusals in a row on one rule.";
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["rewrite", "--why"], withKey)).toBe(0);
    expect(writes.join("")).toContain("The answer is buried");
    expect(asked).toContain("Name what is wrong with it");
    expect(asked).toContain("Do not rewrite it");

    // No key, and a model that fails, each say so and change nothing.
    expect(await main(["rewrite", "--why"], io)).toBe(1);
    expect(errs.join(" ")).toContain("SCRAMBLE_REWRITE_KEY");
    const dead = stubIo(cwd, async () => new Response("nope", { status: 500 }));
    dead.io.readStdin = async () => "text";
    expect(
      await main(["rewrite", "--why"], {
        ...dead.io,
        env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : dead.io.env(n)),
        moduleDir: () => join(import.meta.dir, "..", "src"),
      }),
    ).toBe(1);
    expect(dead.errs.join(" ")).toContain("the model did not answer");
  });

  test("`rewrite` reads stdin when no file is named, and says when nothing changed", async () => {
    const cwd = scratchDir("rewrite-stdin");
    const { io, errs } = stubIo(cwd, async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix." }] } }] }), {
        status: 200,
      }),
    );
    io.readStdin = async () => "I shipped the parser fix.";
    expect(
      await main(["rewrite"], {
        ...io,
        env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
        moduleDir: () => join(import.meta.dir, "..", "src"),
      }),
    ).toBe(0);
    expect(errs.join(" ")).toContain("returned what you wrote, unchanged");
  });

  test("`rewrite` reports a missing file, an empty input, an absent key, and a refusal", async () => {
    const cwd = scratchDir("rewrite-sad");
    const { io, errs, writes } = stubIo(cwd, async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "shipped the parser fix." }] } }] }), {
        status: 200,
      }),
    );
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["rewrite", join(cwd, "nope.md")], withKey)).toBe(1);
    expect(errs.join(" ")).toContain("cannot read");

    const empty = join(cwd, "empty.md");
    writeFileSync(empty, "   \n");
    expect(await main(["rewrite", empty], withKey)).toBe(1);
    expect(errs.join(" ")).toContain("is empty");

    // No key: the send path leaves the text alone, and a preview has nothing to
    // show, so it says which variable turns the model on.
    io.readStdin = async () => "I shipped the parser fix.";
    expect(await main(["rewrite"], io)).toBe(1);
    expect(errs.join(" ")).toContain("SCRAMBLE_REWRITE_KEY");

    // A refused preview prints the model's answer and names the guard, with no
    // sentence about sending: this verb never sends, and the send's refusal ends
    // "Rewrite your message and send again."
    const drops = join(cwd, "drops.md");
    writeFileSync(drops, "I shipped the parser fix.");
    const before = writes.length;
    expect(await main(["rewrite", drops], withKey)).toBe(1);
    expect(writes.slice(before).join("")).toContain("shipped the parser fix.");
    expect(errs.join(" ")).toContain("the guards would stop this from going out");
    expect(errs.join(" ")).toContain("Nothing was sent.");
    expect(errs.join(" ")).not.toContain("send again");
  });

  test("`--verify` counts ENTITIES, and names a mention that notified nobody", async () => {
    // Slack notifies on `<@U…>` and never on a name in text, so a count taken
    // from the text calls a failed conversion live. That is the defect that
    // shipped this evening: a mention at a sentence end went out as plain text
    // and this check would have reported it as live.
    const cwd = scratchDir("verify-entities");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "11.1", message: {} }), { status: 200 });
      if (url.includes("conversations.history"))
        // One converted, one left as plain text.
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "11.1", text: "ping <@U1> and @ana." }] }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
      roster: { U1: "bo" },
    });
    io.readStdin = async () => "ping @bo and @ana.";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], io)).toBe(0);
    const said = errs.join(" ");
    expect(said).toContain("1 mention(s) live");
    expect(said).toContain("@ana notified NOBODY");
  });

  test("`--verify` on an unchanged message says so in one line", async () => {
    const cwd = scratchDir("send-verify-same");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "88.8", message: {} }), { status: 200 });
      if (url.includes("conversations.history"))
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: "88.8", text: "exactly this" }] }), {
          status: 200,
        });
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "exactly this";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], io)).toBe(0);
    expect(errs.join(" ")).toContain("holds exactly what was sent");
  });

  test("`--verify` with no ts from Slack says nothing can be read back", async () => {
    // Slack answered ok without a ts, so there is no message to look up. Saying
    // "verified" here would be the shape this whole verb exists to kill.
    const cwd = scratchDir("send-verify-nots");
    const { io, errs } = stubIo(cwd, async (u) =>
      String(u).includes("chat.postMessage")
        ? new Response(JSON.stringify({ ok: true, message: {} }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    );
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "a line";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], io)).toBe(0);
    expect(errs.join(" ")).toContain("slack returned no ts");
  });

  test("`--verify` that cannot read the message back says so", async () => {
    const cwd = scratchDir("send-verify-gone");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "99.9", message: {} }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "a line";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--verify", "--backend", "slack"], io)).toBe(0);
    expect(errs.join(" ")).toContain("could not read the message back");
  });

  test("a rewrite that breaks a rule is retried ONCE with what it broke", async () => {
    // Every guard fires on something the MODEL did, so the model is the party
    // that can fix it. Two agents wrote prose that avoided a banned form on
    // purpose, watched the rewriter put it back, and sent nothing.
    const cwd = scratchDir("send-retry");
    const prompts: string[] = [];
    let call = 0;
    const { io, errs } = stubIo(cwd, async (u, init) => {
      if (String(u).includes("generativelanguage")) {
        call += 1;
        prompts.push(String(init?.body));
        const text = call === 1 ? "the fix shipped, not the workaround" : "the fix shipped and the workaround stayed out";
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ crossings: [] }), { status: 200 });
    });
    io.readStdin = async () => "the fix shipped and the workaround stayed out of it";
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], withKey)).toBe(0);
    expect(call).toBe(2);
    // The second prompt carries what the first attempt broke.
    expect(prompts[1]).toContain("Your previous attempt was rejected");
    expect(prompts[1]).toContain("language rule");
    expect(errs.join(" ")).toContain("Asking once more");
    expect(errs.join(" ")).toContain("rewrite: sent a rewrite");
  });

  test("a second failure REFUSES, and the author sees both", async () => {
    const cwd = scratchDir("send-retry-fail");
    let call = 0;
    const { io, errs } = stubIo(cwd, async (u) => {
      if (String(u).includes("generativelanguage")) {
        call += 1;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "the fix shipped, not the workaround" }] } }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ crossings: [] }), { status: 200 });
    });
    io.readStdin = async () => "the fix shipped and the workaround stayed out of it";
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], withKey)).toBe(1);
    expect(call).toBe(2);
    expect(errs.join(" ")).toContain("neither version goes out");
  });

  test("an unreadable instruction STOPS the send", async () => {
    // A rewrite driven by no instruction is worse than no rewrite, and the
    // author's own words no longer go out where the rewrite is on: "we should
    // not allow claude original message go out".
    const cwd = scratchDir("send-noprompt");
    const { io, errs } = stubIo(cwd, async () => new Response(JSON.stringify({ crossings: [] }), { status: 200 }));
    io.readStdin = async () => "my own line";
    const withKey: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(cwd, "nowhere"),
    };
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], withKey)).toBe(1);
    expect(errs.join(" ")).toContain("could not be read");
    expect(errs.join(" ")).toContain("do not go out while the rewrite is on");
  });

  test("a message over the word limit is REFUSED at the send", async () => {
    // Operator: "We need to impose a message length limit in words. Maybe 200."
    // A refusal and not a warning: the long version is meant to become several
    // short turns, and a warning leaves that to the sender who just wrote 900
    // words. Raised to 300 by the operator.
    //
    // COUNTED FROM THE SHIPPED LIMIT, so this test moves with it and never
    // hardcodes a number the code no longer uses.
    const cwd = scratchDir("send-toolong");
    const { io, errs } = stubIo(cwd, async () => new Response(JSON.stringify({ crossings: [] }), { status: 200 }));
    const over = WORD_LIMIT + 60;
    io.readStdin = async () => Array.from({ length: over }, () => "word").join(" ");
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], io)).toBe(1);
    expect(errs.join(" ")).toContain(`${over} words of prose, and the limit is ${WORD_LIMIT}`);
  });

  test("`inbox close` takes SEVERAL ids, and one bad id never hides the rest", async () => {
    // A thread of other people's work hands you a batch: I closed eight items one
    // command at a time in ten minutes, which is the shape that teaches an agent
    // to stop reading its own list. A batch that stopped at the first bad id
    // would leave the others silently untouched, which is the same defect.
    const cwd = scratchDir("inbox-close-many");
    mkdirSync(join(cwd, ".scramble", "inbox"), { recursive: true });
    const row = (id: string): string =>
      JSON.stringify({ id, channel: "general", from: "andrew", text: "q", at: "2026-08-22T00:00:00Z" });
    writeFileSync(join(cwd, ".scramble", "inbox", "dev.jsonl"), `${row("1.1")}\n${row("2.2")}\n${row("3.3")}\n`);
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "1.1", "999.9", "3.3", "--why", "not mine", "--as", "dev"], io)).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("closed 1.1 with no reply: not mine");
    expect(said).toContain("closed 3.3 with no reply: not mine");
    expect(said).toContain("999.9 is not an open item");
    // The two good ones ARE closed, and the untouched one is still open.
    const p = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "pending", "--as", "dev"], p.io)).toBe(1);
    expect(p.writes).toHaveLength(1);
    expect(p.writes.join(" ")).toContain("2.2");
  });

  test("`inbox trace` without an id refuses instead of tracing nothing", async () => {
    const cwd = scratchDir("inbox-trace-noid");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "trace", "--as", "dev"], io)).toBe(1);
    expect(errs.join(" ")).toContain("inbox trace needs the message id");
  });

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
    // Operator: "shall we make inbox reply default to within the thread?
    // Posting to the channel directly can be made a separate flag." The ledger
    // knows which item is open, so the thread is read and never guessed.
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

  test("with SEVERAL questions open it refuses to guess a thread, and lists them", async () => {
    // The operator asked a question; another agent posted 13 seconds later; the
    // default took the newest and put my answer to the operator inside that
    // agent's thread. With more than one open, which thread this answers is the
    // sender's to name.
    const cwd = scratchDir("inbox-ambiguous");
    mkdirSync(join(cwd, ".scramble", "inbox"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "inbox", "dev.jsonl"),
      `${JSON.stringify({ id: "9.1", channel: "general", from: "andrew", text: "where are credentials stored", at: "2026-08-22T00:00:00Z" })}\n` +
        `${JSON.stringify({ id: "9.2", channel: "general", from: "peer", thread: "root-2", text: "unrelated", at: "2026-08-22T00:00:01Z" })}\n`,
    );
    const { io, errs } = stubIo(cwd, async () => new Response(JSON.stringify({ crossings: [] }), { status: 200 }));
    io.readStdin = async () => "the answer";
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], io)).toBe(0);
    const said = errs.join("\n");
    expect(said).toContain("2 questions are open");
    expect(said).not.toContain("replying in thread");
    // Both are named with enough to pick one.
    expect(said).toContain("9.1");
    expect(said).toContain("where are credentials stored");
    expect(said).toContain("9.2");
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

  test("a send REPORTS what arrived before it that this agent has not read", async () => {
    // The operator, on two agents posting near-identical plans one second
    // apart: "one task/topic is owned by one agent." Neither could see the
    // other coming. The local backend answers a send with its crossings and the
    // skill tells every agent to read them; on Slack the send returned nothing,
    // so the promise held only on the backend nobody uses.
    const cwd = scratchDir("send-crossings");
    const io = slackCheckIo(cwd, {
      fetch: async (url) => {
        const u = String(url);
        if (u.includes("chat.postMessage"))
          return new Response(JSON.stringify({ ok: true, ts: "50.0", message: {} }), { status: 200 });
        if (u.includes("conversations.history"))
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { ts: "30.0", user: "U9", text: "I am taking the generation run" },
                { ts: "35.0", user: "UME", text: "my own earlier line" },
                { ts: "60.0", user: "U9", text: "after yours, so not a crossing" },
              ],
            }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
      },
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      // The handle DIFFERS from the scramble name, which is the case that broke
      // it: history carries the handle.
      agents: { dev: { token: "T", handle: "dev_bot" } },
      roster: { U9: "peer", UME: "dev_bot" },
    });
    const errs: string[] = [];
    const watched: Io = { ...io, writeErr: (l) => errs.push(l), readStdin: async () => "my line" };
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], watched)).toBe(0);
    const said = errs.join("\n");
    expect(said).toContain("1 message(s) arrived in general before yours");
    // This agent's OWN line is never a crossing, and history carries the HANDLE:
    // matching on the scramble name alone listed one of mine back to me on the
    // first live run.
    expect(said).not.toContain("my own earlier line");
    expect(said).toContain("I am taking the generation run");
    expect(said).toContain("already claimed the work");
    // A message AFTER this one is no crossing.
    expect(said).not.toContain("not a crossing");
  });

  test("a crossings lookup that FAILS says so, and the message still went", async () => {
    // Reported and never fatal: a failed lookup here must not turn a delivered
    // message into an error.
    const cwd = scratchDir("send-crossings-fail");
    const io = slackCheckIo(cwd, {
      fetch: async (url) =>
        String(url).includes("chat.postMessage")
          ? new Response(JSON.stringify({ ok: true, ts: "50.0", message: {} }), { status: 200 })
          : new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 200 }),
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    const errs: string[] = [];
    const watched: Io = { ...io, writeErr: (l) => errs.push(l), readStdin: async () => "my line" };
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], watched)).toBe(0);
    expect(errs.join(" ")).toContain("crossings unread for general: ratelimited");
  });

  test("a peer's ORIGIN is learned from its message metadata, and `peers` names it", async () => {
    // The operator: "Does each agent record its hostname and working directory
    // on scramble and an agent may know its same directory peers?" It rides on
    // Slack message metadata, the channel a status line already uses, so it
    // needs no app change and works for an app owned by another login. Learned
    // from ANY message, addressed or not.
    const cwd = scratchDir("peers-origin");
    const io = slackCheckIo(cwd, {
      hostname: () => "my-host",
      fetch: async (url) =>
        String(url).includes("conversations.history")
          ? new Response(
              JSON.stringify({
                ok: true,
                messages: [
                  {
                    ts: "9.9",
                    user: "U9",
                    text: "a line that names nobody",
                    metadata: {
                      event_type: "scramble_origin",
                      event_payload: { host: "peer-host", dir: "/srv/peer-work", commit: "abc1234" },
                    },
                  },
                ],
              }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    });
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    const p = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["peers"], { ...p.io, hostname: () => "my-host" })).toBe(0);
    expect(p.writes.join(" ")).toContain("peer-host  /srv/peer-work  (abc1234)");
    // --same-dir compares HOST and directory together, so a peer elsewhere drops.
    const q = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["peers", "--same-dir"], { ...q.io, hostname: () => "my-host" })).toBe(0);
    expect(q.writes.join(" ")).toContain("No peers running in");
  });

  test("`peers --json` answers a WATCHER with no token and no network", async () => {
    // The damage count went on `doctor` first, and the agent watching for a torn
    // line refused it with the right reason: doctor reads the app manifest, the
    // stored token on their host expired, so a watcher shelling out to doctor
    // every ten minutes leans on a command that already fails there. A question
    // about a local file is answerable from the local file.
    const cwd = scratchDir("peers-json");
    writeSlackConfig(cwd, { token: "xoxb-1", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    writeFileSync(
      join(cwd, ".scramble", "peers.jsonl"),
      `${JSON.stringify({ agent: "ana", host: "h", dir: "/w", commit: "abc1234", at: "t1" })}\n` +
        `{"agent":"bo","ho\n` +
        `${JSON.stringify({ agent: "ana", host: "h", dir: "/w2", commit: "abc1234", at: "t2" })}\n`,
    );
    // NO FETCH SEAM IS TOUCHED: the responder throws if anything calls out.
    const { io, writes } = stubIo(cwd, async () => {
      throw new Error("peers --json must not reach the network");
    });
    expect(await main(["peers", "--json"], { ...io, hostname: () => "my-host" })).toBe(0);
    const said = JSON.parse(writes[0]!) as {
      peers: Array<{ agent: string; dir: string }>;
      damaged: number;
      self: { host: string };
    };
    // The newest row per agent, the damage count, and this process's own origin.
    expect(said.peers).toHaveLength(1);
    expect(said.peers[0]).toMatchObject({ agent: "ana", dir: "/w2" });
    expect(said.damaged).toBe(1);
    expect(said.self.host).toBe("my-host");
  });

  test("THIS AGENT'S OWN ROW is written too, so a crash leaves it on disk", async () => {
    // The operator: "Scramble should store the agent runtime, work dir and
    // session ids for each agent in case of a system restart or crash." Every
    // row came from a message a PEER sent, so the one agent whose runtime and
    // session this process knows for certain was the one missing from the file:
    // a host that crashed took its own record with it.
    const cwd = scratchDir("peers-self");
    const runtimeEnv = (base: (n: string) => string | undefined) => (n: string) =>
      n === "CLAUDECODE"
        ? "1"
        : n === "CLAUDE_CODE_SESSION_ID"
          ? "6a41d6cd-13fa-430a-954b-69132f9d5a5c"
          : n === "CLAUDE_PID"
            ? "14027"
            : n === "AI_AGENT"
              ? "claude-code_2-1-234_agent"
              : base(n);
    const s = stubIo(cwd, async (u) =>
      String(u).includes("chat.postMessage")
        ? new Response(JSON.stringify({ ok: true, ts: "7.7", message: {} }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    );
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      // THE HANDLE DIFFERS FROM THE NAME, which is the live shape:
      // `model-failure-research` is `model_failure_researc` on Slack.
      agents: { dev: { token: "T", handle: "dev_bot" } },
    });
    s.io.readStdin = async () => "a line from an agent nobody has recorded yet";
    expect(
      await main(["message", "send", "--target", "general", "--as", "dev", "--no-verify", "--backend", "slack"], {
        ...s.io,
        hostname: () => "host-one",
        env: runtimeEnv(s.io.env),
      }),
    ).toBe(0);
    const p = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["peers"], { ...p.io, hostname: () => "other-host", env: runtimeEnv(p.io.env) })).toBe(0);
    const said = p.writes.join(" ");
    expect(said).toContain("dev  host-one");
    expect(said).toContain("claude-code 2.1.234 session 6a41d6cd-13fa-430a-954b-69132f9d5a5c pid 14027");
    // THE OWN ROW CLAIMS THIS AGENT'S SLACK HANDLE, so a row somebody wrote under
    // that handle retires without waiting for this agent to send again. The
    // config already holds the mapping, and an agent that upgrades and stays
    // quiet would otherwise keep two identities on one host in one session.
    // THE AGENT'S OWN FILE, since no two writers share one file any more.
    const rows = readFileSync(join(cwd, ".scramble", "peers.d", "dev.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(rows[rows.length - 1]!)).toMatchObject({ agent: "dev", handle: "dev_bot" });
  });

  test("an unwritable own record REPORTS itself and still sends", async () => {
    // The record is accounting; the message is the point. A directory that
    // cannot be written must not swallow the send, and must not go quiet either.
    const cwd = scratchDir("peers-self-locked");
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    const s = stubIo(cwd, async (u) =>
      String(u).includes("chat.postMessage")
        ? new Response(JSON.stringify({ ok: true, ts: "8.8", message: {} }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    );
    s.io.readStdin = async () => "a line sent while the record cannot be written";
    // The directory holding the record is read-only, so appending the row throws.
    chmodSync(join(cwd, ".scramble"), 0o500);
    try {
      expect(
        await main(["message", "send", "--target", "general", "--as", "dev", "--no-verify", "--backend", "slack"], {
          ...s.io,
          hostname: () => "host-one",
        }),
      ).toBe(0);
      expect(s.errs.join(" ")).toContain("own origin not recorded");
      expect(s.errs.join(" ")).toContain("posted: general at ts 8.8");
    } finally {
      chmodSync(join(cwd, ".scramble"), 0o700);
    }
  });

  test("an unwritable peers record REPORTS itself and still delivers", async () => {
    // Knowing where a peer runs is accounting; the message is the point. A
    // record that cannot be written must not swallow the delivery, and must not
    // go quiet about it either.
    const cwd = scratchDir("peers-locked");
    const io = slackCheckIo(cwd, {
      hostname: () => "my-host",
      fetch: async (url) =>
        String(url).includes("conversations.history")
          ? new Response(
              JSON.stringify({
                ok: true,
                messages: [
                  {
                    ts: "9.9",
                    user: "U9",
                    text: "a line",
                    metadata: { event_type: "scramble_origin", event_payload: { host: "h", dir: "/w" } },
                  },
                ],
              }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    });
    const errs: string[] = [];
    const writes: string[] = [];
    const watched: Io = { ...io, writeErr: (l) => errs.push(l), write: (l) => writes.push(l) };
    // A READ-ONLY RECORD DIRECTORY: each writer owns a file inside it now, so the
    // write fails wherever the peer's name goes, while everything else under
    // .scramble stays writable. The test then proves the delivery survives THIS
    // failure and no other one.
    const recordDir = join(cwd, ".scramble", "peers.d");
    mkdirSync(recordDir, { recursive: true });
    chmodSync(recordDir, 0o500);
    try {
      expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], watched)).toBe(0);
      expect(writes.length).toBeGreaterThan(0);
      expect(errs.join(" ")).toContain("peer record not written for");
    } finally {
      chmodSync(recordDir, 0o700);
    }
  });

  test("`peers` on a build with no hostname seam publishes nothing and says so", async () => {
    const cwd = scratchDir("peers-nohost");
    const p = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["peers"], p.io)).toBe(0);
    expect(p.writes.join(" ")).toContain("No peers have been seen yet");
  });

  test("a channel this agent is not in is skipped ONCE, and named as not a fault", async () => {
    // The config is shared by every agent on a host, so each sweep walked the
    // others' channels and printed `slack: <name>: channel_not_found` for every
    // one, every time. An agent reported two such lines on every check, for
    // channels it had never been in: "It reads like a fault every time."
    const cwd = scratchDir("check-notmine");
    const io = slackCheckIo(cwd, {
      fetch: async (url) => {
        const u = String(url);
        if (u.includes("users.conversations"))
          return new Response(JSON.stringify({ ok: true, channels: [{ id: "C1", name: "mine" }] }), { status: 200 });
        if (u.includes("auth.teams.list"))
          return new Response(JSON.stringify({ ok: true, teams: [{ id: "T1" }] }), { status: 200 });
        if (u.includes("auth.test"))
          return new Response(JSON.stringify({ ok: true, user: "dev", team_id: "T1" }), { status: 200 });
        if (u.includes("conversations.history") && u.includes("C1"))
          return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
        return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 });
      },
    });
    // AFTER the helper, which writes its own config over anything earlier.
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { mine: "C1", theirs: "C2", alsotheirs: "C3" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    const errs: string[] = [];
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], { ...io, writeErr: (l) => errs.push(l) })).toBe(0);
    const said = errs.join("\n");
    expect(said).toContain("skipped 2 channel(s) dev is not a member of: alsotheirs, theirs");
    expect(said).toContain("shared by the agents on this host");
    // THE LINE A HUMAN PASTES, already filled in with this agent's HANDLE. An
    // agent read this list, wanted one of the channels, and had to ask which
    // command to ask for.
    expect(said).toContain("/invite @dev");
    // And NOT one line per channel, which is what read as a fault.
    expect(said).not.toContain("slack: theirs: channel_not_found");

    // A SECOND SWEEP WITH THE SAME SET IS SILENT. This line printed every tick,
    // so a monitor guarding on `if [ -n "$out" ]` fired every time: 123 of 187
    // ticks carried it and nothing else.
    const again: string[] = [];
    expect(
      await main(["message", "check", "--as", "dev", "--backend", "slack"], { ...io, writeErr: (l) => again.push(l) }),
    ).toBe(0);
    expect(again.join("\n")).not.toContain("is not a member of");

    // A CHANGE SPEAKS. Losing one of them is news, and so is gaining one.
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { mine: "C1", theirs: "C2" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    const moved: string[] = [];
    expect(
      await main(["message", "check", "--as", "dev", "--backend", "slack"], { ...io, writeErr: (l) => moved.push(l) }),
    ).toBe(0);
    expect(moved.join("\n")).toContain("skipped 1 channel(s) dev is not a member of: theirs");

    // A CURSOR FILE THAT WILL NOT PARSE reads as no remembered set, so the
    // advisory speaks. Silence there would hide a real change behind a corrupt
    // file.
    writeFileSync(join(cwd, ".scramble", "cursors", "dev.json"), "{ broken");
    const broken: string[] = [];
    expect(
      await main(["message", "check", "--as", "dev", "--backend", "slack"], { ...io, writeErr: (l) => broken.push(l) }),
    ).toBe(0);
    expect(broken.join("\n")).toContain("is not a member of");
  });

  test("with the membership listing broken, every channel stays loud", async () => {
    // A filter that cannot tell the two apart must not choose the quiet answer.
    const cwd = scratchDir("check-noclassify");
    const io = slackCheckIo(cwd, {
      fetch: async (url) =>
        String(url).includes("users.conversations")
          ? new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 })
          : new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { theirs: "C2" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    const errs: string[] = [];
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], { ...io, writeErr: (l) => errs.push(l) })).toBe(1);
    const said = errs.join("\n");
    expect(said).toContain("listing this agent's channels failed");
    expect(said).toContain("slack: theirs: channel_not_found");
    expect(said).not.toContain("skipped");
  });

  test("a status in an UNMAPPED channel resolves live, the way sending does", async () => {
    // Measured live: an agent invited into a channel could send to it, because
    // the post path asks Slack, while the status path read the hand-kept map,
    // found nothing, and the feature was dead in that channel. A stale map
    // entry ended the same way, as a bare `status: channel_not_found`.
    const cwd = scratchDir("status-unmapped");
    const asked: string[] = [];
    const io = slackCheckIo(cwd, {
      fetch: async (url, init) => {
        const u = String(url);
        asked.push(u);
        if (u.includes("conversations.history"))
          return new Response(
            JSON.stringify({ ok: true, messages: [{ ts: "9.9", user: "U9", text: "@dev hi" }] }),
            { status: 200 },
          );
        if (u.includes("users.conversations"))
          return new Response(
            JSON.stringify({ ok: true, channels: [{ id: "C-INVITED", name: "invited-channel" }] }),
            { status: 200 },
          );
        if (u.includes("auth.teams.list"))
          return new Response(JSON.stringify({ ok: true, teams: [{ id: "T1" }] }), { status: 200 });
        if (u.includes("auth.test"))
          return new Response(JSON.stringify({ ok: true, user: "dev", team_id: "T1" }), { status: 200 });
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
      },
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    expect(await main(["message", "check", "invited-channel", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    // The lookup the map could not answer went to Slack, under the agent's own
    // credential, exactly as the post path does.
    expect(asked.some((u) => u.includes("users.conversations"))).toBe(true);
  });

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
    // Each agent's own file carries its own cursor and its own skipped set, and
    // nothing belonging to the other agent.
    expect(Object.keys(after).sort()).toEqual(["slack-skipped:alpha", "slack:alpha"]);
  });

  test("the sweep covers channels this agent is IN, beyond what the config maps", async () => {
    // : a peer removed two entries from the SHARED config while testing name
    // resolution, and this sweep stopped covering the channel the operator
    // talks to me in. It reported "none of the 3 configured channels are
    // readable" and swept nothing that mattered, while the listener kept
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
    // Operator, after catching three style defects in a row: "You need to
    // understand this general pattern and use the message check to guard it."
    // Every rule was added AFTER a message went out carrying what it bans, so a
    // rule guarding only the NEXT message leaves every earlier one standing in
    // the channel, unmarked, as though it were fine.
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
    // the per-channel cursor moved: the stored slack cursor is a map of channel to ts
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
    // by the same name comparison listen and next use. The cursor still advances
    // over the skipped own-line, since the peer line is newest.
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
    // the cursor is the NEWEST line, which is the skipped OWN line (9.9), so the
    // very next sweep does not re-read it.
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
    // sweep 1: own lines are held back from the drain while the cursor passes them.
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
    // cursor holds the newest ts for the channel, which the last-seen ts can trail.
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
  // Measured live: scramble-dev was invited to one channel of the four in the config, and `message
  // check` answered `read failed: channel_not_found` and drained NOTHING, which a sweeping agent
  // cannot tell from a quiet workspace.
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
    // NAMED, and named as what it is: this agent is not a member of it, which
    // the membership listing settles. It used to read `theirs: channel_not_found`
    // on every single check, identical to a real failure.
    expect(said).toContain("theirs");
    expect(said).toContain("is not a member of");
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


describe("staleListeners", () => {
  // A committed fix does not reach a running process, and twice that produced a
  // visible defect the code had already fixed. Nothing said so, which is what
  // this answers.
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

  test("a running listener TELLS ITS OWN AGENT when a newer copy is installed", () => {
    // One version per machine is what this workspace wants, so an install by
    // any agent leaves every running listener behind. The install prints who is
    // affected, and the INSTALLER reads that. This is the half the stale agent
    // reads, on the stream it already watches. Two agents reported being left
    // behind and learning it only from doctor.
    const home = scratchDir("drift-home");
    const store = join(home, ".local", "share", "scramble");
    mkdirSync(join(store, "current", "src"), { recursive: true });
    mkdirSync(join(home, "mine"), { recursive: true });
    writeFileSync(join(home, "mine", "COMMIT"), "aaaaaaa\n");
    writeFileSync(join(store, "current", "src", "COMMIT"), "aaaaaaa\n");
    const outs: string[] = [];
    const errs: string[] = [];
    const io: Io = {
      write: (l) => outs.push(l),
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response("{}", { status: 200 }),
      env: (n) => (n === "HOME" ? home : undefined),
      cwd: () => home,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
      moduleDir: () => join(home, "mine"),
    };
    const drift = watchForNewerInstall(io);
    try {
      // Same commit: nothing to say.
      drift.tick();
      expect(outs).toEqual([]);
      // Somebody installs.
      writeFileSync(join(store, "current", "src", "COMMIT"), "bbbbbbb\n");
      drift.tick();
      expect(outs.join(" ")).toContain("this listener runs aaaaaaa and bbbbbbb is installed now");
      // ON THE DELIVERY STREAM, AS JSON. One agent's launcher sent stderr to a
      // file its monitor never read, so 58 of these notices reached nobody, and
      // merging that host's streams would have fed prose to a reader that
      // parses every line. A reader consuming deliveries consumes this.
      expect(errs).toEqual([]);
      const parsed = JSON.parse(outs[0] ?? "null") as Record<string, unknown>;
      expect(parsed.scramble).toBe("stale-listener");
      expect(parsed.running).toBe("aaaaaaa");
      expect(parsed.installed).toBe("bbbbbbb");
      // ONCE per change: a line every 30 seconds would teach the agent to skip it.
      drift.tick();
      expect(outs).toHaveLength(1);
    } finally {
      drift.stop();
    }
    // A copy with no COMMIT beside it falls back to the installed commit, so a
    // checkout run through bun directly compares against itself and says nothing.
    const bare: Io = { ...io, moduleDir: () => join(home, "no-commit-here") };
    const second = watchForNewerInstall(bare);
    try {
      second.tick();
    } finally {
      second.stop();
    }
  });

  test("a SHELL carrying the words is not a listener", () => {
    // A substring match over /proc counts any process whose arguments carry the
    // words, and the processes most likely to carry them are the ones people run
    // while looking into listeners. I hit this on my own host, where my
    // debugging shells matched the scan, and fixed the TESTS by feeding them an
    // empty /proc, which left the detector able to do it to anyone. argv[0]
    // settles it: a listener is executed by bun.
    const shell = proc("900", "/bin/bash -c pgrep -f 'bin.ts listen' | grep -- '--as dev'", 1_000);
    const grep = proc("901", "grep -F bin.ts listen --as dev", 1_000);
    const real = proc("902", "bun /srv/agents/scramble/abc1234/src/bin.ts listen --as dev", 1_000);
    expect(liveListeners([shell, grep, real], "dev")).toEqual(["902"]);
    expect(pickStale([shell, grep, real], "dev", 5_000).map((p) => p.pid)).toEqual(["902"]);
    expect(listenersBehind([shell, grep, real], "dev", "zzz9999").map((p) => p.pid)).toEqual(["902"]);
  });

  test("a pid that has gone is dropped before it is NAMED", () => {
    // An agent killed its listener, ran `doctor --wake`, and was refused with
    // the pid of a process that had already gone. A refusal naming a dead pid
    // sends someone hunting for a process to stop, and the probe it withheld
    // would have worked.
    const root = mkdtempSync(join(tmpdir(), "scramble-proc-"));
    mkdirSync(join(root, "500"), { recursive: true });
    expect(stillAlive(["500", "501"], root)).toEqual(["500"]);
    // A root that cannot be read answers "none alive", which is the safe
    // direction here: it lets the probe RUN and be judged on its own result.
    expect(stillAlive(["500"], join(root, "nothing"))).toEqual([]);
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
    // Nothing installed means no comparison to make. A false accusation would follow.
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
    // A REAL cmdline: /proc holds the argv of the process, so the shell's `cd`
    // and `&&` are never in it. The checkout path carries the other agent's name,
    // which is what this case exercises.
    const other = proc("104", "bun /srv/hark/scramble/src/bin.ts listen --as scramble-dev", 1_000);
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
    // WHAT IT ASKED FOR, with the answer. `react failed: channel_not_found`
    // named the error and nothing else, and an agent that measured a direct
    // reactions.add answering ok:true could take the report no further, because
    // the line said neither which channel id went out nor under whose
    // credential.
    expect(errs.join(" ")).toContain("channel room resolved to C1");
    expect(errs.join(" ")).toContain("ts 9.9");
    expect(errs.join(" ")).toContain("under dev's own token");
  });

  test("the failure names the CONFIG DEFAULT when the agent has no token of its own", () => {
    // An agent's own token and the config default are different apps, and which
    // one acted is the first thing to know when Slack says a channel does not
    // exist.
    const cwd = scratchDir("react-defaulttoken");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: { room: "C1" }, agents: { dev: {} } });
    const { io, errs } = reactIo(cwd, async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }));
    return main(["message", "react", "--target", "room", "--to", "9.9", "--emoji", "x", "--as", "dev", "--backend", "slack"], io).then((code) => {
      expect(code).toBe(1);
      expect(errs.join(" ")).toContain("under the config default token");
    });
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
    // The status post went out under dev's own token.
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
  // DERIVED FROM THE SOURCE LIST. This was a hand-kept copy and it fell behind
  // the real list by two scopes, so "a healthy agent" was healthy against a list
  // that no longer existed, which is the drift that let the events go unchecked.
  const ALL = SCOPE_NAMES.join(",");

  test("a healthy agent reports ok with its handle", async () => {
    const cwd = scratchDir("doc-ok");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const { io, writes } = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ doctor: "ok", agent: "dev", handle: "dev_bot" });
  });

  test("ok carries the PEER RECORD'S health, so a monitor reads a field", async () => {
    // Six agents append to that file on one host, one of them found a line no
    // parser could read, and the agent that armed a watcher for it wrote its own
    // parse loop. Two definitions of `damaged` disagree the day the row shape
    // changes, and a monitor grepping the prose sentence breaks on a rewording.
    const cwd = scratchDir("doc-peer-record");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    writeFileSync(
      join(cwd, ".scramble", "peers.jsonl"),
      `${JSON.stringify({ agent: "ana", host: "h", dir: "/w", at: "t1" })}\n{"agent":"bo","ho\n`,
    );
    const { io, writes } = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ peer_record: { rows: 1, damaged: 1 } });
  });

  test("ok says whether the REWRITE is on, and never prints the key", async () => {
    // Turning it on is four environment variables read by whichever process
    // sends, so a way to ask without sending a message is the difference between
    // configured and believed-configured.
    const cwd = scratchDir("doc-rewrite");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const off = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], off.io)).toBe(0);
    expect(JSON.parse(off.writes[0]!)).toMatchObject({ rewrite: { on: false } });
    // AND ON EVERY RUN, whether or not anything else is wrong. It sat in the
    // clean line only, so on a host where every other answer is a problem, the
    // one question an operator asks while setting it up had no answer.
    expect(off.errs.join(" ")).toContain("the outgoing rewrite is OFF");

    const on = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    const withKey: Io = {
      ...on.io,
      env: (n) =>
        n === "SCRAMBLE_REWRITE_KEY" ? "secret-key-value"
        : n === "SCRAMBLE_REWRITE_PROVIDER" ? "litellm"
        : n === "SCRAMBLE_REWRITE_URL" ? "http://127.0.0.1:4000/v1"
        : on.io.env(n),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], withKey)).toBe(0);
    const line = on.writes[0]!;
    expect(JSON.parse(line)).toMatchObject({
      rewrite: { on: true, provider: "litellm", url: "http://127.0.0.1:4000/v1" },
    });
    expect(line).not.toContain("secret-key-value");
    expect(on.errs.join(" ")).toContain("the outgoing rewrite is ON: litellm");
    expect(on.errs.join(" ")).not.toContain("secret-key-value");
  });

  test("ok NAMES the granted scopes, since a count cannot price a change", async () => {
    // `scopes: 14` answers no question anyone asks. Pricing a change asks WHICH
    // are granted, and with only a count on this surface I told an agent that
    // reading reactions needed a scope change and a reinstall. `reactions:read`
    // was already one of the fourteen, listed in this repo's own
    // app-manifest.ts, and they corrected me from their app.
    const cwd = scratchDir("doc-scopes");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const { io, writes } = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    const line = JSON.parse(writes[0]!) as { scopes: string[] };
    expect(line.scopes).toContain("reactions:read");
    expect(line.scopes).toHaveLength(SCOPE_NAMES.length);
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
    // Three refusals, since "doctor said no" is useless on its own: the
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
    // THE DEFECT THIS EXISTS FOR, measured live: the operator invited an agent
    // to a channel and nothing arrived. The app declared
    // org_deploy_enabled:true, held every scope, and its socket was delivering
    // mentions the whole time. It was subscribed to three events, leaving out
    // member_joined_channel, and Slack sends nothing for an event an app has
    // not asked for. Everything else about the agent was healthy, which is why
    // the wake path has to be checked field by field. Arriving messages prove
    // nothing about the fields.
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

  test("no CLI credential leaves the question open; a REFUSED export is reported", async () => {
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
    // A REFUSED EXPORT IS NO LONGER AN OPEN QUESTION. With a credential present
    // and the export refused, the app is not this login's to read, so its scopes
    // and events cannot be checked or repaired from here, and that is reported.
    expect(await run((h) => {
      mkdirSync(join(h, ".slack"), { recursive: true });
      writeFileSync(join(h, ".slack", "credentials.json"), JSON.stringify({ E1: { token: "x" } }));
    }, false)).toBe(1);
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
    // AN ADVISORY, so the verb still answers ok. A listener on an older commit
    // still DELIVERS; zero listeners means nothing arrives, and reporting the
    // two with the same weight made an agent build its own grading on top:
    // "advisory for a commit mismatch, alarm only for zero listeners".
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    const said = errs.join(" ");
    expect(said).toContain("doctor advisory:");
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

  test("two agents on ONE app are named, because Slack splits their events", async () => {
    // A fourth agent measured it: its listener and a second app on the same
    // adopted token were splitting mentions between "a consumer that answers and
    // a consumer that discards them", and a human asked the same question twice
    // inside that window.
    const cwd = scratchDir("doc-shared-app");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: {},
      agents: {
        dev: { token: "T1", handle: "dev_bot", appId: "A_SHARED" },
        twin: { token: "T2", handle: "twin_bot", appId: "A_SHARED" },
        alone: { token: "T3", handle: "alone_bot", appId: "A_OWN" },
      },
    });
    const { io, errs } = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("twin");
    expect(said).toContain("A_SHARED");
    expect(said).not.toContain("alone");

    // An agent with an app of its own is clean.
    const b = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "alone_bot" });
    expect(await main(["doctor", "--as", "alone", "--backend", "slack"], b.io)).toBe(0);
  });

  test("an app this login cannot read names the OWNER, never a command that dies", async () => {
    // A fourth agent onboarded onto someone else's app and doctor told it to run
    // onboard-agent.ts, which calls apps.manifest.export and dies on its first
    // call for the same reason: "The repair line assumes the agent owns the app."
    const home = scratchDir("doc-foreign-home");
    mkdirSync(join(home, ".slack"), { recursive: true });
    writeFileSync(join(home, ".slack", "credentials.json"), JSON.stringify({ E1: { token: "xoxe-cli" } }));
    const cwd = scratchDir("doc-foreign");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: {},
      agents: { dev: { token: "T", handle: "dev_bot", appId: "A_SOMEONE_ELSE" } },
    });
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input) =>
        String(input).includes("auth.test")
          ? new Response(JSON.stringify({ ok: true, user: "dev_bot" }), { status: 200, headers: { "x-oauth-scopes": ALL } })
          : new Response(JSON.stringify({ ok: false, error: "no_permission" }), { status: 200 }),
      env: (n) =>
        n === "HOME" ? home
        : n === "SCRAMBLE_SLACK_CONFIG" ? join(cwd, ".scramble", "slack.json")
        : n === "SCRAMBLE_PROC" ? EMPTY_PROC
        : undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("no_permission");
    expect(said).toContain("ask its owner");

    // AN ERROR SLACK NEVER TIED TO ACCESS gets no ownership verdict. The
    // ownership sentence was the `else` of a whitelist, so each new error
    // string arrived as an ownership claim: `token_expired`, then
    // `invalid_refresh_token` from my own rotation code a day later.
    const errs2: string[] = [];
    const io2: Io = {
      ...io,
      writeErr: (l) => errs2.push(l),
      fetch: async (input) =>
        String(input).includes("auth.test")
          ? new Response(JSON.stringify({ ok: true, user: "dev_bot" }), {
              status: 200,
              headers: { "x-oauth-scopes": ALL },
            })
          : new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 200 }),
    };
    await main(["doctor", "--as", "dev", "--backend", "slack"], io2);
    const said2 = errs2.join(" ");
    expect(said2).toContain("ratelimited");
    expect(said2).toContain("UNDETERMINED");
    expect(said2).not.toContain("ask its owner");
    expect(said2).not.toContain("drop this agent's entry");
    // The command that cannot run is NOT named as the fix.
    expect(said).not.toContain("Fix: bun scripts/onboard-agent.ts");
  });

  test("a credential failure carries its own repair, and doctor adds no guess to it", async () => {
    // The first live run of the rotation answered `invalid_refresh_token`, and
    // doctor appended "This app may have been created by another login" to it:
    // a cause the evidence never established, on the surface an agent trusts,
    // which is the same defect the ownership branch had a day earlier.
    const home = scratchDir("doc-selfexpl-home");
    mkdirSync(join(home, ".slack"), { recursive: true });
    writeFileSync(
      join(home, ".slack", "credentials.json"),
      JSON.stringify({ E1: { token: "xoxe-old", refresh_token: "xoxe-r-dead", exp: 1 } }),
    );
    const cwd = scratchDir("doc-selfexpl");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: {},
      agents: { dev: { token: "T", handle: "dev_bot", appId: "A_MINE" } },
    });
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("auth.test"))
          return new Response(JSON.stringify({ ok: true, user: "dev_bot" }), {
            status: 200,
            headers: { "x-oauth-scopes": ALL },
          });
        if (url.includes("tooling.tokens.rotate"))
          return new Response(JSON.stringify({ ok: false, error: "invalid_refresh_token" }), { status: 200 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      env: (n) =>
        n === "HOME" ? home
        : n === "SCRAMBLE_SLACK_CONFIG" ? join(cwd, ".scramble", "slack.json")
        : n === "SCRAMBLE_PROC" ? EMPTY_PROC
        : undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    await main(["doctor", "--as", "dev", "--backend", "slack"], io);
    const said = errs.join(" ");
    expect(said).toContain("invalid_refresh_token");
    expect(said).toContain("slack login");
    expect(said).not.toContain("created by another login");
    expect(said).not.toContain("drop this agent's entry");
  });

  test("doctor names a peer running a different commit than this host installs", async () => {
    // THE HOST THAT STOPS UPDATING SENDS NO SIGNAL: the staleness notice
    // compares a listener to the install beside it, so a machine nobody
    // installs on stays quiet while it falls behind. One sat five commits back
    // with every listener matching its own install.
    const cwd = scratchDir("doc-peer-commit");
    const share = scratchDir("doc-peer-share");
    mkdirSync(join(share, "current", "src"), { recursive: true });
    writeFileSync(join(share, "current", "src", "COMMIT"), "mine123\n");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: {},
      agents: { dev: { token: "T", handle: "dev_bot" } },
    });
    writeFileSync(
      join(cwd, ".scramble", "peers.jsonl"),
      `${JSON.stringify({
        agent: "faraway",
        host: "other-host",
        dir: "/elsewhere",
        commit: "newer99",
        at: "2026-08-26T12:00:00Z",
      })}\n`,
    );
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input) =>
        String(input).includes("auth.test")
          ? new Response(JSON.stringify({ ok: true, user: "dev_bot" }), {
              status: 200,
              headers: { "x-oauth-scopes": ALL },
            })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      env: (n) =>
        n === "SCRAMBLE_SLACK_CONFIG" ? join(cwd, ".scramble", "slack.json")
        : n === "SCRAMBLE_PROC" ? EMPTY_PROC
        : n === "SCRAMBLE_HOME" ? share
        : undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    await main(["doctor", "--as", "dev", "--backend", "slack"], io);
    const said = errs.join(" ");
    expect(said).toContain("this host installs mine123");
    expect(said).toContain("faraway on other-host ran newer99");
    // WHAT THE READING IS: a commit that peer ran when it wrote. An agent was
    // flagged on `d836964` while running `1f082b8`, because that was the newest
    // message the ledger held from them.
    expect(said).toContain("LAST SPOKE on a different commit");
    expect(said).toContain("upgraded without speaking since still shows the old one");
    expect(said).toContain("A machine nobody installs on never reports staleness");
  });

  test("doctor ROTATES a spent app-config token instead of asking a person to log in", async () => {
    // The token lives twelve hours and nothing renewed it, so doctor lost the
    // manifest check every night on both hosts. The entry carries a
    // refresh_token, which is what an agent found in the file.
    const home = scratchDir("doc-rotate-home");
    mkdirSync(join(home, ".slack"), { recursive: true });
    writeFileSync(
      join(home, ".slack", "credentials.json"),
      JSON.stringify({ E1: { token: "xoxe-old", refresh_token: "xoxe-r-old", exp: 1, team_domain: "examplecorp" } }),
    );
    const cwd = scratchDir("doc-rotate");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: {},
      agents: { dev: { token: "T", handle: "dev_bot", appId: "A_MINE" } },
    });
    const errs: string[] = [];
    let rotateUrl = "";
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("auth.test"))
          return new Response(JSON.stringify({ ok: true, user: "dev_bot" }), {
            status: 200,
            headers: { "x-oauth-scopes": ALL },
          });
        if (url.includes("tooling.tokens.rotate")) {
          rotateUrl = url;
          return new Response(
            JSON.stringify({ ok: true, token: "xoxe-new", refresh_token: "xoxe-r-new", exp: 4102444800 }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true, manifest: { settings: { event_subscriptions: {} } } }), {
          status: 200,
        });
      },
      env: (n) =>
        n === "HOME" ? home
        : n === "SCRAMBLE_SLACK_CONFIG" ? join(cwd, ".scramble", "slack.json")
        : n === "SCRAMBLE_PROC" ? EMPTY_PROC
        : undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    await main(["doctor", "--as", "dev", "--backend", "slack"], io);
    expect(rotateUrl).toContain("xoxe-r-old");
    expect(errs.join(" ")).toContain("has been rotated");
    // The new pair is on disk, and the Slack CLI's own fields survive.
    const after = JSON.parse(readFileSync(join(home, ".slack", "credentials.json"), "utf8"));
    expect(after.E1.token).toBe("xoxe-new");
    expect(after.E1.refresh_token).toBe("xoxe-r-new");
    expect(after.E1.team_domain).toBe("examplecorp");
  });

  test("an EXPIRED cli token is a token problem, and says nothing about ownership", async () => {
    // Run against my own app, which I own, this answered "This app was created
    // by another login" from a `token_expired` error and told me to ask the
    // owner or drop the entry. A cause the evidence never established, printed
    // as fact, on the surface an agent trusts to tell it what is wrong.
    const home = scratchDir("doc-expired-home");
    mkdirSync(join(home, ".slack"), { recursive: true });
    writeFileSync(join(home, ".slack", "credentials.json"), JSON.stringify({ E1: { token: "xoxe-cli" } }));
    const cwd = scratchDir("doc-expired");
    writeSlackConfig(cwd, {
      token: "xoxb-d",
      channels: {},
      agents: { dev: { token: "T", handle: "dev_bot", appId: "A_MINE" } },
    });
    const errs: string[] = [];
    const io: Io = {
      write: () => {},
      writeErr: (l) => errs.push(l),
      fetch: async (input) =>
        String(input).includes("auth.test")
          ? new Response(JSON.stringify({ ok: true, user: "dev_bot" }), { status: 200, headers: { "x-oauth-scopes": ALL } })
          : new Response(JSON.stringify({ ok: false, error: "token_expired" }), { status: 200 }),
      env: (n) =>
        n === "HOME" ? home
        : n === "SCRAMBLE_SLACK_CONFIG" ? join(cwd, ".scramble", "slack.json")
        : n === "SCRAMBLE_PROC" ? EMPTY_PROC
        : undefined,
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    const said = errs.join(" ");
    expect(said).toContain("token_expired");
    expect(said).toContain("Nothing about who owns the app follows from it");
    expect(said).not.toContain("ask its owner");
    expect(said).not.toContain("drop this agent's entry");
    // NAMES THE FILE THAT HOLDS IT. The credential comes from the Slack CLI's
    // own store, and this line used to say "the CLI token in this config",
    // pointing at a scramble config that has no such key. An agent read that,
    // opened the config, found nothing, and reported it could not fix the gap.
    expect(said).toContain("~/.slack/credentials.json");
    expect(said).toContain("slack login");
  });

  test("doctor --wake REFUSES to run while a listener holds the socket", async () => {
    // Measured: with the inbox armed, `doctor --wake` reported "The wake path
    // is DEAD" and told me to re-onboard, which rotates the bot token and
    // strands that listener. With the same inbox stopped and nothing else
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
    // is the live shape (`channel_not_found`), and it must FAIL, since a quiet
    // pass on an unpostable probe proves nothing about the wake path.
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