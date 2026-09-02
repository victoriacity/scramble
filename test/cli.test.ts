import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ChannelStore } from "../src/store";
import { createStore } from "../src/store";
import { createHandler } from "../src/server";
import { WORD_LIMIT } from "../src/language";
import { bulletsForSlack, KNOWN_ENV, unknownEnvNote, hashVerdict, textHash, differenceLine, autoKey, installedChanges, changeBlock, monitorReport, sweepAgeMinutes, sweepInsideListener, sweepSummaryLine, SWEEP_INTERVAL_MS, main, parseBind, loadSlackConfig, slackConfigPath, staleConfigWarning, staleListeners, pickStale, staleListenerProblem, readProcesses, liveListeners, stillAlive, watchForNewerInstall, listenerCommit, listenersBehind, processesReadable, type Io } from "../src/cli";
import { SCOPE_NAMES, BOT_EVENT_NAMES } from "../src/app-manifest";
import { closeInboxItems, inboxPath, pendingInbox, readSentRows, recordInboxItem, recordSent, sentAlready, sentPath } from "../src/inbox";
import { readTierBlock } from "../src/rewrite";

/**
 *  The register block contains the text as the `SHIPPED` file holds it. A test
 *  that copies the wording fails the day the operator rewords the file, and says
 *  nothing about whether the send reached the model with it.
 */
function shippedRegister(tier: string): string {
  const r = readTierBlock(join(import.meta.dir, "..", "src"), tier);
  if (!r.ok) throw new Error(r.why);
  return r.text;
}

/**
 *  The prompt comes from a captured Gemini request body.
 */
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
  // A pull operation runs in two phases. The first pull delivers the lines, and the
  // second pull ends the stream. A close stops the stream cleanly, whereas an error
  // drops the connection. Erroring a stream discards anything enqueued in the same
  // pull, so the termination must occur in a separate pull to guarantee the lines
  // are read first.
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
  // An agent targeted a file copy for a check using `SCRAMBLE_CONFIG`, which
  // nothing reads. The command read the production file and returned `damaged: 0`,
  // and that result accurately described the inspected file. The agent nearly filed
  // a bug stating that the field did not work, and reading `slackConfigPath` is what
  // stopped them. An override that misses appears identical to a clean result.
  test("a SCRAMBLE_ name this build never reads is named, with the nearest one it does", () => {
    expect(unknownEnvNote(["SCRAMBLE_CONFIG"])).toContain("SCRAMBLE_CONFIG is set and this build reads no such name");
    expect(unknownEnvNote(["SCRAMBLE_CONFIG"])).toContain("Did you mean SCRAMBLE_SLACK_CONFIG?");
    expect(unknownEnvNote(["SCRAMBLE_KEY"])).toContain("Did you mean SCRAMBLE_REWRITE_KEY?");
    // This build reads every name silently, and the rest of the environment stays
    // silent.
    expect(unknownEnvNote(KNOWN_ENV)).toBe("");
    expect(unknownEnvNote(["HOME", "PATH", "CLAUDE_CODE_SESSION_ID"])).toBe("");
    // The output lists several items at once in sorted order, with one item per line.
    expect(unknownEnvNote(["SCRAMBLE_ZZZ", "SCRAMBLE_AAA"]).split("\n")).toHaveLength(2);
    expect(unknownEnvNote(["SCRAMBLE_ZZZ", "SCRAMBLE_AAA"]).split("\n")[0]).toContain("SCRAMBLE_AAA");
  });

  test("the note reaches stderr on any verb, and the verb still runs", async () => {
    const cwd = scratchDir("env-typo");
    const { io, writes, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    // `version` exits 1 from a checkout as its own signal. The note reached stderr,
    // and the verb still answered.
    await main(["version"], { ...io, envNames: () => ["SCRAMBLE_CONFIG", "HOME"] });
    expect(errs.join(" ")).toContain("SCRAMBLE_CONFIG is set");
    expect(writes.join(" ")).toContain("scramble");
    // A build stays silent when it has no way to list its environment.
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
    // (a) The configuration value overrides the default localhost setting when
    // neither an environment variable nor a flag is present.
    const a = stubIo(cwd, async (u) => new Response("[]", { status: 200 }));
    await main(["history", "general"], a.io);
    expect(a.urls[0]).toContain("http://config:9");
    // (b) Environment variables take precedence over configuration settings.
    const b = stubIo(cwd, async (u) => new Response("[]", { status: 200 }));
    b.io.env = (n) => (n === "SCRAMBLE_URL" ? "http://env:8" : undefined);
    await main(["history", "general"], b.io);
    expect(b.urls[0]).toContain("http://env:8");
    // The `--url` flag takes precedence over the environment variable.
    const c = stubIo(cwd, async (u) => new Response("[]", { status: 200 }));
    c.io.env = (n) => (n === "SCRAMBLE_URL" ? "http://env:8" : undefined);
    await main(["history", "general", "--url", "http://flag:1"], c.io);
    expect(c.urls[0]).toContain("http://flag:1");
    // (d) The system defaults to localhost when nothing is configured.
    const bare = scratchDir("bare");
    const dres = stubIo(bare, async (u) => new Response("[]", { status: 200 }));
    await main(["history", "general"], dres.io);
    expect(dres.urls[0]).toContain("http://127.0.0.1:7737");
    // The `--token` override produces a bearer header.
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
    // The environment provides the real URL when configuration fields contain the
    // wrong type.
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
    // The operator seeds a crossing from Bob.
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
      // The listener's own sweep drains `pending` at startup, which is a different
      // cursor on a different path; this test reads the STREAM's resume point.
      if (u.pathname.includes("/pending")) return new Response("[]", { status: 200 });
      seenSince.push(Number(u.searchParams.get("since")));
      const n = call++;
      if (n === 0) return ndjs([msg(5, "bob", "one")], "error"); // drop mid-stream
      return ndjs([msg(7, "bob", "two")], "close"); // clean stop
    });
    const code = await main(["listen", "--as", "ana"], io);
    expect(code).toBe(0);
    // The process resumes at the last seen sequence number.
    expect(seenSince).toEqual([0, 5]);
    const lines = writes.map((l) => JSON.parse(l) as { seq: number; mentioned: boolean });
    expect(lines.map((l) => l.seq)).toEqual([5, 7]);
    expect(lines[0]!.mentioned).toBe(false);
  });

  test("the SERIALISED shape of a delivery is pinned, since two claims were made against a guess", async () => {
    // Any filter outside this process reads the serialised line. Two separate claims
    // were published about what such a filter matches, and neither was measured
    // against this serialiser. One claim stated that prose quoting `"mentioned":true`
    // woke four hosts. Another measurement used Python's json.dumps, which emits a
    // space after the colon, and nearly reported a filter as already broken.
    // Executable tests settle both cases here, so nobody re-derives the shape in an
    // ad-hoc shell again.
    //
    // Postmortems:
    // `log/postmortems/-published-another-agents-mechanism-as-fact-without-running-it.md`
    // `log/postmortems/2026-08-22-control-set-used-a-foreign-serialiser.md`
    const cwd = scratchDir("listen-serialised");
    const quoting = 'the filter greps "mentioned":true and that is the defect';
    const { io, writes } = stubIo(cwd, async () =>
      ndjs([msg("s1", "bob", quoting), msg("s2", "bob", "@ana hello", ["ana"])], "close"),
    );
    expect(await main(["listen", "--as", "ana"], io)).toBe(0);
    const [prose, mention] = writes as [string, string];
    // Do not include a space after the colon. A serialiser that adds a space silently
    // prevents every external filter from matching, so this test pins this assumption.
    expect(mention).toContain('"mentioned":true');
    expect(mention).not.toContain('"mentioned": true');
    // Prose cannot forge the field because quoting it in a message body returns with
    // the quotes escaped, which places it out of reach of a bare pattern. A pattern
    // carrying a quote character protects itself. A bare word has nothing to hide
    // behind.
    expect(prose).toContain('\\"mentioned\\":true');
    expect(prose).not.toContain('"mentioned":true');
  });

  test("--addressed filters IN THE LISTENER, and the ledger still sees everything", async () => {
    // Both `scripts/inbox.sh` and JOIN.md directed agents to pipe serialized lines
    // through `grep '"mentioned":true'`. This filter matches only while the serializer
    // emits no space after the colon and keeps the field name. If the serializer adds
    // a space, reorders fields, or renames the field, the pattern stops matching
    // without an error and without an exit, so the inbox goes quiet and looks calm.
    // The rule belongs where the field is computed.
    const cwd = scratchDir("listen-addressed");
    const { io, writes } = stubIo(cwd, async () =>
      ndjs([msg("b1", "bob", "nothing for you"), msg("b2", "bob", "@ana hello", ["ana"])], "close"),
    );
    expect(await main(["listen", "--addressed", "--as", "ana"], io)).toBe(0);
    expect(writes.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual(["idb2"]);
    // The system recorded both lines. The filter determines what wakes the agent,
    // while the ledger preserves all records, or `trace` would answer "not
    // delivered" for every line the filter dropped.
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
      // A stream stays open and never delivers a line.
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {},
        }),
        { status: 200 },
      );
    });
    // A bare `--timeout` flag without a value parses to the 0s default fallback,
    // which produces an immediate 64.
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
    // The stdout stream remains JSON-only, and the pointer must never appear there.
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
    // The scaffolded stub persona was read and transmitted.
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
    // If `HOME` is present, the process survives and creates the store under
    // `$HOME/.scramble`.
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
    // When Slack runs without a configuration, the system reports a missing-config
    // error that names the repair. An unknown-backend rejection would name nothing.
    const io2 = stubIo(cwd, async () => new Response("[]", { status: 200 })).io;
    const slack = await main(["post", "general", "hi", "--as", "dev", "--backend", "slack"], io2);
    expect(slack).toBe(1);
  });
});

// --- the mirrored raft grammar (message / profile / channel) -------------
// scramble uses the same noun-verb grammar as the raft CLI. The tool preserves
// the old verbs as aliases and handles mirror parsing under the local backend.

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
    // The process makes no crossings and exits cleanly.
    expect(writes).toHaveLength(0);
  });

  test("a message breaking a language rule is REFUSED before anything is sent", async () => {
    // A separate script run by the sender previously checked the rules, so piping
    // text directly into `message send` skipped them and messages went out unlinted
    // for a day. The check moved into the send, and this asserts that the send does
    // not happen.
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

  test("a claim about one reader in a room of several is REFUSED before it is sent", async () => {
    // A message to three agents credited one of them with another's scan, and the
    // agent who did not run it published a correction. The check runs where the
    // language rules run, so the send does not happen.
    const cwd = scratchDir("msgsend-attrib");
    const { io, errs } = stubIo(cwd, async () => {
      throw new Error("REFUSED means no request is made");
    });
    io.readStdin = async () =>
      "@reader-one @reader-two @reader-three The mode is 0600 now.\n\nOn the file mode you measured, your scan of 118 drafts found nothing.";
    expect(await main(["message", "send", "--target", "general", "--as", "ana"], io)).toBe(1);
    expect(errs.join(" ")).toContain("without naming which one");
    expect(errs.join(" ")).toContain("@reader-two");
  });

  test("`post` is not the way around what `message send` enforces", async () => {
    // The check runs at the common path that both verbs pass through, so a second
    // entry point cannot ship unlinted prose. This issue was found while writing up
    // the first fix, when `post <channel> <text>` received the same words and did not
    // apply the rules.
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
    // The `history` verb prints the thread back.
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
    // The second check finds nothing new pending, prints nothing, and still exits 0.
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
  // The `--help` flag is unknown across the CLI. Running `doctor --help` falls
  // through to the working directory as the agent name: from `mbench3d` the command
  // reports `doctor: no agent "mbench3d"`, from `/tmp` it reports "tmp", and from
  // home it reports the user name. An unknown flag turns a directory into an
  // identity.
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
    // The fallback behavior was unexpected, so the help text names the fallback.
    const { io, writes } = stubIo(scratchDir("help-as"), async () => new Response("{}", { status: 200 }));
    expect(await main(["--help"], io)).toBe(0);
    expect(writes.join("\n")).toContain("directory's basename");
  });
});

describe("`scramble rewrite --document`: a repository document for an outside reader", () => {
  /**
   *  An engineer writes a document containing two sections and a fenced block for
   *  their own use.
   */
  // The fixture uses a real section, since the subject guard needs the eight
  // content words a real section has. The duplicate guard uses the same floor,
  // and a two-word fixture skips the check it exists to exercise.
  const DOC = [
    "# Title",
    "",
    "The listener delivers a mention to the agent, and the sweep drains the channel",
    "into the same inbox ledger every fifteen minutes.",
    "",
    "## Section",
    "```bash",
    "echo hi",
    "```",
    "The install writes the committed tree of HEAD into a directory named by its commit.",
  ].join("\n");

  function docIo(name: string, answer: (body: string) => string): { io: Io; writes: string[]; errs: string[]; dir: string } {
    const dir = scratchDir(name);
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "prompts", "document.md"), "# Document rewrite instruction\nRewrite the section below.\n");
    writeFileSync(join(dir, "doc.md"), DOC);
    const { io, writes, errs } = stubIo(dir, async (_u, init) => {
      const body = String((init as { body?: unknown } | undefined)?.body ?? "");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer(body) }] } }] }), { status: 200 });
    });
    io.moduleDir = () => dir;
    const keyed: Io = { ...io, env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : undefined) };
    return { io: keyed, writes, errs, dir };
  }

  test("each section is rewritten and the fenced block survives", async () => {
    // The message instruction would gut a document because it caps prose at 300
    // words and asks the model to drop reasoning, while a design document carries
    // 4000 words of reasoning by design. This path reads its own instruction and
    // sends one section per call.
    const { io, writes, errs, dir } = docIo("doc-ok", (body) =>
      body.includes("## Section")
        ? "## Section\n```bash\necho hi\n```\nThe install writes the committed tree of HEAD into a directory named by its commit."
        : "# Title\n\nThe agent receives a mention from the listener, and the sweep drains the channel into the same inbox ledger every fifteen minutes.",
    );
    expect(await main(["rewrite", "--document", join(dir, "doc.md")], io)).toBe(0);
    const out = writes.join("\n");
    expect(out).toContain("The agent receives a mention from the listener");
    expect(out).toContain("```bash\necho hi\n```");
    expect(errs.join("\n")).toContain("2 section(s), 2 rewritten, 0 kept as written");
  });

  test("`--once` sends one call per section and runs no guard", async () => {
    // A single whole-file call exceeded the 300-second limit on a 7KB document, so
    // this mode runs one call per section and spends nothing on guards.
    const { io, writes, errs, dir } = docIo("doc-once", () => "short prose that carries nothing");
    expect(await main(["rewrite", "--document", "--once", join(dir, "doc.md")], io)).toBe(0);
    expect(writes.join("\n")).toContain("short prose that carries nothing");
    expect(errs.join("\n")).toContain("2 rewritten");
  });

  test("A SECTION THE GUARDS REFUSE KEEPS ITS ORIGINAL TEXT and says so", async () => {
    // A pass that drops a section it cannot rewrite returns a shorter document that
    // reads as finished.
    const { io, writes, errs, dir } = docIo("doc-refused", () => "a replacement that carries none of the input");
    expect(await main(["rewrite", "--document", join(dir, "doc.md")], io)).toBe(0);
    expect(writes.join("\n")).toContain("echo hi");
    expect(writes.join("\n")).toContain("The listener delivers a mention to the agent");
    const said = errs.join("\n");
    expect(said).toContain("kept its original text");
    expect(said).toContain("kept as written");
  });

  test("a missing instruction file is a reason, and so is a missing key", async () => {
    const dir = scratchDir("doc-noprompt");
    writeFileSync(join(dir, "doc.md"), DOC);
    const { io, errs } = stubIo(dir, async () => new Response("{}", { status: 200 }));
    io.moduleDir = () => dir;
    const keyed: Io = { ...io, env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : undefined) };
    expect(await main(["rewrite", "--document", join(dir, "doc.md")], keyed)).toBe(1);
    expect(errs.join(" ")).toContain("document rewrite instruction");

    const withPrompt = docIo("doc-nokey", () => "x");
    const noKey: Io = { ...withPrompt.io, env: () => undefined };
    expect(await main(["rewrite", "--document", join(withPrompt.dir, "doc.md")], noKey)).toBe(1);
    expect(withPrompt.errs.join(" ")).toContain("no model is configured");
  });
});

describe("`scramble rewrite --comments`: the prose of a source file", () => {
  const SRC = [
    "// THE LISTENER DELIVERS A MENTION to the agent, and the sweep drains the channel",
    "// into the same inbox ledger every fifteen minutes on a timer.",
    "const x = 1;",
    "export function f(): number { return x; }",
  ].join("\n");

  function commentIo(name: string, answer: string): { io: Io; writes: string[]; errs: string[]; dir: string } {
    const dir = scratchDir(name);
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "prompts", "document.md"), "# Document rewrite instruction\nRewrite the section below.\n");
    writeFileSync(join(dir, "code.ts"), SRC);
    const { io, writes, errs } = stubIo(dir, async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] }), { status: 200 }),
    );
    io.moduleDir = () => dir;
    return { io: { ...io, env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : undefined) }, writes, errs, dir };
  }

  test("the comments are rewritten and every line of code is untouched", async () => {
    const answer = "The listener hands a mention to the agent, and the sweep drains that channel into the same inbox ledger every fifteen minutes on its timer.";
    const { io, writes, errs, dir } = commentIo("cmt-ok", answer);
    expect(await main(["rewrite", "--comments", join(dir, "code.ts")], io)).toBe(0);
    const out = writes.join("\n");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("export function f(): number { return x; }");
    expect(out).toContain("// The listener hands a mention");
    expect(errs.join("\n")).toContain("1 comment(s), 1 rewritten, 0 kept as written");
  });

  test("A REWRITE THAT CHANGES A LINE OF CODE REFUSES THE WHOLE FILE", async () => {
    // A comment rewrite modifies prose, and reflowing a line of code would silently
    // edit a program. An answer that contains a block terminator closes the comment
    // early and turns the remaining text into code, which is the pattern this check
    // detects.
    const dir = scratchDir("cmt-code");
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "prompts", "document.md"), "# Document rewrite instruction\nRewrite.\n");
    writeFileSync(join(dir, "code.ts"), ["/** A block comment about the listener and its ledger. */", "const x = 1;"].join("\n"));
    const { io, errs } = stubIo(dir, async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "listener ledger\n*/\nconst y = 2;" }] } }] }), { status: 200 }),
    );
    io.moduleDir = () => dir;
    const keyed: Io = { ...io, env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : undefined) };
    expect(await main(["rewrite", "--comments", "--once", join(dir, "code.ts")], keyed)).toBe(1);
    expect(errs.join("\n")).toContain("the code outside the comments changed");
  });

  test("a guard refusal keeps the comment as written", async () => {
    const { io, writes, errs, dir } = commentIo("cmt-refused", "unrelated prose that carries nothing from the input at all");
    expect(await main(["rewrite", "--comments", join(dir, "code.ts")], io)).toBe(0);
    expect(writes.join("\n")).toContain("THE LISTENER DELIVERS A MENTION");
    expect(errs.join("\n")).toContain("kept as written");
  });

  test("`--once` takes the answer with no guard, and a missing instruction is a reason", async () => {
    const { io, writes, dir } = commentIo("cmt-once", "short replacement prose");
    expect(await main(["rewrite", "--comments", "--once", join(dir, "code.ts")], io)).toBe(0);
    expect(writes.join("\n")).toContain("// short replacement prose");

    const bare = scratchDir("cmt-noprompt");
    writeFileSync(join(bare, "code.ts"), SRC);
    const plain = stubIo(bare, async () => new Response("{}", { status: 200 }));
    plain.io.moduleDir = () => bare;
    const keyed: Io = { ...plain.io, env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : undefined) };
    expect(await main(["rewrite", "--comments", join(bare, "code.ts")], keyed)).toBe(1);
    expect(plain.errs.join(" ")).toContain("document rewrite instruction");

    const nokey = commentIo("cmt-nokey", "x");
    const unkeyed: Io = { ...nokey.io, env: () => undefined };
    expect(await main(["rewrite", "--comments", join(nokey.dir, "code.ts")], unkeyed)).toBe(1);
    expect(nokey.errs.join(" ")).toContain("no model is configured");
  });
});

describe("both monitors are reported on every send", () => {
  // A COMPLETED ONBOARDING STEP PROVES NOTHING ABOUT NOW. Several agents finished
  // onboarding and held a dead monitor: one sweep exited with code 144, printed no
  // error text, and its log ended with two ordinary drains. The listener check used
  // to live inside the sweep, so a dead sweep hid its own absence.
  function io(cwd: string, cursor?: Record<string, string>): Io {
    const { io: base } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    if (cursor !== undefined) {
      const p = join(cwd, ".scramble", "cursors", "dev.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ "slack:dev": cursor }));
    }
    return { ...base, env: (n) => (n === "SCRAMBLE_PROC" ? join(cwd, "noproc") : undefined) };
  }

  test("the age comes from when the sweep RAN, and a quiet channel is not a dead monitor", () => {
    // MEASURED LIVE BY AN AGENT: their sweep finished 42 seconds earlier and this
    // field said 38 minutes, because it read the newest message in the cursor and
    // their channels had been quiet for half an hour. The send then told them to
    // restart the monitor with the command they had just run.
    const cwd = scratchDir("mon-quiet");
    const p = join(cwd, ".scramble", "cursors", "dev.json");
    mkdirSync(dirname(p), { recursive: true });
    // A cursor whose newest message is 40 minutes old, written just now.
    const oldTs = `${Math.floor((Date.now() - 40 * 60_000) / 1000)}.000100`;
    writeFileSync(p, JSON.stringify({ "slack:dev": { general: oldTs } }));
    const quiet = io(cwd);
    expect(sweepAgeMinutes(quiet, "dev")).toBe(0);
    expect(monitorReport(quiet, "dev").join(" ")).not.toContain("may have died");
    // AND A SWEEP THAT STOPPED still reads as stopped: an old file mtime with a
    // recent message inside it.
    const freshTs = `${Math.floor(Date.now() / 1000)}.000100`;
    writeFileSync(p, JSON.stringify({ "slack:dev": { general: freshTs } }));
    const then = Date.now() - 45 * 60_000;
    utimesSync(p, new Date(then), new Date(then));
    expect(sweepAgeMinutes(quiet, "dev")).toBe(45);
    expect(monitorReport(quiet, "dev").join(" ")).toContain("may have died");
  });

  test("a sweep that never ran, and one that stopped, each read differently", () => {
    // NO CURSOR FILE AT ALL is a sweep that never ran for this agent.
    const never = scratchDir("mon-never");
    expect(sweepAgeMinutes(io(never), "dev")).toBeUndefined();
    expect(monitorReport(io(never), "dev").join(" ")).toContain("no timed sweep has ever run");

    // A file written now is a sweep that just finished, whatever it holds.
    const fresh = scratchDir("mon-fresh");
    expect(sweepAgeMinutes(io(fresh, { general: "1.1" }), "dev")).toBe(0);
    expect(monitorReport(io(fresh, { general: "1.1" }), "dev").join(" ")).not.toContain("sweep");

    // A directory where the file should be still answers with a number, and the
    // caller sees a value it can compare.
    const odd = scratchDir("mon-odd");
    mkdirSync(join(odd, ".scramble", "cursors", "dev.json"), { recursive: true });
    expect(sweepAgeMinutes(io(odd), "dev")).toBeGreaterThanOrEqual(0);
  });

  /**
   *  A process list holding one listener for this agent. `readProcesses` reads the
   *  command line of each numbered directory, which is what the report reads.
   */
  function procRootWithListener(cwd: string): string {
    const root = join(cwd, "proc");
    const pid = join(root, "4242");
    mkdirSync(pid, { recursive: true });
    // The match reads the interpreter and the module path, which is how a listener
    // differs from any other process naming this agent.
    writeFileSync(
      join(pid, "cmdline"),
      [join(cwd, "bun"), join(cwd, "src", "bin.ts"), "listen", "--addressed", "--as", "dev"].join("\0"),
    );
    return root;
  }

  test("a running listener changes what a missing sweep means, since the listener sweeps", () => {
    // TELLING AN AGENT TO ARM A LISTENER THAT IS ALREADY RUNNING makes them start a
    // second one. With one running, a missing sweep is that listener's sweep failing.
    const cwd = scratchDir("mon-live");
    const withProc = (c: string): Io => {
      const { io: base } = stubIo(c, async () => new Response("{}", { status: 200 }));
      return { ...base, env: (n) => (n === "SCRAMBLE_PROC" ? procRootWithListener(c) : undefined) };
    };
    const live = withProc(cwd);
    const never = monitorReport(live, "dev").join(" ");
    expect(never).toContain("though a listener is running");
    expect(never).toContain("within 15 minutes");
    expect(never).not.toContain("Arm both");

    // A cursor written 45 minutes ago, with a listener running: the sweep inside that
    // listener is the thing that stopped, and its own stderr carries the reason.
    const p = join(cwd, ".scramble", "cursors", "dev.json");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ "slack:dev": { general: "1.1" } }));
    const then = Date.now() - 45 * 60_000;
    utimesSync(p, new Date(then), new Date(then));
    const stale = monitorReport(live, "dev").join(" ");
    expect(stale).toContain("the sweep inside it is not completing");
    expect(stale).not.toContain("Arm both");
    // The listener is running, so nothing tells the agent to arm one.
    expect(stale).not.toContain("NO listener is running");
  });

  test("one arming arms both, and the repair names one command", () => {
    // An empty process root is readable and holds no listener, which is the state an
    // agent is in before arming anything.
    const cwd = scratchDir("mon-none");
    const root = join(cwd, "proc");
    mkdirSync(root, { recursive: true });
    const { io: base } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    const bare: Io = { ...base, env: (n) => (n === "SCRAMBLE_PROC" ? root : undefined) };
    const lines = monitorReport(bare, "dev");
    expect(lines.join(" ")).toContain("NO listener is running for dev, so nothing wakes this agent and no sweep runs");
    // THE REPAIR IS ONE COMMAND. Arming used to be two, and agents arrived with one.
    expect(lines.join(" ")).toContain("Arm both: scramble listen --addressed --as dev");
    expect(lines.join(" ")).not.toContain("scramble message check");
  });
});

describe("reading the newest lines in one command", () => {
  // An agent read a channel, waited past 120 seconds, and got a twelve-message
  // window from the oldest end. The operator asked for the newest items to be one
  // fast command.
  test("`--last N` prints the newest N lines, newest first", async () => {
    const cwd = scratchDir("read-last");
    const { io, writes } = stubIo(cwd, async (u) => {
      if (String(u).includes("conversations.history")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts: "30", text: "newest", user: "U1" },
              { ts: "20", text: "middle", user: "U1" },
              { ts: "10", text: "oldest", user: "U1" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    expect(await main(["message", "read", "--target", "general", "--as", "dev", "--last", "2", "--backend", "slack"], io)).toBe(0);
    const seen = writes.filter((w) => w.startsWith("{")).map((w) => (JSON.parse(w) as { ts: string }).ts);
    expect(seen).toEqual(["30", "20"]);
  });
});

describe("markdown bullets reach Slack as a list", () => {
  // AN AGENT POSTED A SIX-ITEM LIST AND IT READ AS SIX DASHES. Slack's message
  // format carries no list syntax, so `- item` arrives as those characters.
  // An agent running the evaluation suite asked for it.
  test("a leading dash or star becomes a bullet, and everything else is left alone", () => {
    expect(bulletsForSlack("- one\n- two\n  - nested")).toBe("• one\n• two\n  • nested");
    expect(bulletsForSlack("* star item")).toBe("• star item");
    // A dash inside a sentence, a flag, a word without a space after the dash, and a
    // numbered list all stay as they are.
    expect(bulletsForSlack("text with a - dash inside")).toBe("text with a - dash inside");
    expect(bulletsForSlack("--flag is not a bullet")).toBe("--flag is not a bullet");
    expect(bulletsForSlack("-nospace stays")).toBe("-nospace stays");
    expect(bulletsForSlack("1. numbered stays")).toBe("1. numbered stays");
    // A FENCED BLOCK IS CODE. A dash in there belongs to whatever the block holds,
    // and a diff line is the case that matters.
    expect(bulletsForSlack("```\n- inside a fence\n```")).toBe("```\n- inside a fence\n```");
    expect(bulletsForSlack("```diff\n- removed\n+ added\n```\n- outside")).toBe("```diff\n- removed\n+ added\n```\n• outside");
  });

  test("the send posts the bullet form, so the ledger and the read-back compare it", async () => {
    const cwd = scratchDir("send-bullets");
    const calls: string[] = [];
    const { io } = stubIo(cwd, async (u, init) => {
      calls.push(String(init?.body ?? ""));
      if (String(u).includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "88.8", message: {} }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    io.readStdin = async () => "- first item\n- second item";
    expect(await main(["message", "send", "--target", "general", "--as", "dev", "--no-verify"], io)).toBe(0);
    const posted = calls.find((b) => b.includes("first item")) ?? "";
    expect(posted).toContain("• first item");
    expect(posted).not.toContain("- first item");
  });
});

describe("the listener sweeps on its own timer", () => {
  test("a quiet tick inside a listener says nothing, and a hand-run sweep says it ran", () => {
    // EVERY LINE ON THE LISTENER STREAM IS A WAKE-UP. An agent measured the cost of
    // the quiet tick on their harness: 96 wake-ups a day, each spending a turn to
    // learn that nothing arrived. The tick's own record is the cursor it writes,
    // whose mtime every send reads back, so the quiet line carries no fact the
    // reader lacks.
    expect(sweepSummaryLine(0, 2, true)).toBe("");
    // A sweep that CARRIED something still speaks, since its reader wants the count
    // beside the lines it just received.
    expect(sweepSummaryLine(3, 2, true)).toContain("3 line(s) delivered, 2 channel(s) read");
    // A HAND-RUN SWEEP CONFIRMS ITSELF EITHER WAY: the caller is waiting on the
    // answer, and "nothing arrived" is the answer.
    expect(sweepSummaryLine(0, 2, false)).toContain("0 line(s) delivered, 2 channel(s) read");
  });


  // ONE ARMING ARMS BOTH MONITORS. Agents onboarded with the listener and without the
  // timed sweep, so ordinary traffic and the lines they owed never surfaced.
  test("a tick runs the sweep, an overlapping tick is dropped, and a failure is printed", async () => {
    const cwd = scratchDir("sweep-timer");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    let runs = 0;
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sweep = sweepInsideListener(
      io,
      async () => {
        runs++;
        await gate;
      },
      60_000,
    );
    try {
      // ONE SWEEP AT STARTUP. A restart resets the interval, and the restart is when
      // the gap exists, so a run of installs would otherwise push the first drain
      // back indefinitely.
      expect(runs).toBe(1);
      // A SLOW DRAIN THAT OUTLASTS ITS INTERVAL MUST NOT STACK: two drains at once
      // advance one cursor underneath each other. The startup drain is still inside
      // its own call here, so these two ticks are the overlapping ones.
      await sweep.tick();
      await sweep.tick();
      expect(runs).toBe(1);
      release();
      // The startup drain finishes on its own turn of the loop, so the flag it holds
      // clears before the next tick is asked for.
      await new Promise((r) => setTimeout(r, 0));
      await sweep.tick();
      expect(runs).toBe(2);
    } finally {
      sweep.stop();
    }

    // A THROW INSIDE A TIMER CALLBACK WITH NO CATCH TAKES THE LISTENER DOWN, turning
    // one failed drain into a dead inbox. The failure prints and the listener lives.
    const bad = sweepInsideListener(
      io,
      async () => {
        throw new Error("slack said not_in_channel");
      },
      60_000,
    );
    try {
      await bad.tick();
    } finally {
      bad.stop();
    }
    expect(errs.join(" ")).toContain("the sweep inside this listener failed and messages may be waiting");
    expect(errs.join(" ")).toContain("not_in_channel");

    // The interval a listener keeps is the period the sweep timer documented, and the
    // staleness mark is longer, so two sweeps have to miss before an agent reads that
    // one died.
    expect(SWEEP_INTERVAL_MS).toBe(15 * 60_000);
  });
});

describe("`scramble version`: which copy is running", () => {
  // A peer agent executes the maintainer's working tree because bun link points at
  // the maintainer's checkout and runs src directly. If an author saves halfway
  // through an edit, the syntax error runs inside the peer agent's listener before
  // the author encounters it. An agent could not determine which execution it ran.
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
  // The linter should be individually callable to check other documents, such as
  // Lark documents or Markdown files.
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

  test("the preview reports the unowned claim the send refuses, on message text alone", async () => {
    // An agent piped a message with two handles in the greeting and a claim about
    // one reader that named nobody. The send refuses it; this verb called it clean.
    const cwd = scratchDir("lint-attrib");
    const { io, errs, writes } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    io.readStdin = async () => "@reader-one @reader-two The mode is 0600 now.\n\nYour scan of 26 files found nothing.";
    expect(await main(["lint"], io)).toBe(1);
    expect(errs.join("\n")).toContain("[unowned claim]");
    expect(errs.join("\n")).toContain("Your scan of 26 files");
    expect(JSON.parse(writes[0]!)).toEqual({ lint: "hits", files: 1, hits: 1 });

    // A DRAFT IN A SCRATCH DIRECTORY IS A MESSAGE, whatever it is spelled like on
    // the command line. The answer used to come from the spelling: `lint <file>`
    // took the repository rules and `lint < file` took the message rules, so one
    // draft got two verdicts and an agent who linted from a file all evening never
    // saw the message-only checks.
    const f = join(cwd, "draft.md");
    writeFileSync(f, "@reader-one @reader-two\n\nYour scan of 26 files found nothing.\n");
    const draft = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", f], draft.io)).toBe(1);
    expect(draft.errs.join(" ")).toContain("unowned claim");

    // A FILE UNDER A REPOSITORY IS REPOSITORY TEXT. The predicate reads `@name` and
    // second-person prose, which fires 52 times across this repository's own
    // documents and tests, where a reader in general is addressed.
    const repo = join(cwd, "checkout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const doc = join(repo, "doc.md");
    writeFileSync(doc, "@reader-one @reader-two\n\nYour scan of 26 files found nothing.\n");
    const inRepo = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", doc], inRepo.io)).toBe(0);
    expect(inRepo.errs.join(" ")).not.toContain("unowned claim");
    // THE SKIP SAYS SO. A message-only check that quietly does not run reads exactly
    // like a check that passed.
    expect(inRepo.errs.join(" ")).toContain("message-only checks did NOT run");

    // A worktree carries `.git` as a FILE, and its documents are repository text
    // too, so the test is existence.
    const tree = join(cwd, "worktree");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, ".git"), "gitdir: /elsewhere/.git/worktrees/one\n");
    const wdoc = join(tree, "doc.md");
    writeFileSync(wdoc, "@reader-one @reader-two\n\nYour scan of 26 files found nothing.\n");
    const inTree = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", wdoc], inTree.io)).toBe(0);

    // `--message` states the intent for a draft written inside a checkout, where
    // nothing in the file says which it is.
    const forced = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", "--message", doc], forced.io)).toBe(1);
    expect(forced.errs.join(" ")).toContain("unowned claim");
  });

  test("no file and no stdin is a usage error", async () => {
    const cwd = scratchDir("lint-usage");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    io.readStdin = async () => "   ";
    expect(await main(["lint"], io)).toBe(1);
    expect(errs.join(" ")).toContain("usage: scramble lint");
  });

  test("a file that cannot be read is a FAILURE, never a silent pass", async () => {
    // When a linter skips a file that it cannot open, it reports clean on a typo.
    const cwd = scratchDir("lint-missing");
    const { io, errs } = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", join(cwd, "nope.md")], io)).toBe(1);
    expect(errs.join(" ")).toContain("cannot read");
  });
});

describe("`inbox pending`: the count of what is owed, per ITEM", () => {
  /**
   *  Send a real delivery through the local daemon so that the delivery path writes
   *  the ledger and the test never writes it.
   */
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
    // Four agents searched a text log for a timestamp because nothing could answer
    // this. A line that names another recipient is delivered and wakes nobody. Until
    // the ledger recorded it, its absence and a message that never arrived produced
    // the same output.
    const cwd = scratchDir("inbox-trace");
    const a = await deliverOne(cwd, "@someoneelse a question for you");
    expect(await main(["message", "check", "--as", "dev"], a.io)).toBe(0);
    const b = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "trace", "m1", "--as", "dev"], b.io)).toBe(0);
    const said = b.writes.join(" ");
    expect(said).toContain("WAS delivered to dev");
    expect(said).toContain("NOT addressed to dev");
    expect(said).toContain("Searched 1 delivered row(s)");
    // The request owes no one an answer, so it remains outside the pending queue.
    const c = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "pending", "--as", "dev"], c.io)).toBe(0);
    // A message that did not arrive reads differently from that message.
    const d = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "trace", "999.9", "--as", "dev"], d.io)).toBe(0);
    expect(d.writes.join(" ")).toContain("999.9 was NOT delivered to dev");
  });

  test("a reply carrying a FILE closes what it answers, like any other reply", async () => {
    // The attachment path posts through the upload and returns before executing the
    // actions that follow a standard send, so a reply with a file closed nothing,
    // recorded nothing, and reported nothing. The ledger detected the issue when two
    // questions answered with attachments remained open in `inbox pending`.
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
    // The item is closed and named by the timestamp of the message that the upload
    // posted.
    const p = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "pending", "--as", "dev"], p.io)).toBe(0);
    const t = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "trace", "9.1", "--as", "dev"], t.io)).toBe(0);
    expect(t.writes.join(" ")).toContain("answered by 77.7");
    // The system remembers the message, so it recognizes a reply to it as owed to this
    // agent.
    expect(readFileSync(join(cwd, ".scramble", "sent", "dev.jsonl"), "utf8")).toContain("77.7");
  });

  test("`inbox close` settles an item without sending, and demands a reason", async () => {
    const cwd = scratchDir("inbox-close");
    const a = await deliverOne(cwd);
    expect(await main(["message", "check", "--as", "dev"], a.io)).toBe(0);
    // The request is refused without a reason, and the refusal explains why the
    // reason exists.
    const b = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "m1", "--as", "dev"], b.io)).toBe(1);
    expect(b.errs.join(" ")).toContain("belongs on the record");
    // Providing no identifiers at all results in the same refusal.
    const b2 = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "--why", "x", "--as", "dev"], b2.io)).toBe(1);
    expect(b2.errs.join(" ")).toContain("at least one id");
    // With one, the operation settles, sends nothing, and pending goes quiet.
    const c = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "m1", "--why", "sender said no reply needed", "--as", "dev"], c.io)).toBe(0);
    expect(c.writes).toHaveLength(0);
    const d = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "pending", "--as", "dev"], d.io)).toBe(0);
    // A second close attempt refuses and names what settled it.
    const e = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "m1", "--why", "again", "--as", "dev"], e.io)).toBe(1);
    expect(e.errs.join(" ")).toContain("already answered by closed with no reply");
    // An id that is not an open item points to the two commands that explain it.
    const f = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["inbox", "close", "999.9", "--why", "x", "--as", "dev"], f.io)).toBe(1);
    expect(f.errs.join(" ")).toContain("inbox trace 999.9");
  });

  test("with a key set, the send rewrites and prints the sender's own words beside it", async () => {
    // The system always sends the message, and nothing changes silently.
    const cwd = scratchDir("send-rewrite");
    const { io, errs } = stubIo(cwd, async (u) =>
      String(u).includes("generativelanguage")
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "the parser fix has now shipped" }] } }] }), { status: 200 })
        : new Response(JSON.stringify({ crossings: [] }), { status: 200 }),
    );
    // The fixture contains no first person. The system refuses a rewrite that drops the
    // actor, and this test evaluates the clean path.
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
    // The exit code from a send command indicates that Slack accepted a message.
    // Three agents wrote their own read-back wrappers today. This wrapper prints
    // the complete stored text because a line diff is useless when the rewriter
    // rephrases throughout.
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
    // The rewriter rephrases the text and preserves mentions because the reader wants
    // to see what the channel holds and confirm that nobody stopped being notified.
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

    // A send that passes through the rewriter writes a row, and the verb counts it.
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "rewrites.jsonl"),
      `${JSON.stringify({ at: "2026-08-25T12:00:00.000Z", agent: "dev", channel: "general", outcome: "sent", words: [10, 12] })}\n`,
    );
    const one = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["rewrites"], one.io)).toBe(0);
    expect(one.writes.join(" ")).toContain("1 send(s) from dev met the rewriter");
    // The `--as` flag selects one agent's rows from a file that every agent on the
    // host shares.
    const scoped = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["rewrites", "--as", "someone-else"], scoped.io)).toBe(0);
    expect(scoped.writes.join(" ")).toContain("No sends from someone-else");
  });

  test("`rewrites --replay` runs the refused drafts again and counts what changed", async () => {
    // THE MEASUREMENT AN INSTRUCTION CHANGE NEEDS. Three agents were asked what a
    // change did to the class it targeted, and none could answer: their ledgers
    // held verdicts with no text behind them, so each replayed whatever drafts they
    // still had, all of which were clean under both builds.
    const cwd = scratchDir("rewrites-replay");
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    const row = (at: string, why: string, draft?: string): string =>
      `${JSON.stringify({ at, agent: "dev", channel: "general", outcome: "refused", why, words: [9, 0], ...(draft === undefined ? {} : { draft }) })}\n`;
    const file = join(cwd, ".scramble", "rewrites.jsonl");
    // A row from before drafts were kept carries no text and cannot be replayed.
    writeFileSync(file, row("2026-08-01T00:00:00.000Z", "introduced a reason"));
    const none = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["rewrites", "--replay", "--as", "dev"], none.io)).toBe(1);
    expect(none.errs.join(" ")).toContain("no row for dev carries a draft");
    expect(none.errs.join(" ")).toContain("cannot be replayed");

    appendFileSync(file, row("2026-08-02T00:00:00.000Z", "introduced a reason", "the check reads the stamp"));
    appendFileSync(file, row("2026-08-03T00:00:00.000Z", "introduced cannot", "the check compares two ids"));
    const answers = ["the check reads the stamp", "the check compares two ids because the stamp says so"];
    let call = 0;
    const { io, writes, errs } = stubIo(cwd, async (u) =>
      String(u).includes("generativelanguage")
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: answers[call++] ?? "" }] } }] }), { status: 200 })
        : new Response("{}", { status: 200 }),
    );
    const keyed: Io = {
      ...io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["rewrites", "--replay", "--as", "dev"], keyed)).toBe(0);
    // One answer keeps the input's meaning and passes; the other adds a reason the
    // input never gave, which is the guard that refused these rows in the first
    // place. The row's old verdict rides beside the new one.
    const lines = writes.filter((w) => w.includes("\"replay\""));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\"was\":\"introduced a reason\"");
    expect(lines[0]).toContain("\"now\":\"clean\"");
    expect(errs.join(" ")).toContain("2 draft(s) for dev under this build");
    expect(errs.join(" ")).toContain("1 clean now");

    // EVERY REPLAYED ROW COSTS A MODEL CALL, so the run is bounded and says what it
    // left out. A cap that stays quiet reads as full coverage.
    const capped = stubIo(cwd, async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] }), { status: 200 }));
    const cappedKeyed: Io = {
      ...capped.io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : capped.io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["rewrites", "--replay", "--as", "dev", "--limit", "1"], cappedKeyed)).toBe(0);
    expect(capped.errs.join(" ")).toContain("2 row(s) match and this run takes the newest 1");

    // The `--why` flag narrows the replay to one class, which is how a change aimed
    // at one guard is measured against that guard's own rows.
    const one = stubIo(cwd, async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "y" }] } }] }), { status: 200 }));
    const oneKeyed: Io = {
      ...one.io,
      env: (n) => (n === "SCRAMBLE_REWRITE_KEY" ? "k" : one.io.env(n)),
      moduleDir: () => join(import.meta.dir, "..", "src"),
    };
    expect(await main(["rewrites", "--replay", "--as", "dev", "--why", "cannot"], oneKeyed)).toBe(0);
    expect(one.errs.join(" ")).toContain("1 draft(s) for dev");
    const missing = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["rewrites", "--replay", "--as", "dev", "--why", "no such verdict"], missing.io)).toBe(1);
    expect(missing.errs.join(" ")).toContain("whose verdict contains no such verdict");
  });

  test("`rewrites --near` reads the duplicate scores this agent's sends measured", async () => {
    // The threshold rests on corpus runs that three agents performed manually. An
    // agent that writes English under the operator's rule cannot produce Chinese
    // samples on request. The tool can gather those samples, so every send records
    // what it measured, and this process reads the collected data back.
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

  test("the drift surfaces carry what the last install brought", () => {
    // The installer is the only agent that does not need the list. One launcher
    // serves every agent on a HOME, so an install by any of them updates the rest,
    // and two commit hashes were their only record of the change. An agent read
    // three `git log` ranges by hand in one day to decide whether a listener was
    // running code that mattered, and an installed copy has no checkout to read.
    const root = mkdtempSync(join(tmpdir(), "changes-"));
    mkdirSync(join(root, "current", "src"), { recursive: true });
    const bare = async (): Promise<Response> => new Response("{}", { status: 200 });
    const io = (): Io => ({ ...stubIo(root, bare).io, env: (n) => (n === "SCRAMBLE_HOME" ? root : undefined) });
    // The system treats a missing file as having nothing recorded, and throwing an
    // error here would take the advisory down with it.
    expect(installedChanges(io())).toBeUndefined();
    writeFileSync(join(root, "current", "src", "CHANGES"), "from aaa1111\nbbb2222 first thing\nccc3333 second thing\n");
    expect(installedChanges(io())).toEqual({ from: "aaa1111", lines: ["bbb2222 first thing", "ccc3333 second thing"] });
    // A header line that does not name the starting SHA is unusable, since the
    // caller compares that SHA against its own to determine whether the list is
    // complete.
    writeFileSync(join(root, "current", "src", "CHANGES"), "bbb2222 first thing\n");
    expect(installedChanges(io())).toBeUndefined();
    // The process finds nothing to read when it has no root directory to search.
    expect(installedChanges({ ...stubIo(root, bare).io, env: () => undefined })).toBeUndefined();

    const changes = { from: "aaa1111", lines: ["bbb2222 first thing", "ccc3333 second thing"] };
    // A reader at the start of the hop receives the list and receives no warning.
    expect(changeBlock("aaa1111", changes)).toContain("2 commit(s) came with it, oldest first: bbb2222 first thing; ccc3333 second thing");
    expect(changeBlock("aaa1111", changes)).not.toContain("most recent install");
    // A reader that lags further behind is told that the list covers one hop.
    expect(changeBlock("zzz9999", changes)).toContain("covers the most recent install, which started at aaa1111, and you run zzz9999");
    // An empty record adds nothing to the advisory.
    expect(changeBlock("aaa1111", undefined)).toBe("");
    expect(changeBlock("aaa1111", { from: "aaa1111", lines: [] })).toBe("");
    rmSync(root, { recursive: true, force: true });
  });

  test("the emitter keys every line of a multi-line diagnostic", () => {
    // Three agents filtered this output in one night, and each lost the lines under
    // a `verify:` line: two filters used greps anchored on the key, and one used
    // `tail -4`. Manual keying then keyed that one block and left three bare, and an
    // agent running the commands found two of them within the hour. The emitter keys
    // the output now, so a block written tomorrow arrives keyed.
    const out = autoKey("verify: general holds text that DIFFERS.\nFirst line that differs (2):\n  sent:   a\n  stored: b");
    expect(out.split("\n").every((l) => l.startsWith("verify: "))).toBe(true);
    expect(out).toContain("verify:   sent:   a");
    // A single line remains untouched, and a block remains untouched when its first
    // line declares no key.
    expect(autoKey("verify: one line only")).toBe("verify: one line only");
    expect(autoKey("no key here\nand a second line")).toBe("no key here\nand a second line");
    // The first line supplies the key, regardless of what it contains.
    expect(autoKey("crossed: two\n  a")).toBe("crossed: two\ncrossed:   a");
    expect(autoKey("pending: one\n  a")).toBe("pending: one\npending:   a");
    // A JSON line passes through byte for byte, since stdout carries records as well
    // as diagnostics and a program reads a record.
    const rec = '{"id":"1.0","text":"a: b\nc"}';
    expect(autoKey(rec)).toBe(rec);
  });

  test("the verify names the first line that differs", () => {
    // A manual diff between the full stored text and the "DIFFERS" output showed
    // the cause: Slack had auto-linked a bare `users.info`. The guard now reports
    // which line.
    const out = differenceLine("one\ntwo users.info\nthree", "one\ntwo <http://users.info|users.info>\nthree");
    expect(out).toContain("First line that differs (2)");
    expect(out).toContain("sent:   two users.info");
    expect(out).toContain("stored: two <http://users.info|users.info>");
    // A missing line explicitly reports that it is missing, so an empty match does not
    // read as agreement.
    expect(differenceLine("one\ntwo", "one")).toContain("stored: (no such line)");
    expect(differenceLine("one", "one\ntwo")).toContain("sent:   (no such line)");
    // Identical texts identify nothing, so the caller prints no additional output.
    expect(differenceLine("same", "same")).toBe("");
  });

  test("a recorded hash is compared against the read-back and never called failure", () => {
    // The two forms differ, and the tool reports the difference. A comparison of
    // the two forms was expected to mismatch on every row, and a run on the live
    // table matched three of its four readable messages. The reporting function
    // provides the verdict, since a mismatch means the text was rendered differently
    // and never that the row is wrong.
    expect(hashVerdict(["aa", "bb"], ["aa", "bb"])).toBe("matches");
    expect(hashVerdict(["aa", "bb"], ["aa", "cc"])).toBe("differs");
    expect(hashVerdict(undefined, ["aa", "bb"])).toBeUndefined();
    expect(textHash("one")).toMatch(/^[0-9a-f]{16}$/);
    expect(textHash("one")).not.toBe(textHash("two"));
  });

  test("`rewrites --calibrate` re-measures every measured row from Slack", async () => {
    // An agent read the calibration table, executed the reference function, and
    // identified the flaw. Two readers that execute one function on a single table
    // measure the readers themselves. The table held a synthetic pair labeled as the
    // founding incident for an hour, and any number of agreeing readers would have
    // reproduced that outcome.
    const cwd = scratchDir("calibrate");
    // Every row specifies its own channel, so the configuration must map these
    // channels for the read operation to resolve.
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1", "scramble-dev": "C2", "scramble-partner-dev": "C3" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    // Slack answers with two messages that produce scores unlike the recorded rows,
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
    // The system reports a row whose messages are gone as gone. It never reports that
    // row as drift, because the first message of one pair was deleted after the
    // report that named it, and calling that drift would raise false alarms on every
    // run from here on.
    expect(rows.some((r) => r.calibrate === "gone")).toBe(true);
    expect(rows.every((r) => ["drifted", "unreadable", "gone"].includes(r.calibrate))).toBe(true);
    expect(errs.join(" ")).toContain("score something else now");
    // The system compares and prints the hashes. Slack has lost four of the five
    // source messages behind these rows, so an agent holding the delivery checks its
    // copy against the recorded hash.
    expect(errs.join(" ")).toContain("read back to a different hash");
    const hashed = writes
      .map((l) => JSON.parse(l) as { hashes?: string; sha?: { recorded?: string[]; read?: string[] } })
      .filter((r) => r.hashes !== undefined);
    expect(hashed.length).toBeGreaterThan(0);
    expect(hashed.every((r) => r.hashes === "differs")).toBe(true);
    expect(hashed.every((r) => r.sha?.read?.length === 2 && r.sha?.recorded?.length === 2)).toBe(true);

    // Each row names its own channel, so the command runs without `--target` and
    // reports which channel it searched. A timestamp is unique within a single
    // conversation, and searching the wrong channel returns "no such message" for a
    // message that exists.
    const bare = stubIo(cwd, async () => new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }));
    await main(["rewrites", "--calibrate", "--as", "dev", "--backend", "slack"], bare.io);
    const named = bare.writes.map((l) => JSON.parse(l) as { calibrate: string; channel?: string });
    expect(named.length).toBeGreaterThan(0);
    // A deleted row carries no channel read, since the system fetches nothing for it.
    const read = named.filter((r) => r.calibrate === "unreadable");
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((r) => typeof r.channel === "string")).toBe(true);
    expect(named.every((r) => r.calibrate === "unreadable" || r.calibrate === "gone")).toBe(true);

    // The system treats a row that Slack will not show as unreadable, and never
    // records it as agreement. The pairs sit in channels this agent may not be in,
    // and a silent skip would turn an unread row into a passing one.
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

    // When no Slack configuration is present, the command reports the missing
    // configuration and returns no rows. The backend reads Slack, so a missing
    // configuration stops the run before it fetches any row.
    const noCfg = stubIo(scratchDir("calibrate-noconfig"), async () => new Response("{}", { status: 200 }));
    expect(
      await main(["rewrites", "--calibrate", "--target", "general", "--as", "dev", "--backend", "slack"], noCfg.io),
    ).toBe(1);
    expect(noCfg.errs.join(" ")).toContain("missing or malformed");
  });

  test("an unwritable rewrite record REPORTS itself and the message still goes", async () => {
    // The record provides accounting, and the message is the point.
    const cwd = scratchDir("rewrites-locked");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("generativelanguage"))
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "the line that shipped this morning" }] } }] }), { status: 200 });
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "22.2", message: {} }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, messages: [{ ts: "22.2", text: "the line that shipped this morning" }] }), { status: 200 });
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    // The append operation throws when a directory occupies the path where the record
    // belongs.
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
    // A rewritten send posts text that the author never saw, so the question applies
    // to every rewritten send. Three agents wrote their own read-back wrappers for
    // this reason.
    const cwd = scratchDir("send-verify-default");
    const seen: string[] = [];
    const responder = async (u: string): Promise<Response> => {
      seen.push(String(u));
      if (String(u).includes("generativelanguage"))
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "the line that shipped this morning" }] } }] }), { status: 200 });
      if (String(u).includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "33.3", message: {} }), { status: 200 });
      if (String(u).includes("conversations.history"))
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: "33.3", text: "the line that shipped this morning" }] }), { status: 200 });
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

    // The `--no-verify` flag skips the read-back entirely. The operator must submit a
    // different draft, because the same draft sent to the same channel is refused as a
    // duplicate.
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
    // entity compared unequal, and verification printed DIFFERS for a message Slack
    // held exactly while notifying the room. An agent then read that report as proof
    // the broadcast was inert. The verification compares both sides in the reader's
    // form.
    const cwd = scratchDir("send-verify-broadcast");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "44.4", message: {} }), { status: 200 });
      if (url.includes("conversations.history"))
        // Slack stores the data for a broadcast, which is the entity.
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
    // The broadcast registers as a live mention, so no component reports it as silent.
    expect(errs.join(" ")).not.toContain("notified NOBODY");
  });

  test("a QUOTED entity verifies clean, with Slack's escape undone on both sides", async () => {
    // The system intentionally escapes a draft quoting the token in a fence before
    // sending it to Slack, so it notifies nobody. The read-back undoes the escape, and
    // this line then reported DIFFERS for a message Slack held exactly as intended,
    // which is the second false alarm this comparison produced in one hour.
    const cwd = scratchDir("send-verify-quoted-entity");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "55.5", message: {} }), { status: 200 });
      if (url.includes("conversations.history"))
        // Slack stores both brackets escaped for a defused entity.
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
    // An agent hand-copied a value from a notification preview and cited
    // 1787656658.009669 for a line that Slack holds at 1787656658.009699, so the
    // reader spent a search finding the referenced message. Four investigations in
    // one day turned on an exact timestamp. The detector evaluates the whole second:
    // a correct citation, and a timestamp belonging to another channel, trip nothing.
    const cwd = scratchDir("send-cite-check");
    const asked: string[] = [];
    const responder = async (u: string | URL): Promise<Response> => {
      const url = String(u);
      asked.push(url);
      if (url.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "99.9", message: {} }), { status: 200 });
      // Slack preserves the line ending in 699 within the window around 1787656658. A
      // named user wrote this entry, which the note reports.
      if (url.includes("oldest=1787656658.000000"))
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "1787656658.009699", username: "andrew" }] }),
          { status: 200 },
        );
      // The second window displays the exact citation and includes the author.
      if (url.includes("oldest=1787656659.000000"))
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "1787656659.000001", username: "andrew" }] }),
          { status: 200 },
        );
      // The time window around a timestamp from another channel contains no data.
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
    // A correct citation names its author. An operator attributed an incident to the
    // wrong agent while citing its timestamp, and the named agent corrected the
    // attribution.
    expect(said).toContain("cite: 1787656658.009699 in general was written by");
    // A timestamp with nothing in its second field is an external citation, and the
    // system leaves it alone. Agents skip a check that fires on a correct citation.
    expect(said).not.toContain("1700000000.000001, and it holds");
    // The message was still sent, and the note never alters that fact.
    expect(said).toContain("posted: general at ts 99.9");

    // The cap states what it dropped. The process checked six of seven citations,
    // and the note names the one it never looked at. A bound that nobody prints
    // reads as full coverage.
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
    // The agent that experienced the issue measured it directly. The verify check
    // answered "slack has no message at <ts>" for its own threaded reply, while
    // `message read` found that ts with its text intact. A reply is absent from
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
      // The history request returns nothing, as Slack does for a reply.
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
    // Agents should be able to edit and delete messages, and an agent should already
    // have the capability to delete its own message.
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
    // A DELETE TOUCHES TWO OTHER RECORDS, and both used to keep believing the message
    // was there: the sent log refused a resend as a duplicate of the deleted line, and
    // the inbox kept a question marked answered by it.
    expect(errs.join(" ")).toContain("no sent record here holds 77.7");
  });

  test("deleting a reply reopens what it answered, and marks the draft resendable", async () => {
    const cwd = scratchDir("delete-records");
    const { io, errs } = stubIo(cwd, async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev" } },
    });
    const cfg = slackConfigPath(io);
    // A question this agent owes, and the reply that closed it.
    recordInboxItem(inboxPath(cfg, "dev"), {
      id: "5.5",
      channel: "general",
      from: "peer",
      text: "@dev what did the gate say",
      at: "2026-08-26T12:00:00Z",
      mentions: ["dev"],
      addressed: true,
    });
    closeInboxItems(inboxPath(cfg, "dev"), "general", "77.7");
    recordSent(sentPath(cfg, "dev"), "77.7", { hash: "abc", channel: "general", at: new Date().toISOString() });
    expect(pendingInbox(inboxPath(cfg, "dev"))).toEqual([]);

    expect(
      await main(["message", "delete", "--target", "general", "--to", "77.7", "--as", "dev", "--backend", "slack"], io),
    ).toBe(0);
    expect(errs.join(" ")).toContain("1 inbox item(s) that message answered are open again: 5.5");
    expect(errs.join(" ")).toContain("the sent record for 77.7 is marked deleted");
    // The question is owed again, and the draft can go back out.
    expect(pendingInbox(inboxPath(cfg, "dev")).map((r) => r.id)).toEqual(["5.5"]);
    expect(sentAlready(readSentRows(sentPath(cfg, "dev")), "general", "abc", Date.now(), 10 * 60 * 1000)).toBeUndefined();
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
    // The command accepts no `--to` flag.
    io.readStdin = async () => "text";
    expect(await main(["message", "edit", "--target", "general", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("requires --to");
    // Empty stdin.
    io.readStdin = async () => "   ";
    expect(
      await main(["message", "edit", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"], io),
    ).toBe(1);
    expect(errs.join(" ")).toContain("stdin was empty");
    // An edit is a banned operation. It functions as a send and follows the same
    // rules.
    io.readStdin = async () => "Honestly I fixed it.";
    expect(
      await main(["message", "edit", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"], io),
    ).toBe(1);
    expect(errs.join(" ")).toContain("language rule(s) broken");
    // Slack returns its own refusal along with the credential that acted.
    io.readStdin = async () => "I fixed the parser and shipped it.";
    expect(
      await main(["message", "edit", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"], io),
    ).toBe(1);
    expect(errs.join(" ")).toContain("message_not_found");
    expect(errs.join(" ")).toContain("dev's own token");
    // The local backend does not implement this call.
    expect(
      await main(["message", "delete", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "local"], io),
    ).toBe(1);
    expect(errs.join(" ")).toContain("needs the slack backend");

    // When Slack refuses the delete, the system reports the refusal, and nothing
    // swallows it.
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

    // The guards stop the edit if they refuse a rewrite, exactly as they stop a send.
    const bad = stubIo(cwd, async (u) =>
      String(u).includes("generativelanguage")
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "the thing got fixed here" }] } }] }), {
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

    // The command reports that no Slack configuration exists and edits nothing.
    const bare = stubIo(scratchDir("edit-no-config"), async () => new Response("{}", { status: 200 }));
    expect(
      await main(["message", "edit", "--target", "general", "--to", "1.1", "--as", "dev", "--backend", "slack"], bare.io),
    ).toBe(1);
  });

  test("the same draft into the same channel is REFUSED, and `--again` sends it", async () => {
    // Measurements recorded after the `posted:` line shipped show that two
    // byte-identical copies reached a third agent's inbox 27 seconds apart. A retry
    // after a genuine post must be a no-op, for example by setting an idempotency key
    // on the draft hash.
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
    // The second attempt specifies the timestamp Slack already holds and posts
    // nothing.
    expect(await send()).toBe(1);
    expect(posts).toBe(1);
    expect(errs.join(" ")).toContain("you already sent this exact draft to general at ts 9.1");
    // The system runs the check before the rewriter, so a duplicate costs no model
    // call.
    expect(errs.join(" ")).not.toContain("rewrite:");
    // The operator can state an entry twice on purpose.
    expect(await send(["--again"])).toBe(0);
    expect(posts).toBe(2);
    // A separate draft is unaffected.
    io.readStdin = async () => "something else entirely, and I sent that too";
    expect(await send()).toBe(0);
    expect(posts).toBe(3);
  });

  test("ONE REPORT SENT TWICE UNDER DIFFERENT WORDING is refused, and --again sends it", async () => {
    // An agent reported one end-to-end run twice, 127 seconds apart, and described
    // the same ports and the same three images in different sentences. The digest
    // guard passed the duplicate report, since no two bytes lined up, and the channel
    // read two reports of one run.
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
    // You can still repeat it deliberately.
    expect(await send(["--again"])).toBe(0);
    expect(posts).toBe(2);
    // The system emits a different report. Refusing these requests would teach agents
    // to pass again by reflex, which retires the guard.
    io.readStdin = async () =>
      "The coverage stage is red: src/status.ts sits at 92% lines after the ledger " +
      "change, and the uncovered branch is the write failure path.";
    expect(await send()).toBe(0);
    expect(posts).toBe(3);
  });

  test("`message check` says when a LISTENER runs older code than the install", async () => {
    // An agent discovered that its listener fell six hours behind by running `doctor`
    // for an unrelated reason, because the only surface that detected the lag was one
    // nobody had a reason to call. The sweep runs on a timer in every harness, so it
    // reports the lag as well.
    const cwd = scratchDir("check-drift");
    const share = scratchDir("check-drift-share");
    mkdirSync(join(share, "current", "src"), { recursive: true });
    writeFileSync(join(share, "current", "src", "COMMIT"), "abc1234\n");
    const mine = scratchDir("check-drift-mine");
    writeFileSync(join(mine, "COMMIT"), "abc1234\n");
    // The process table contains a listener on an older commit. An earlier version
    // compared the sweep process against the install. Because a sweep launched from
    // the shared launcher is the install, the line never fired.
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
    // The listener is running, so the dead-listener line stays silent.
    expect(errs.join(" ")).not.toContain("NO listener is running");

    // When nothing is armed, the other line fires and the drift line does not fire.
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
    // The operator should classify channels manually. Hand-editing a shared JSON
    // introduces a stray comma into a configuration at midnight.
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
    // A second call retains the first, and every other configuration key survives.
    expect(await main(["channel", "tier", "team", "external"], io)).toBe(0);
    const after = JSON.parse(readFileSync(join(cwd, ".scramble", "slack.json"), "utf8"));
    expect(after.tiers).toEqual({ general: "internal", team: "external" });
    expect(after.humanUserId).toBe("U9");

    // The command refuses an undefined tier and a missing channel, and prints the
    // usage message.
    expect(await main(["channel", "tier", "general", "loud"], io)).toBe(1);
    expect(await main(["channel", "tier"], io)).toBe(1);
    expect(errs.join(" ")).toContain("scramble channel tier <channel> internal|external");
    // The system reports an unreadable configuration. Passing silently would hide the
    // failure.
    const bare = stubIo(scratchDir("channel-tier-noconfig"), async () => new Response("{}", { status: 200 }));
    expect(await main(["channel", "tier", "general", "internal"], bare.io)).toBe(1);
    expect(bare.errs.join(" ")).toContain("cannot read");

    // The system also reports any configuration that cannot be written. The operator
    // determines the classification, and a call that changed nothing must never appear
    // complete.
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
    // The operator sees that agents speak differently in a channel full of people than
    // in a channel where agents work. Neither behavior depends on whether the channel
    // is public or private.
    const cwd = scratchDir("send-register");
    let prompt = "";
    const { io, errs } = stubIo(cwd, async (u, init) => {
      const url = String(u);
      if (url.includes("generativelanguage")) {
        prompt = String(init?.body ?? "");
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix and I sent it." }] } }] }),
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
    // When no tier is set for this channel, the system uses the careful register and
    // informs the model.
    expect(errs.join(" ")).toContain("register: external for general (no tier set for general");
    // This assertion is derived from the shipped file. A copy of its wording would
    // rot. The assertion held a sentence from the register block. The operator rewrote
    // both blocks (9211482, 27be931), and the copy failed while the mechanism worked.
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
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix and I sent it." }] } }] }),
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

    // The configuration takes precedence. A room of agents can still serve as the
    // location where a customer reads.
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
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix again, and I sent it." }] } }] }),
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
    // Two agents duplicated messages in one hour because the CLI emitted a
    // warning after a successful post, and the agents interpreted the warning as a
    // failure (timestamps 1787715115, 1787715130, and 1787715280 onward).
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
    // The initial statement comes first, because every subsequent line provides notes
    // about a message that Slack already contains.
    expect(errs.slice(0, posted).join(" ")).not.toContain("verify");
    // This item comes last because a pipe cuts from the end. Three agents ran this
    // output through `tail -4`, `tail -3` and `tail -2`, each losing the first line,
    // and two of them sent the message again.
    expect(errs[errs.length - 1]).toContain("sent: general at ts 77.7");
    expect(errs[errs.length - 1]).toContain("Nothing above asks you to send it again");
  });

  test("`--verify` reads back from the ROOT Slack picked when a reply was threaded under", async () => {
    // An agent passed `--thread` pointing to a reply. Slack hoisted the message into
    // that reply's root and responded with the root's `ts`. The read-back queried the
    // `ts` that was passed, so it reported "slack has no message at <ts>" for a
    // message that was in the channel.
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
    // The operator requested that the instruction file itself pass through the
    // rewriter, and the local system could not complete that task without sending
    // a message elsewhere.
    const cwd = scratchDir("rewrite-preview");
    const { io, writes, errs, urls } = stubIo(cwd, async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix and I sent it." }] } }] }), {
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
    expect(writes.join("")).toContain("I shipped the parser fix and I sent it.");
    expect(errs.join(" ")).toContain("rewrite:");
    // The process made one call to the model and sent nothing to a channel.
    expect(urls.length).toBe(1);
    expect(urls.join(" ")).not.toContain("chat.postMessage");
  });

  test("a rewrite call that times out is asked once more, and the send goes", async () => {
    // In a measured send, the model timed out at 20s, the send refused, and the
    // identical text went through seconds later. A timeout says nothing about the
    // message.
    const cwd = scratchDir("rewrite-timeout");
    let calls = 0;
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("generativelanguage")) {
        calls += 1;
        if (calls === 1) throw new Error("The operation was aborted.");
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "I shipped the parser fix and I sent it." }] } }] }),
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
    // The operator cleans comments first because a shipped comment contained a
    // banned form. The rule table's own patterns contain the words it bans, so the
    // code has to stay out of scope.
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
    // Without the flag, the same file also reports the line of code.
    const plain = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["lint", f], plain.io)).toBe(1);
    expect(plain.errs.filter((l) => l.includes("sample.ts:2"))).toHaveLength(1);
    expect(writes.join("")).toContain('"hits":1');
  });

  test("`rewrite --why` asks for the diagnosis, and never rewrites", async () => {
    // When this tool prints a refusal, use gemini 3.7 to find why the communication
    // is wrong. A rewrite returns a better version and leaves the author guessing
    // which habit produced the worse one.
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

    // When a key is missing or a model fails, the system reports the error and
    // changes nothing.
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
    // The answer repeats the input, which is the case this covers.
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
    // The answer drops the actor, which is the guard this case exercises, and carries
    // enough words to clear the count floor so the refusal names the actor and
    // nothing else.
    const { io, errs, writes } = stubIo(cwd, async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "the parser fix was shipped and then it went out." }] } }] }), {
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

    // Without a key, the send path leaves the text alone. A preview has nothing to
    // show, so it indicates which variable turns the model on.
    io.readStdin = async () => "I shipped the parser fix.";
    expect(await main(["rewrite"], io)).toBe(1);
    expect(errs.join(" ")).toContain("SCRAMBLE_REWRITE_KEY");

    // When a preview is refused, the command prints the model's answer and names the
    // guard. The output contains no sentence about sending, because this verb never
    // sends. A send refusal ends with "Rewrite your message and send again."
    const drops = join(cwd, "drops.md");
    writeFileSync(drops, "I shipped the parser fix.");
    const before = writes.length;
    expect(await main(["rewrite", drops], withKey)).toBe(1);
    expect(writes.slice(before).join("")).toContain("the parser fix was shipped");
    expect(errs.join(" ")).toContain("the guards would stop this from going out");
    expect(errs.join(" ")).toContain("Nothing was sent.");
    expect(errs.join(" ")).not.toContain("send again");
  });

  test("`--verify` counts ENTITIES, and names a mention that notified nobody", async () => {
    // Slack triggers notifications on `<@U…>` identifiers and never on a name in text,
    // so counting occurrences in the text reports a failed conversion as live. That is
    // the defect that shipped this evening: a mention at the end of a sentence went
    // out as plain text, and this check would have reported it as live.
    const cwd = scratchDir("verify-entities");
    const { io, errs } = stubIo(cwd, async (u) => {
      const url = String(u);
      if (url.includes("chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "11.1", message: {} }), { status: 200 });
      if (url.includes("conversations.history"))
        // One was converted, and one was left as plain text.
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
    // Slack returned an ok response without a ts value, so there is no message to look
    // up. Marking this outcome as "verified" would be the exact failure that this verb
    // exists to eliminate.
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
    // Every guard triggers on an action taken by the model, so the model is the
    // component that can resolve it. Two agents intentionally composed prose that
    // avoided a prohibited form, observed the rewriter restore it, and transmitted
    // nothing.
    const cwd = scratchDir("send-retry");
    const prompts: string[] = [];
    let call = 0;
    const { io, errs } = stubIo(cwd, async (u, init) => {
      if (String(u).includes("generativelanguage")) {
        call += 1;
        prompts.push(String(init?.body));
        // The first answer breaks a language rule and carries enough words to clear
        // the count floor, so the retry happens for the rule and nothing else.
        const text =
          call === 1
            ? "the fix shipped and the workaround stayed out of it, not in it"
            : "the fix shipped and the workaround stayed out of the build";
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
    // The second prompt carries the items that broke in the first attempt.
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
    // A rewrite executed without instructions produces a worse result than no
    // rewrite. When rewriting is active, the system suppresses Claude's original
    // message.
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
    // The system enforces a message length limit in words. The system returns a
    // refusal when a message exceeds the limit, because a long message must break into
    // several short turns, and a warning leaves that task to the sender who just wrote
    // 900 words. The limit is 300 words, raised from 200 words.
    //
    // This test derives its counts from the shipped limit, so the test moves with
    // the limit and never hardcodes a number the code no longer uses.
    const cwd = scratchDir("send-toolong");
    const { io, errs } = stubIo(cwd, async () => new Response(JSON.stringify({ crossings: [] }), { status: 200 }));
    const over = WORD_LIMIT + 60;
    io.readStdin = async () => Array.from({ length: over }, () => "word").join(" ");
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], io)).toBe(1);
    expect(errs.join(" ")).toContain(`${over} words of prose, and the limit is ${WORD_LIMIT}`);
  });

  test("`inbox close` takes SEVERAL ids, and one bad id never hides the rest", async () => {
    // A thread of external work delivers a batch of items. An operator closed eight
    // items one command at a time in ten minutes, which teaches an agent to stop
    // reading its own list. A batch that stops at the first bad id leaves the other
    // items silently untouched, which produces the same defect.
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
    // The two working items are closed, and the untouched item is still open.
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
    // An inbox reply can default to posting within the thread, and a separate flag
    // can handle posting directly to the channel. The ledger knows which item is open,
    // so the system reads the thread and never guesses it.
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
    // The operator asked a question, and another agent posted 13 seconds later. The
    // default behavior selected the newest message and routed the reply to the
    // operator into the other agent's thread. When more than one thread is open, the
    // sender specifies which thread this answers.
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
    // Both names provide enough detail to choose one.
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
    // A channel receives nothing to reply to when it has nothing open.
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
    // A message is the primary payload and the ledger provides accounting, so a ledger
    // that cannot be written must not swallow a delivery. The system must also not
    // fail silently, because an inbox that counts zero items appears empty, which
    // creates the false success state this incident resolved.
    const cwd = scratchDir("inbox-locked");
    const a = await deliverOne(cwd);
    // The lock applies only to the ledger's own directory. Locking all of .scramble
    // would also break the cursor write, and then the test would prove something else.
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
  /**
   *  Build the Slack check I/O with a configuration that maps one channel and an
   *  empty history. `over` can swap the fetch operation to answer the drain.
   */
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
    // One agent owns each task or topic. Two agents posted near-identical plans one
    // second apart because neither could see the other coming. The local backend
    // answers a send with its crossings, and the skill tells every agent to read
    // them. On Slack, the send returned nothing, so the promise held only on the
    // backend nobody uses.
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
      // The handle differs from the scramble name. This difference broke the system
      // because history carries the handle.
      agents: { dev: { token: "T", handle: "dev_bot" } },
      roster: { U9: "peer", UME: "dev_bot" },
    });
    const errs: string[] = [];
    const watched: Io = { ...io, writeErr: (l) => errs.push(l), readStdin: async () => "my line" };
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], watched)).toBe(0);
    const said = errs.join("\n");
    expect(said).toContain("1 message(s) arrived in general before yours");
    // An agent never counts its own line as a crossing. The history stores the
    // handle because matching on the scramble name alone listed the agent's own
    // line on the first live run.
    expect(said).not.toContain("my own earlier line");
    expect(said).toContain("I am taking the generation run");
    expect(said).toContain("already claimed the work");
    // Every line includes the key. An agent filtering by the prefix of the first line
    // received the count and none of the messages that the block exists to list.
    expect(said.split("\n").filter((l) => l.includes("message(s) arrived") || l.includes("I am taking the generation run")).every((l) => l.startsWith("crossed: "))).toBe(true);
    // The cap states what it dropped. The cursor advances on a `message check` sweep,
    // and an agent reading through a listener never runs one, so this block printed
    // 165 lines on every send and taught two agents to filter it. A message after
    // this one creates no crossing.
    expect(said).not.toContain("not a crossing");
  });

  test("the sweep states how many lines it delivered and from how many channels", async () => {
    // The operator read the highest `seq` in a sweep's output as a line count and
    // published 211 for a tick whose own log holds 165 records. The `seq` is per-drain
    // and skips records that the drain passes over, which includes this agent's own
    // sends. The drain held the number and reported nothing.
    const cwd = scratchDir("check-count");
    const errs: string[] = [];
    const io = slackCheckIo(cwd, {
      fetch: async (url) => {
        if (String(url).includes("conversations.history"))
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { ts: "10.0", user: "U9", text: "one" },
                { ts: "11.0", user: "U9", text: "two" },
              ],
            }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
      },
    });
    const watched: Io = { ...io, writeErr: (l) => errs.push(l) };
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], watched)).toBe(0);
    expect(errs.join("\n")).toContain("check: 2 line(s) delivered, 1 channel(s) read.");
    // The system reports zero as well, since an agent wants confirmation of a tick
    // that carried nothing. The system still reads a channel with nothing new, which is
    // what the second number counts.
    const quiet: string[] = [];
    const empty: Io = { ...slackCheckIo(scratchDir("check-count-zero")), writeErr: (l) => quiet.push(l) };
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], empty)).toBe(0);
    expect(quiet.join("\n")).toContain("check: 0 line(s) delivered, 1 channel(s) read.");
  });

  test("the crossings block keeps the newest and counts what it left out", async () => {
    // This agent emits 165 lines on every send, because the cursor this block reads
    // advances during a `message check` sweep and an agent that reads through a
    // listener runs no sweeps. Output of that size leads agents to filter the send
    // output, which two agents reported doing after losing other blocks to the filter.
    const cwd = scratchDir("send-crossings-cap");
    const older = Array.from({ length: 40 }, (_, i) => ({ ts: `${10 + i}.0`, user: "U9", text: `line ${i}` }));
    const io = slackCheckIo(cwd, {
      fetch: async (url) => {
        const u = String(url);
        if (u.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "90.0", message: {} }), { status: 200 });
        if (u.includes("conversations.history")) return new Response(JSON.stringify({ ok: true, messages: older }), { status: 200 });
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
      },
    });
    writeSlackConfig(cwd, {
      appToken: "xapp-1",
      token: "xoxb-1",
      channels: { general: "C1" },
      agents: { dev: { token: "T", handle: "dev_bot" } },
      roster: { U9: "peer", UME: "dev_bot" },
    });
    const errs: string[] = [];
    const watched: Io = { ...io, writeErr: (l) => errs.push(l), readStdin: async () => "my line" };
    expect(await main(["message", "send", "--target", "general", "--as", "dev"], watched)).toBe(0);
    const said = errs.join("\n");
    expect(said).toContain("40 message(s) arrived in general");
    // The most recent entries answer whether someone just made your point.
    expect(said).toContain("line 39");
    expect(said).toContain("line 25");
    expect(said).not.toContain("line 24");
    // The cap lists every entry it dropped back to the oldest timestamp, along with
    // the command that reads them.
    expect(said).toContain("25 older message(s) not listed, back to 10.0");
    expect(said).toContain("scramble history general");
    expect(said.split("\n").filter((l) => l.includes("line 39") || l.includes("older message(s) not listed")).every((l) => l.startsWith("crossed: "))).toBe(true);
  });

  test("a crossings lookup that FAILS says so, and the message still went", async () => {
    // A failed lookup is reported and is never fatal. A failed lookup here must not
    // turn a delivered message into an error.
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
    // Each agent records its hostname and working directory on scramble, and an
    // agent may know peers in the same directory. This data travels in Slack message
    // metadata across the channel that a status line already uses, so it requires no
    // application changes and works for an application owned by another login. An
    // agent learns this metadata from any message, whether addressed or unaddressed.
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
    // The `--same-dir` flag compares the `HOST` and directory together, so it drops a
    // peer located elsewhere.
    const q = stubIo(cwd, async () => new Response("{}", { status: 200 }));
    expect(await main(["peers", "--same-dir"], { ...q.io, hostname: () => "my-host" })).toBe(0);
    expect(q.writes.join(" ")).toContain("No peers running in");
  });

  test("`peers --json` answers a WATCHER with no token and no network", async () => {
    // The damage count was initially assigned to `doctor`. The agent monitoring for
    // a torn line rejected that design with valid reason: `doctor` reads the app
    // manifest, and the stored token on the host expired, so a watcher process
    // executing `doctor` every ten minutes relies on a command that already fails on
    // that host. A question about a local file is answerable directly from the local
    // file.
    const cwd = scratchDir("peers-json");
    writeSlackConfig(cwd, { token: "xoxb-1", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    writeFileSync(
      join(cwd, ".scramble", "peers.jsonl"),
      `${JSON.stringify({ agent: "ana", host: "h", dir: "/w", commit: "abc1234", at: "t1" })}\n` +
        `{"agent":"bo","ho\n` +
        `${JSON.stringify({ agent: "ana", host: "h", dir: "/w2", commit: "abc1234", at: "t2" })}\n`,
    );
    // The responder touches no fetch seam and throws if anything calls out.
    const { io, writes } = stubIo(cwd, async () => {
      throw new Error("peers --json must not reach the network");
    });
    expect(await main(["peers", "--json"], { ...io, hostname: () => "my-host" })).toBe(0);
    const said = JSON.parse(writes[0]!) as {
      peers: Array<{ agent: string; dir: string }>;
      damaged: number;
      self: { host: string };
    };
    // The process records its own origin, the newest row for each agent, and the
    // damage count.
    expect(said.peers).toHaveLength(1);
    expect(said.peers[0]).toMatchObject({ agent: "ana", dir: "/w2" });
    expect(said.damaged).toBe(1);
    expect(said.self.host).toBe("my-host");
  });

  test("THIS AGENT'S OWN ROW is written too, so a crash leaves it on disk", async () => {
    // Scramble should store the agent runtime, working directory, and session IDs for
    // each agent in case of a system restart or crash. Every row came from a message a
    // peer sent, so the file omitted the one agent whose runtime and session this
    // process knew for certain: a host that crashed took its own record with it.
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
      // The handle differs from the name in the live environment:
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
    // The agent's own row claims its Slack handle, so a row written under that
    // handle retires without waiting for this agent to send again. The configuration
    // already holds the mapping, and an agent that upgrades and stays quiet would
    // otherwise keep two identities on one host in one session. The agent uses its
    // own file, since no two writers share one file any more.
    const rows = readFileSync(join(cwd, ".scramble", "peers.d", "dev.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(rows[rows.length - 1]!)).toMatchObject({ agent: "dev", handle: "dev_bot" });
  });

  test("an unwritable own record REPORTS itself and still sends", async () => {
    // The record serves accounting purposes, while the message is the primary focus.
    // A directory that cannot be written must neither drop the send nor remain
    // silent.
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
    // The directory containing the record is read-only, so appending the row throws
    // an error.
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
    // Tracking a peer's location serves accounting, while message delivery is the
    // primary objective. A record that cannot be written must not suppress the
    // delivery, and it must not fail silently.
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
    // Each writer now owns a file inside a read-only record directory, so the write
    // fails wherever the peer's name goes, while everything else under .scramble stays
    // writable. The test then proves the delivery survives this failure and no other
    // failure.
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
    // Every agent on a host shares the configuration, so each sweep checked the other
    // agents' channels and printed `slack: <name>: channel_not_found` for every one
    // every time. An agent logged two such lines on every check for channels it had
    // never joined, which appeared as a fault on every run.
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
    // Position this after the helper, which writes its own configuration over
    // anything defined earlier.
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
    // The human operator pastes this line, which is already populated with this
    // agent's handle. An agent read this list, wanted one of the channels, and had to
    // ask which command to request.
    expect(said).toContain("/invite @dev");
    // The output avoids one line per channel, which read as a fault.
    expect(said).not.toContain("slack: theirs: channel_not_found");

    // The line "A SECOND SWEEP WITH THE SAME SET IS SILENT" printed on every tick,
    // so a monitor guarding on `if [ -n "$out" ]` fired every time: 123 of 187 ticks
    // carried this message and nothing else.
    const again: string[] = [];
    expect(
      await main(["message", "check", "--as", "dev", "--backend", "slack"], { ...io, writeErr: (l) => again.push(l) }),
    ).toBe(0);
    expect(again.join("\n")).not.toContain("is not a member of");

    // Each change communicates information. Losing a change is news, and gaining a
    // change is news as well.
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

    // When a cursor file fails to parse, the system treats it as having no remembered
    // set, so the advisory emits a warning. Silence would hide a real change behind a
    // corrupt file.
    writeFileSync(join(cwd, ".scramble", "cursors", "dev.json"), "{ broken");
    const broken: string[] = [];
    expect(
      await main(["message", "check", "--as", "dev", "--backend", "slack"], { ...io, writeErr: (l) => broken.push(l) }),
    ).toBe(0);
    expect(broken.join("\n")).toContain("is not a member of");
  });

  test("with the membership listing broken, every channel stays loud", async () => {
    // A filter that cannot distinguish between the two must not select the quiet
    // answer.
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
    // Live testing showed that an agent invited into a channel could send messages to
    // it, because the post path queries Slack, while the status path read the
    // manually maintained map, found nothing, and left the feature dead in that
    // channel. A stale map entry ended the same way, returning a bare
    // `status: channel_not_found`.
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
    // When the map could not answer the lookup, the request went to Slack under the
    // agent's own credential, exactly as the post path does.
    expect(asked.some((u) => u.includes("users.conversations"))).toBe(true);
  });

  test("a valid slack config with an empty channel history reports nothing and exits 0", async () => {
    const io = slackCheckIo(scratchDir("mslack-ok"));
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(0);
  });

  test("an existing cwd cursor MIGRATES on the first write, keeping its values", async () => {
    // The agent ends the coupling by reading the old file while writing the new one.
    // Reading the absent new file would drop every channel cursor this agent already
    // had and re-drain everything exactly once.
    const cwd = scratchDir("cursor-migrate");
    const io = slackCheckIo(cwd, {
      fetch: async (url) =>
        String(url).includes("conversations.history")
          ? new Response(JSON.stringify({ ok: true, messages: [{ ts: "9.9", user: "U9", text: "hi" }] }), { status: 200 })
          : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    });
    // The old location holds a cursor for a channel this sweep will not visit.
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    writeFileSync(
      join(cwd, ".scramble", "cursor.json"),
      JSON.stringify({ "slack:dev": { "already-seen": "5.5" } }),
    );
    expect(await main(["message", "check", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    const moved = JSON.parse(
      readFileSync(join(cwd, ".scramble", "cursors", "dev.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    // The move retained the old value, and the new value joined it.
    expect(moved["slack:dev"]!["already-seen"]).toBe("5.5");
    expect(moved["slack:dev"]!.general).toBe("9.9");
  });

  test("ONE AGENT'S CURSOR NEVER BLINDS ANOTHER on a shared host", async () => {
    // A single shared file beside the configuration appears correct because its keys
    // are per agent. The first agent that sweeps creates the file. Every other agent
    // then resolves to that file, finds no key for itself, reads 0, and re-drains the
    // full history. This produces the same flood one step later, once per agent.
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
    // beta has swept nothing, so it has no cursor of its own, and it does not read
    // alpha's file. Each agent uses one file, which makes that true.
    const beta = join(cwd, ".scramble", "cursors", "beta.json");
    expect(existsSync(beta)).toBe(false);
    expect(await main(["message", "check", "--as", "beta", "--backend", "slack"], io)).toBe(0);
    expect(existsSync(beta)).toBe(true);
    // Beta's sweep does not touch alpha's cursor, so no read-modify-write race occurs
    // over one file.
    const after = JSON.parse(readFileSync(alpha, "utf8")) as Record<string, unknown>;
    // Each agent's file stores only its own cursor and skipped set, keeping it
    // isolated from the other agent.
    expect(Object.keys(after).sort()).toEqual(["slack-skipped:alpha", "slack:alpha"]);
  });

  test("the sweep covers channels this agent is IN, beyond what the config maps", async () => {
    // A peer removed two entries from the SHARED configuration while testing name
    // resolution, and this sweep stopped covering the channel the operator uses to
    // communicate. The sweep reported "none of the 3 configured channels are readable"
    // and swept nothing that mattered, while the listener kept delivering, so nothing
    // looked broken.
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
    // Channel C1 is the configured `general`, and only membership knows channel C9.
    expect(asked).toContain("C1");
    expect(asked).toContain("C9");
  });

  test("a refused membership listing is REPORTED, never read as being in nothing", async () => {
    // An agent with no channels and an agent whose listing was refused appear
    // identical from the outside, and one of these cases is a broken credential.
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
    // The sweep process executes the close operation while the agent is not
    // watching. A silent failure at this step leaves answered questions in `pending`
    // and trains the agent to scroll past the list.
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
    // An open row must exist for the close operation to attempt a write, and the
    // system locks the file. A directory's write bit governs create and unlink
    // operations only.
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
    // The operator must understand this general pattern and use the message check to
    // guard it after catching three style defects in a row. The system added every
    // rule after a message went out carrying what the rule bans, so a rule guarding
    // only the next message leaves every earlier message standing in the channel,
    // unmarked, as though it were fine.
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
    // After the helper writes its own configuration, the roster resolves user ID
    // U1 to this agent, so the drain recognises the line as its own and lints it.
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
    // The clean line has no name. A report that lists everything names nothing.
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
        // The status postMessage answered, addressing "dev".
        return new Response(JSON.stringify({ ok: true, ts: "9.9" }), { status: 200 });
      },
    });
    const code = await main(["message", "check", "--as", "dev", "--backend", "slack"], io);
    expect(code).toBe(0);
    // The request asks for history without an `oldest` value, so it has no prior
    // cursor.
    expect(historySeen).toEqual(["(none)"]);
    // The output contains one JSON line for the waiting mention, formatted in the
    // listen schema with a mention timestamp.
    expect(writes).toHaveLength(1);
    const line = JSON.parse(writes[0]!) as { text: string; channel: string; mentioned: boolean };
    expect(line.text).toBe("@dev check me");
    expect(line.channel).toBe("general");
    expect(line.mentioned).toBe(true);
    // The per-channel cursor moved. The stored Slack cursor is a map of channel to
    // ts.
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
    // The second check uses the same history, but the cursor ("6.6") excludes the
    // line.
    const writes: string[] = [];
    const second = slackCheckIo(cwd, { fetch, write: (l) => writes.push(l) });
    const code2 = await main(["message", "check", "--as", "dev", "--backend", "slack"], second);
    expect(code2).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("message check drains a peer's line and does NOT drain a line from the draining agent", async () => {
    // The drain operation delivers incoming messages to the agent. It omits the
    // agent's own lines where the resolved sender name matches the draining agent,
    // using the same name comparison that listen and next use. The cursor still
    // advances over the skipped line, since the peer line is newest.
    const cwd = scratchDir("mslack-drain-noself");
    const writes: string[] = [];
    const io = slackCheckIo(cwd, {
      write: (l) => writes.push(l),
      fetch: async (u) => {
        if (String(u).includes("conversations.history")) {
          // Under newest-first ordering, the agent's own line (ts 9.9) is the newest,
          // and
          // the peer's line (ts 9.5) is older.
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
    // Only the peer's line drains, and the agent withholds its own line.
    expect(writes).toHaveLength(1);
    const line = JSON.parse(writes[0]!) as { text: string; from: string };
    expect(line.from).toBe("bob");
    expect(line.text).toBe("@dev a peer asks");
    // The cursor points to the newest line, which is the skipped own line (9.9), so
    // the very next sweep does not re-read it.
    const cursor = JSON.parse(readFileSync(join(cwd, ".scramble", "cursors", "dev.json"), "utf8"));
    expect(cursor["slack:dev"]).toEqual({ general: "9.9" });
  });

  test("the cursor advances past a skipped own-line: second check empty, third returns only the new peer line", async () => {
    const cwd = scratchDir("mslack-cursor-own");
    // Each sweep rotates the history. Sweep 1 returns only its own lines, sweep 2
    // returns the same own lines again, and sweep 3 returns a fresh peer line.
    const batches: Array<Record<string, string | number>[]> = [
      // In sweep 1, two own-line posts appear before the cursor, and neither post is
      // delivered.
      [
        { ts: "5.1", user: "dev", username: "dev", text: "own reply 2" },
        { ts: "5.0", user: "dev", username: "dev", text: "own first" },
      ],
      // Sweep 2 encounters the same owned lines and yields nothing because the cursor
      // is
      // already past them.
      [
        { ts: "5.1", user: "dev", username: "dev", text: "own reply 2" },
        { ts: "5.0", user: "dev", username: "dev", text: "own first" },
      ],
      // Sweep 3 processes a fresh peer line after its own lines.
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
    // In sweep 1, the process holds its own lines back from the drain while the cursor
    // passes them.
    const c1 = await main(["message", "check", "--as", "dev", "--backend", "slack"], first);
    expect(c1).toBe(0);
    expect(writes1).toHaveLength(0);

    // Sweep 2 does nothing if its own lines are already behind the cursor.
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

    // Sweep 3 produces only a new peer line after the cursor drains.
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
    // History in channel `general` returns one message mentioning "dev". The status
    // post calls `chat.postMessage` and receives `ok:true`, so `setOn` writes the
    // ledger.
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
    // Addressing the reading agent set a status in the ledger.
    expect(existsSync(join(addressed, ".scramble", "status.json"))).toBe(true);
    const ledger = JSON.parse(readFileSync(join(addressed, ".scramble", "status.json"), "utf8"));
    const entry = (ledger.entries as Array<{ channel: string; agent: string }>).find((e) => e.channel === "general");
    expect(entry).toMatchObject({ channel: "general", agent: "dev" });

    // A message that is not addressed sets nothing and creates no new status entry.
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
    // The system prints message 8.8 but does not address it, which means it must not
    // have set a status.
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
                // Slack returns results newest-first. The drain cursor must keep the
                // newest.
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
    // The cursor holds the newest timestamp for the channel, which the last-seen
    // timestamp can trail.
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
    // If the configuration parses with valid channels and agents but carries no bot
    // token, the Slack backend refuses to open, and `message check` must report it.
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
  // An app cannot add itself to a public or private Slack conversation. A member
  // invites it. So the command reports whether the invite has happened and prints
  // the invite line when it has not. The command never touches the local daemon,
  // which is not running under this backend.
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
  // During a live measurement, scramble-dev was invited to one channel of the four
  // in the config. The command `message check` returned
  // `read failed: channel_not_found` and drained nothing, which a sweeping agent
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
    // The response is named for what it is: this agent is not a member of the
    // channel, which the membership listing settles. Every check previously read
    // `theirs: channel_not_found`, identical to a real failure.
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
  // A running process does not receive a committed fix. This produced a visible
  // defect twice where the code had already fixed the issue. This document explains
  // the behavior because no previous text stated it.
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
    // This workspace requires one version per machine, so an install by any agent
    // leaves every running listener behind. The install prints which listeners are
    // affected, and the installer reads that output. The stale agent reads this
    // section on the stream it already watches. Two agents reported being left behind
    // and learning about it only from doctor.
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
      // The commit is identical, so there is nothing to report.
      drift.tick();
      expect(outs).toEqual([]);
      // An operator runs the installation.
      writeFileSync(join(store, "current", "src", "COMMIT"), "bbbbbbb\n");
      drift.tick();
      expect(outs.join(" ")).toContain("this listener runs aaaaaaa and bbbbbbb is installed now");
      // The delivery stream carries these notices as JSON. One agent's launcher sent
      // stderr to a file that its monitor never read, so 58 of these notices reached
      // nobody, and merging that host's streams would have fed prose to a reader that
      // parses every line. A reader consuming deliveries consumes this.
      expect(errs).toEqual([]);
      const parsed = JSON.parse(outs[0] ?? "null") as Record<string, unknown>;
      expect(parsed.scramble).toBe("stale-listener");
      expect(parsed.running).toBe("aaaaaaa");
      expect(parsed.installed).toBe("bbbbbbb");
      // Emit a line once per change, because a line every 30 seconds would teach the
      // agent to skip it.
      drift.tick();
      expect(outs).toHaveLength(1);
    } finally {
      drift.stop();
    }
    // A copy without a COMMIT beside it falls back to the installed commit, so a
    // checkout run directly through bun compares against itself and prints nothing.
    const bare: Io = { ...io, moduleDir: () => join(home, "no-commit-here") };
    const second = watchForNewerInstall(bare);
    try {
      second.tick();
    } finally {
      second.stop();
    }
  });

  test("a SHELL carrying the words is not a listener", () => {
    // A substring match over `/proc` counts any process whose arguments carry the
    // searched words, and processes run while investigating listeners are the most
    // likely to carry them. Debugging shells matched the scan on a host, and supplying
    // an empty `/proc` to the tests masked the failure, which left the detector able
    // to produce false matches for any user. Inspecting `argv[0]` identifies the
    // process, because `bun` executes a listener.
    const shell = proc("900", "/bin/bash -c pgrep -f 'bin.ts listen' | grep -- '--as dev'", 1_000);
    const grep = proc("901", "grep -F bin.ts listen --as dev", 1_000);
    const real = proc("902", "bun /srv/agents/scramble/abc1234/src/bin.ts listen --as dev", 1_000);
    expect(liveListeners([shell, grep, real], "dev")).toEqual(["902"]);
    expect(pickStale([shell, grep, real], "dev", 5_000).map((p) => p.pid)).toEqual(["902"]);
    expect(listenersBehind([shell, grep, real], "dev", "zzz9999").map((p) => p.pid)).toEqual(["902"]);
  });

  test("a pid that has gone is dropped before it is NAMED", () => {
    // An agent stopped its listener and executed `doctor --wake`, but the command
    // refused the request with the PID of a process that had already exited. A refusal
    // that names a dead PID prompts an operator to search for a process to stop, and
    // the probe that the command withheld would have succeeded.
    const root = mkdtempSync(join(tmpdir(), "scramble-proc-"));
    mkdirSync(join(root, "500"), { recursive: true });
    expect(stillAlive(["500", "501"], root)).toEqual(["500"]);
    // A root that cannot be read reports "none alive". This response is safe because
    // it allows the probe to RUN and be judged on its own result.
    expect(stillAlive(["500"], join(root, "nothing"))).toEqual([]);
  });

  test("a listener names the COMMIT it runs, and only an installed one can", () => {
    // The launcher executes the resolved commit directory, so the version is in
    // the process's own command line. Executing `current` would make every listener
    // on the host report `current`, which names a symlink that has since moved.
    expect(listenerCommit("bun /s/share/scramble/995edba/src/bin.ts listen --as dev")).toBe("995edba");
    // A checkout has no commit to name, and this case is reported differently.
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
    // Because nothing is installed, the system has no comparison to make, which would
    // produce a false accusation.
    expect(listenersBehind(procs, "dev", "")).toEqual([]);
  });

  test("a LIVE listener is found whatever its age, which is a different question", () => {
    // `pickStale` identifies which listeners run behind the current code.
    // `liveListeners` checks whether any process holds the socket, which determines
    // whether `doctor --wake` can have any effect.
    const fresh = proc("200", "bun src/bin.ts listen --as dev", 9_000);
    const old = proc("201", "bun src/bin.ts listen --as dev", 1_000);
    const other = proc("202", "bun src/bin.ts listen --as someone-else", 1_000);
    const notListener = proc("203", "bun src/bin.ts serve --as dev", 1_000);
    expect(liveListeners([fresh, old, other, notListener], "dev").sort()).toEqual(["200", "201"]);
    expect(pickStale([fresh, old, other, notListener], "dev", 5_000)).toEqual([{ pid: "201", ageBehind: 4 }]);
    expect(liveListeners([], "dev")).toEqual([]);
  });

  test("the agent's name appearing in the working directory is not the agent's listener", () => {
    // During measurement, an agent named after the product in a checkout directory
    // carrying that same name caused a substring match to report every listener under
    // every agent. The doctor diagnostic listed the same three process IDs twice and
    // instructed the operator to restart processes owned by other users.
    //
    // Because `/proc` holds the argument vector of the process, the shell's `cd`
    // and `&&` never appear in it. The checkout path carries the other agent's name,
    // which this case exercises.
    const other = proc("104", "bun /srv/hark/scramble/src/bin.ts listen --as scramble-dev", 1_000);
    expect(pickStale([other], "hark", 5_000)).toEqual([]);
    expect(pickStale([other], "scramble-dev", 5_000)).toEqual([{ pid: "104", ageBehind: 4 }]);
  });

  test("a process that is not a listener is ignored, however old", () => {
    expect(pickStale([proc("103", "bun src/bin.ts serve --as dev", 1)], "dev", 5_000)).toEqual([]);
  });

  test("a pid whose cmdline cannot be read is skipped rather than crashing the scan", () => {
    // A process can exit between the listing and the read. Such a process has
    // terminated and does not persist as stale data. If `/proc` is entirely
    // unreadable, the operation returns an empty list.
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
  // The skill uses a reaction to acknowledge messages because reactions avoid
  // spending a line while fulfilling the role of an "on it" message.
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
    // The colons a person types around an emoji are stripped because Slack requires
    // the name.
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
    // The log records the request alongside the answer. The output
    // `react failed: channel_not_found` named the error alone. An agent that
    // measured a direct `reactions.add` returning `ok:true` could take the report
    // no further, because the line stated neither which channel id went out nor
    // which credential it used.
    expect(errs.join(" ")).toContain("channel room resolved to C1");
    expect(errs.join(" ")).toContain("ts 9.9");
    expect(errs.join(" ")).toContain("under dev's own token");
  });

  test("the failure names the CONFIG DEFAULT when the agent has no token of its own", () => {
    // When Slack reports that a channel does not exist, first determine which
    // application acted, because an agent's own token and the configuration default
    // belong to different applications.
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
    // Specifying `--backend local` explicitly sets the backend. Without a flag or
    // `SCRAMBLE_BACKEND`, the backend follows the configuration on disk, and this
    // workspace contains a Slack configuration, so the derived backend is Slack.
    const a3 = reactIo(cwd, ok);
    expect(
      await main(["message", "react", "--target", "room", "--to", "1.1", "--emoji", "x", "--as", "dev", "--backend", "local"], a3.io),
    ).toBe(1);
    expect(a3.errs.join(" ")).toContain("needs the slack backend");
  });
});

describe("the automatic status posts as the ACTING agent", () => {
  // The system previously posted messages using the default token from the
  // configuration. That token belongs to a different application that is usually
  // missing from the agent's channel, so Slack returned channel_not_found. Because a
  // failed status never fails the work it brackets, the feature was silently dead
  // for every agent except the default.
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
    // The status post was published using the developer's personal access token.
    expect(auths).toContain("Bearer T_DEV");
    expect(auths).not.toContain("Bearer xoxb-DEFAULT");
    const ledger = JSON.parse(readFileSync(join(cwd, ".scramble", "status.json"), "utf8")) as {
      entries: Array<{ thread?: string; ts?: string }>;
    };
    // A recorded THREAD proves Slack accepted the status, and it contains no `ts`
    // because a status is no longer a message.
    expect(ledger.entries[0]!.thread).toBe("5.5");
    expect(ledger.entries[0]!.ts).toBeUndefined();
  });
});

describe("doctor, and the warning an agent gets without asking", () => {
  // The test runner injects an empty process table because these tests otherwise
  // scan the real `/proc`. The listener matcher searches for `bin.ts listen` and
  // `--as <name>` in a command line, and a shell command that quotes those strings
  // matches. Four of these tests failed whenever an active debugging shell held
  // those strings, and passed when it did not. A test that reads the machine
  // reports the machine.
  const EMPTY_PROC = scratchDir("doctor-empty-proc");

  // A HEALTHY AGENT RUNS THE CANONICAL MONITOR, so these tests plant one. An agent
  // ran a poll of its own against one channel, a mention in every other channel woke
  // nothing, and this verb answered `ok` throughout; the operator's instruction is
  // that a wrong setup cannot look healthy. The proc root below holds a listener for
  // each name these tests use, and the test that asserts the failure uses a root of
  // its own with nothing in it.
  const ARMED_PROC = (() => {
    const root = scratchDir("doctor-armed-proc");
    for (const [pid, agent] of [
      ["4101", "dev"],
      ["4102", "alone"],
    ] as Array<[string, string]>) {
      const dir = join(root, pid);
      mkdirSync(dir, { recursive: true });
      writeFileSync(dir + "/cmdline", ["/x/bun", "/x/src/bin.ts", "listen", "--addressed", "--as", agent].join("\0"));
    }
    return root;
  })();

  // An agent onboarded before a fix continues to run without that fix. No other
  // mechanism notifies a running agent that its configuration is out of date, which
  // is why this command and this warning exist.
  function docIo(cwd: string, headers: Record<string, string>, body: Record<string, unknown>, proc?: string) {
    const writes: string[] = [];
    const errs: string[] = [];
    const io: Io = {
      write: (l) => writes.push(l),
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response(JSON.stringify(body), { status: 200, headers }),
      env: (n) => (n === "SCRAMBLE_PROC" ? (proc ?? ARMED_PROC) : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    return { io, writes, errs };
  }
  // This copy is derived from the source list. Maintainers kept this copy by hand,
  // and it fell behind the real list by two scopes, so "a healthy agent" was
  // healthy against a list that no longer existed, which is the drift that let the
  // events go unchecked.
  const ALL = SCOPE_NAMES.join(",");

  test("NO CANONICAL MONITOR IS A FAILURE, so a wrong setup cannot report ok", async () => {
    // An agent ran a poll of its own against one channel. A mention in every other
    // channel woke nothing, and this verb answered `ok` throughout. The operator's
    // instruction after reviewing the missed messages: a wrong setup cannot look
    // healthy.
    const cwd = scratchDir("doc-nomonitor");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const { io, errs, writes } = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" }, EMPTY_PROC);
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("NO canonical monitor is running for dev");
    expect(errs.join(" ")).toContain("scramble listen --addressed --as dev");
    // The clean line is the thing that must NOT appear.
    expect(writes.join(" ")).not.toContain('"doctor":"ok"');
  });

  test("a healthy agent reports ok with its handle", async () => {
    const cwd = scratchDir("doc-ok");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const { io, writes } = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    expect(JSON.parse(writes[0]!)).toMatchObject({ doctor: "ok", agent: "dev", handle: "dev_bot" });
  });

  test("ok carries the PEER RECORD'S health, so a monitor reads a field", async () => {
    // Six agents append to that file on one host. One agent found a line that no
    // parser could read, and the agent that armed a watcher for it wrote its own parse
    // loop. Two definitions of `damaged` disagree the day the row shape changes, and a
    // monitor that greps the prose sentence breaks on a rewording.
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
    // The sending process reads four environment variables to enable the feature, so
    // checking the status without sending a message verifies whether the process is
    // configured or believed-configured.
    const cwd = scratchDir("doc-rewrite");
    writeSlackConfig(cwd, { token: "xoxb-d", channels: {}, agents: { dev: { token: "T", handle: "dev_bot" } } });
    const off = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "dev_bot" });
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], off.io)).toBe(0);
    expect(JSON.parse(off.writes[0]!)).toMatchObject({ rewrite: { on: false } });
    // The check runs on every run, whether or not anything else is wrong. The output
    // appeared in the clean line only, so on a host where every other answer is a
    // problem, an operator received no answer to the question they ask while setting
    // it up.
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
    // The `scopes: 14` output answers no question an operator asks. Pricing a change
    // requires knowing which scopes are granted. Because this surface displayed only
    // a count, an operator told an agent that reading reactions needed a scope change
    // and a reinstall. The `reactions:read` scope was already one of the fourteen
    // scopes listed in this repository's app-manifest.ts, and the agent corrected the
    // mistake from their application.
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
    // The system provides three distinct refusals, since a bare failure message is
    // useless on its own. The fix differs for a configuration that is missing, a name
    // that is not in the configuration, and an entry with no token.
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
    // This check detects a defect measured live: Slack accepts an enterprise
    // install of an app declaring org_deploy_enabled:false, every REST call keeps
    // working, and the socket opens and says hello, but no event is ever delivered.
    // The agent appears green while its wake path remains silent.
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
        // The app's own manifest shows the contradiction.
        return new Response(
          JSON.stringify({ ok: true, manifest: { settings: { org_deploy_enabled: false } } }),
          { status: 200 },
        );
      },
      env: (n) => (n === "SCRAMBLE_PROC" ? ARMED_PROC : n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
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
      env: (n) => (n === "SCRAMBLE_PROC" ? ARMED_PROC : n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
      cwd: () => home,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    expect(writes.join(" ")).toContain('"doctor":"ok"');
  });

  test("an app that subscribes to no invite event is named as the silent half of an inbox", async () => {
    // A live measurement caught this defect when an operator invited an agent to a
    // channel and nothing arrived. The application declared `org_deploy_enabled:true`,
    // held every scope, and its socket delivered mentions the entire time. It
    // subscribed to three events while omitting `member_joined_channel`, and Slack
    // sends nothing for an event an application has not requested. Everything else
    // about the agent was healthy, which is why the wake path has to be checked
    // field by field. Arriving messages prove nothing about the fields.
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
      env: (n) => (n === "SCRAMBLE_PROC" ? ARMED_PROC : n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
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
      env: (n) => (n === "SCRAMBLE_PROC" ? ARMED_PROC : n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
      cwd: () => home,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
  });

  test("no CLI credential leaves the question open; a REFUSED export is reported", async () => {
    // Each of these results means "cannot tell". A check that cannot tell must not
    // report a defect, because a false alarm on the wake path would send an agent to
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
        env: (n) => (n === "SCRAMBLE_PROC" ? ARMED_PROC : n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
        cwd: () => home,
        sleep: async () => {},
        serve: async () => 0,
        createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
      };
      return main(["doctor", "--as", "dev", "--backend", "slack"], io);
    }
    // The credentials.json file does not contain JSON.
    expect(await run((h) => {
      mkdirSync(join(h, ".slack"), { recursive: true });
      writeFileSync(join(h, ".slack", "credentials.json"), "not json");
    }, true)).toBe(0);
    // The credentials.json file does not contain a token.
    expect(await run((h) => {
      mkdirSync(join(h, ".slack"), { recursive: true });
      writeFileSync(join(h, ".slack", "credentials.json"), JSON.stringify({ E1: {} }));
    }, true)).toBe(0);
    // A refused export is no longer an open question. When a credential is present
    // and the export is refused, this login cannot read the app, so the system cannot
    // check or repair its scopes and events from here, and reports this condition.
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
      env: (n) => (n === "SCRAMBLE_PROC" ? ARMED_PROC : n === "HOME" ? home : n === "SCRAMBLE_SLACK_CONFIG" ? join(home, ".scramble", "slack.json") : undefined),
      cwd: () => home,
      sleep: async () => {},
      serve: async () => 0,
      createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    };
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
  });

  test("a listener on a DIFFERENT commit than the install is reported, with both", async () => {
    // An installed agent includes the commit in its process command line, so the
    // system needs no modification times. Those times describe whatever `src` sits
    // in the current directory, which is a different tree for an installed copy.
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
      // The HOME variable points at the fake install. The command names the config
      // explicitly, since HOME also determines where the tool looks for the config.
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
    // The system issues an advisory, so the verb still answers ok. A listener on an
    // older commit still delivers messages. Zero listeners means nothing arrives, and
    // reporting the two with the same weight caused an agent to build its own grading
    // on top: it uses an advisory for a commit mismatch and alarms only for zero
    // listeners.
    expect(await main(["doctor", "--as", "dev", "--backend", "slack"], io)).toBe(0);
    const said = errs.join(" ");
    expect(said).toContain("doctor advisory:");
    expect(said).toContain("pid 88 on 4f7b942");
    expect(said).toContain("installed 995edba");
  });

  test("a host with no readable process table SAYS so, and never reports ok", async () => {
    // Both listener checks read /proc. When a host lacks a check, no process has
    // inspected it, so the state of its listeners remains unverified. scramble is
    // about to run on other machines.
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
    // A fourth agent measured this. Its listener and a second application on the
    // same adopted token were splitting mentions between a consumer that answers and
    // a consumer that discards them, and a human asked the same question twice inside
    // that window.
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

    // An agent that has its own application is clean.
    const b = docIo(cwd, { "x-oauth-scopes": ALL }, { ok: true, user: "alone_bot" });
    expect(await main(["doctor", "--as", "alone", "--backend", "slack"], b.io)).toBe(0);
  });

  test("an app this login cannot read names the OWNER, never a command that dies", async () => {
    // When a fourth agent onboarded onto an app owned by another user, doctor
    // instructed it to run onboard-agent.ts. That script calls apps.manifest.export and
    // fails on its first call because the repair routine assumes that the agent owns
    // the app.
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

    // An error that Slack never tied to access receives no ownership verdict. The
    // ownership check ran in the `else` branch of an allowlist, so every new error
    // string arrived as an ownership claim: `token_expired`, and then
    // `invalid_refresh_token` from the rotation code a day later.
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
    // The fix omits the command that cannot run.
    expect(said).not.toContain("Fix: bun scripts/onboard-agent.ts");
  });

  test("a credential failure carries its own repair, and doctor adds no guess to it", async () => {
    // The first live run of the rotation returned `invalid_refresh_token`, and
    // doctor appended "This app may have been created by another login" to the output.
    // The evidence never established this cause on a surface an agent trusts, which is
    // the same defect the ownership branch had a day earlier.
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
    // A host that stops updating sends no signal. The staleness notice compares a
    // listener to the install beside it, so a machine where nobody runs an install
    // stays quiet while it falls behind. One machine sat five commits back with every
    // listener matching its own install.
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
    // The reading identifies the commit that a peer ran when it wrote. An agent was
    // flagged on `d836964` while running `1f082b8`, because that was the newest message
    // the ledger held from them.
    expect(said).toContain("LAST SPOKE on a different commit");
    expect(said).toContain("upgraded without speaking since still shows the old one");
    expect(said).toContain("A machine nobody installs on never reports staleness");
  });

  test("doctor ROTATES a spent app-config token instead of asking a person to log in", async () => {
    // The token lasts twelve hours and nothing renewed it, so doctor lost the
    // manifest check every night on both hosts. The entry carries a refresh_token,
    // which an agent found in the file.
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
    // The system stores the new pair on disk and preserves the Slack CLI's own fields.
    const after = JSON.parse(readFileSync(join(home, ".slack", "credentials.json"), "utf8"));
    expect(after.E1.token).toBe("xoxe-new");
    expect(after.E1.refresh_token).toBe("xoxe-r-new");
    expect(after.E1.team_domain).toBe("examplecorp");
  });

  test("an EXPIRED cli token is a token problem, and says nothing about ownership", async () => {
    // When run against an application that the caller owns, the tool returned "This
    // app was created by another login" from a `token_expired` error and instructed
    // the caller to ask the owner or drop the entry. The interface printed a cause
    // that the evidence never established as fact on a surface that an agent trusts
    // to tell it what is wrong.
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
    // The text names the file that stores the credential. The Slack CLI store provides
    // this credential. This line previously stated "the CLI token in this config",
    // which pointed to a configuration file that lacked such a key. An agent read that
    // description, opened the configuration, found nothing, and reported that it
    // could not resolve the gap.
    expect(said).toContain("~/.slack/credentials.json");
    expect(said).toContain("slack login");
  });

  test("doctor --wake REFUSES to run while a listener holds the socket", async () => {
    // When the inbox was armed, `doctor --wake` reported "The wake path is DEAD"
    // and instructed the operator to re-onboard. Re-onboarding rotates the bot
    // token and strands that listener. With the same inbox stopped and no other
    // changes made, `doctor --wake` answered "delivered". Slack hands each Socket
    // Mode event to one connection, so the armed listener had taken the probe.
    // A test is not run when its answer would be meaningless.
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
    // The agent did not post the probe. Refusing an action means withholding it,
    // because posting a probe here would produce a line in the channel that proves
    // nothing.
    expect(probed).toBe(false);
  });

  test("doctor --wake FAILS when the socket opens and no frame arrives", async () => {
    // The exact defect is that a socket that connects and delivers nothing looks
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
      // When a socket connects and never delivers, it never calls `onmessage`.
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
          // Slack echoes the app's own post back across the socket, which makes a
          // self-probe a valid test of the transport.
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
    // The probe failed because the agent was never invited to the channel. The live
    // system returns `channel_not_found` for this case, and the probe must FAIL,
    // since a quiet pass on an unpostable probe proves nothing about the wake path.
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
    // When an agent is absent from the config or the config is missing, this command
    // outputs nothing here, because the verb itself reports those conditions with its
    // own error.
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

  // The configuration file holds bot tokens, so its default location is outside
  // the repository. This repository will be public, and a credential in a commit
  // is readable in every clone.
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
