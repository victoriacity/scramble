import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SlackSocket } from "../src/slack-transport";
import {
  SlackBackend,
  computeMentions,
  unescapeSlack,
  undoAutoLinks,
  denormalize,
  readerBroadcasts,
  isStatusLine,
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

/**
 *  Every Slack REST endpoint returns `ok: true` by default.
 */
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

/**
 *  Each message has a distinct `ts`, as Slack provides. The fixture reused `"1.1"`
 *  for every message, which no real workspace does. The deduplication logic that
 *  makes one message one line regardless of how Slack types the event read two
 *  fixtures as one message.
 */
let msgSeq = 0;
function msg(over: Partial<SlackInboundEvent>): SlackInboundEvent {
  msgSeq += 1;
  return { type: "message", channel: "C1", user: "U111", text: "hello", ts: `1.${msgSeq}`, ...over };
}

async function pump(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 *  This backend provides a real clock and sleep mechanism for timeout-hostile
 *  tests.
 */
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

describe("undoAutoLinks", () => {
  test("an auto-link collapses to the word the author typed, and a written link stays whole", () => {
    // A message containing a bare `users.info` inside a backtick span returned as
    // `<http://users.info|users.info>`, and the read-back guard reported that the
    // message differed from what was sent. Every message naming a module or a domain
    // would have done the same.
    expect(undoAutoLinks("falls through to <http://users.info|users.info> and renders")).toBe("falls through to users.info and renders");
    expect(undoAutoLinks("`<http://users.info|users.info>`")).toBe("`users.info`");
    expect(undoAutoLinks("<https://example.com/|example.com>")).toBe("example.com");
    expect(undoAutoLinks("<mailto:a@b.c|a@b.c>")).toBe("a@b.c");
    // Please provide the section of text you would like rewritten.
    expect(undoAutoLinks("<https://example.com/docs|the docs>")).toBe("<https://example.com/docs|the docs>");
    expect(undoAutoLinks("nothing to collapse")).toBe("nothing to collapse");

    // THE BARE FORM CORRUPTS CODE, and it survived the label rule above. An agent
    // sent four source files to a peer; the two holding a URL in a string literal
    // arrived with Slack's brackets inside the quotes, and the sender read their own
    // draft and saw nothing wrong.
    expect(undoAutoLinks("daemonUrl: config?.daemonUrl ?? '<http://127.0.0.1:8080>',")).toBe(
      "daemonUrl: config?.daemonUrl ?? 'http://127.0.0.1:8080',",
    );
    expect(undoAutoLinks("<https://example.com/a/b?c=1>")).toBe("https://example.com/a/b?c=1");
    expect(undoAutoLinks("<mailto:a@b.c>")).toBe("a@b.c");
    // The other entity shapes belong to Slack and stay whole: a user mention, a
    // broadcast, and a channel link.
    expect(undoAutoLinks("<@U0ABCDEF> <!channel> <#C0ABCDE|general>")).toBe("<@U0ABCDEF> <!channel> <#C0ABCDE|general>");
  });
});

describe("unescapeSlack", () => {
  // Slack stores `<`, `>` and `&` escaped, so a message carrying
  // `--target <channel>` read back with escaped brackets, and `--verify` reported
  // DIFFERS while the message was intact.
  test("the three escapes come back as the characters the author typed", () => {
    expect(unescapeSlack("--target &lt;channel&gt; --as &lt;me&gt;")).toBe("--target <channel> --as <me>");
    expect(unescapeSlack("a &amp;&amp; b")).toBe("a && b");
    expect(unescapeSlack("nothing to undo")).toBe("nothing to undo");
  });

  test("an escaped ampersand stays one character, and invents no bracket", () => {
    // An author writes `&amp;lt;` to produce the text `&lt;`. Undoing `&amp;` first
    // would leave `&lt;` and then turn it into `<`.
    expect(unescapeSlack("&amp;lt;")).toBe("&lt;");
  });
});

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

  test("an @ in the middle of a word is no mention", () => {
    // The name portion of the `denormalize` pattern dropped its leading boundary, so
    // `ret@4096` recorded 4096 and an email recorded its domain.
    expect(computeMentions("general", "@andrew DQ@4096 beats ret@4096 here.", "x")).toEqual(["andrew"]);
    expect(computeMentions("general", "mail me at name@example.com", "x")).toEqual([]);
    // A mention following punctuation still counts because the boundary allows it and
    // a whitespace rule refused it.
    expect(computeMentions("general", "(@ana) and,@bo", "x")).toEqual(["ana", "bo"]);
  });

  test("a possessive handle records the NAME, the way Slack converts it", () => {
    // The system converted `@alignment_benchmark's` to that agent's id and recorded
    // `alignment_benchmark's`, which is a name nobody has, so the system pinged the
    // person while their ledger owed them nothing.
    expect(computeMentions("general", "@ana's table was right.", "x")).toEqual(["ana"]);
    expect(computeMentions("general", "@ana. @bo, @cy!", "x")).toEqual(["ana", "bo", "cy"]);
    // The system trims a valid handle that ends in a dot or dash only at the end,
    // matching how the outgoing conversion processes those characters.
    expect(computeMentions("general", "ask @a.b_c-d now", "x")).toEqual(["a.b_c-d"]);
  });

  test("an @name inside a fence or a backtick span is NOT a mention", () => {
    // `denormalize` skips fenced blocks and backtick spans, so Slack creates no
    // entity for a name written inside one. The function counted them anyway, and a
    // message whose fenced block read `preserve EVERY @name` returned `name` in its
    // mention list for an agent that does not exist.
    expect(computeMentions("general", "@alice see\n```\npreserve EVERY @name\n```\n", "x")).toEqual(["alice"]);
    expect(computeMentions("general", "run `@dev --now` when ready", "x")).toEqual([]);
    // A real mention positioned next to a fenced mention still counts.
    expect(computeMentions("general", "```\n@ghost\n```\n@bo look", "x")).toEqual(["bo"]);
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

  test("an upload resolves the channel the SAME way a plain send does", async () => {
    // When a peer agent operated on a live channel, `message send --attach` read
    // `cfg.channels[target]` directly, so a channel that the agent is in failed with a
    // short "no Slack channel" error if the configuration did not map it, while a
    // plain send to that same channel worked. The missing suffix served as the
    // discriminator.
    const seen: string[] = [];
    const h = make({}, async (url) => {
      seen.push(url);
      if (url.includes("users.conversations")) {
        return new Response(JSON.stringify({ ok: true, channels: [{ id: "C9", name: "invited" }] }), { status: 200 });
      }
      if (url.includes("files.getUploadURLExternal")) {
        return new Response(JSON.stringify({ ok: true, upload_url: "https://u/x", file_id: "F1" }), { status: 200 });
      }
      if (url.includes("files.completeUploadExternal")) {
        return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://p/1" }] }), { status: 200 });
      }
      if (url.startsWith("https://u/")) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const f = join(makeTmpDir("upload-resolve"), "a.txt");
    writeFileSync(f, "bytes");
    const r = await h.backend.upload("invited", f, "alice");
    expect(r.ok).toBe(true);
    expect(seen.some((u) => u.includes("users.conversations"))).toBe(true);
    // A channel it is not in receives the full answer, identical to the one a send
    // gives.
    const bad = await h.backend.upload("nowhere", f, "alice");
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.error).toContain("this agent is not in a channel by that name");
  });

  test("a BROADCAST addresses every agent, and used to reach none of them", async () => {
    // The operator wrote "<!channel> ensure everything you write to files are
    // English", but the message reached no agent inbox because mentions was [] and
    // mentioned was false, so every agent saw the message only on the 15-minute
    // sweep. Two agents measured that delay against their own inbox files before this
    // was fixed.
    for (const kind of ["channel", "here", "everyone"]) {
      expect(computeMentions("general", `@${kind} read this`, "andrew")).toEqual([kind]);
    }
    // The normalize function converts the raw Slack format into that output, so
    // one rendering step provides the fix and the existing machinery handles the
    // rest.
    //
    // The neighbouring listen tests use the default router. A fake that answers every
    // call the same way leaves the sender unresolved, and the line is filtered before
    // it reaches this assertion.
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "<!channel> everyone read this", user: "U999" }));
    await pump(20);
    void p;
    expect(lines[0]!.text).toBe("@channel everyone read this");
    expect(lines[0]!.mentions).toContain("channel");
    expect(lines[0]!.mentioned).toBe(true);
  });

  test("the two mention paths are SEPARATE: entity pings a human, text wakes an agent", async () => {
    // The receiving agent corrected the framing, and this correction warrants a test
    // because the two gaps require different fixes. The Slack entity drives a human
    // notification. The `mentioned` marker that wakes an agent originates from the
    // text's @name tokens after the system normalizes inbound entities back to names,
    // so a literal name wakes an agent and always did.
    expect(computeMentions("general", "@dev take a look", "andrew")).toEqual(["dev"]);
    // The normalized form of an entity produces the same answer, since <@U111> has
    // become @ana by delivery time.
    expect(computeMentions("general", "@ana take a look", "andrew")).toEqual(["ana"]);
    // The sender never includes itself in its own wake.
    expect(computeMentions("dm/dev/ana", "no names here", "ana")).toEqual(["dev"]);
  });

  test("a name the ROSTER does not know is looked up, so a new joiner gets pinged", async () => {
    // When a third agent joined, the system stored `@alignment_benchmark` as plain
    // text with no entity, so they received no ping. The roster is written at
    // onboarding, so anyone who joins afterwards is absent from it, and the conversion
    // left the name literal. This behavior follows the same structure as the channel
    // map.
    let posted = "";
    let listed = 0;
    const h = make({}, async (url, init) => {
      const u = String(url);
      if (u.includes("users.list")) {
        listed += 1;
        return new Response(
          JSON.stringify({ ok: true, members: [{ id: "U777", name: "newcomer" }, { id: "UDEL", name: "ghost", deleted: true }] }),
          { status: 200 },
        );
      }
      if (u.includes(POST)) {
        posted = JSON.parse(String(init?.body)).text as string;
        return new Response(JSON.stringify({ ok: true, ts: "9.9", message: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, teams: [{ id: "T1" }] }), { status: 200 });
    });
    expect(await h.backend.post("general", "@newcomer welcome", "alice")).toMatchObject({ ok: true });
    expect(posted).toBe("<@U777> welcome");
    expect(listed).toBe(1);

    // The system keeps a name that Slack lacks as literal text because it matches
    // no person in the workspace. The lookup does not repeat, so an unknown name
    // costs one page walk for the entire run.
    await h.backend.post("general", "@nobody-here hello", "alice");
    expect(posted).toBe("@nobody-here hello");
    await h.backend.post("general", "@nobody-here again", "alice");
    expect(listed).toBe(1);
  });

  test("a roster the agent already knows costs no lookup at all", async () => {
    let listed = 0;
    let posted = "";
    const h = make({}, async (url, init) => {
      const u = String(url);
      if (u.includes("users.list")) listed += 1;
      if (u.includes(POST)) {
        posted = JSON.parse(String(init?.body)).text as string;
        return new Response(JSON.stringify({ ok: true, ts: "9.9", message: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    // The fixture roster identifies user U111 as `ana`.
    expect(await h.backend.post("general", "@ana here", "alice")).toMatchObject({ ok: true });
    expect(posted).toBe("<@U111> here");
    expect(listed).toBe(0);
  });

  test("an upload converts @names in its comment, so a mention NOTIFIES", async () => {
    // When a message opened with the operator's name, Slack stored it literally, so
    // the operator had no notification on an answer he had asked for. The upload posts
    // its text as initial_comment and never denormalized it, while chat.postMessage
    // did.
    let comment = "";
    const h = make({}, async (url, init) => {
      if (url.includes("files.getUploadURLExternal")) {
        return new Response(JSON.stringify({ ok: true, upload_url: "https://u/x", file_id: "F1" }), { status: 200 });
      }
      if (url.includes("files.completeUploadExternal")) {
        // This endpoint accepts form-encoded data. Parsing the payload as JSON threw an
        // error inside the test fake and surfaced as "slack request failed", which
        // appeared to be a network fault while the product was doing the right thing.
        comment = new URLSearchParams(String(init?.body ?? "")).get("initial_comment") ?? "";
        // The upload path requires the permalink and refuses without one, because
        // nothing
        // can attach the file to a message without it.
        return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://p/1" }] }), { status: 200 });
      }
      if (url.startsWith("https://u/")) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const f = join(makeTmpDir("upload-mention"), "a.txt");
    writeFileSync(f, "bytes");
    // The fixture config maps `general`, and its roster lists U111 as `ana`.
    const r = await h.backend.upload("general", f, "alice", undefined, "@ana here is the file");
    expect(r.ok).toBe(true);
    expect(comment).toBe("<@U111> here is the file");
  });

  test("a thread_ts Slack accepts and IGNORES is reported, not read as success", async () => {
    // When measured against the real workspace, posting with a `ts` that names no
    // message returns `ok:true`, puts the line at the top level, and returns no
    // `message.thread_ts`. One mistyped digit put a reply to the operator outside
    // the thread it answered, and the send reported success.
    const h = make({}, async (url) =>
      url.includes("chat.postMessage")
        ? new Response(JSON.stringify({ ok: true, ts: "9.9", message: {} }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await h.backend.post("general", "hi", "bob", "1787359458.075769");
    expect(r.ok).toBe(true);
    // Because the message reached the channel, a caller that retried on a failure here
    // would say everything twice.
    expect(r.ok ? r.problem : "").toContain("TOP LEVEL");
    expect(r.ok ? r.problem : "").toContain("1787359458.075769");
    expect(r.ok ? r.problem : "").toContain("9.9");
  });

  test("a thread_ts naming a REPLY is hoisted, and the hoist is reported", async () => {
    // Measurements against the real workspace show that Slack has no nested
    // threads, so a `thread_ts` naming a reply puts the message in that reply's
    // root and answers with the root's `ts`. A check for whether the message
    // threaded at all passes while the message sits in a different conversation
    // than the one requested, which is how a peer on the measured commit saw no
    // warning.
    const h = make({}, async (url) =>
      url.includes("chat.postMessage")
        ? new Response(JSON.stringify({ ok: true, ts: "9.9", message: { thread_ts: "root-1" } }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await h.backend.post("general", "hi", "bob", "reply-7");
    expect(r.ok).toBe(true);
    const said = r.ok ? (r.problem ?? "") : "";
    expect(said).toContain("in thread root-1");
    expect(said).toContain("NOT in reply-7");
    expect(said).toContain("hoisted");
  });

  test("a thread that DID take carries no problem", async () => {
    const h = make({}, async (url) =>
      url.includes("chat.postMessage")
        ? new Response(JSON.stringify({ ok: true, ts: "9.9", message: { thread_ts: "root-1" } }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await h.backend.post("general", "hi", "bob", "root-1");
    // The reply returns its own timestamp so the ledger can record which message
    // closed an item. The ledger previously recorded a wall-clock string that named
    // nothing anyone could look up, and `inbox trace` printed that string. The root
    // message timestamp returns alongside it, so a read-back queries the thread that
    // holds the message. The timestamp the caller passed can name a reply that Slack
    // hoisted.
    expect(r).toEqual({ ok: true, ts: "9.9", thread: "root-1" });
    // The system never asks about threading for an unthreaded post.
    expect(await h.backend.post("general", "hi", "bob")).toEqual({ ok: true, ts: "9.9" });
  });

  test("an unknown channel is a failure naming the channel AND what was asked", async () => {
    const h = make();
    const r = await h.backend.post("nope", "hi", "bob");
    expect(r.ok).toBe(false);
    // Both parts of the output matter. The channel name shows the reader which channel
    // was queried. The output also confirms that the lookup ran and returned without
    // the channel, so the reader can distinguish this result from a case where Slack
    // refused the request. In this organization, Slack always refused the request
    // because the listing call requires a team_id that the caller did not provide.
    // Without a team_id, the call returns missing_argument, and every name resolved to
    // the same not-found sentence that a typo produces.
    expect(r.ok ? "" : r.error).toContain("no Slack channel for channel nope");
    expect(r.ok ? "" : r.error).toContain("this agent is not in a channel by that name");
  });

  test("a channel NAME resolves through the WORKSPACE id, never the enterprise id", async () => {
    // This logic prevents a failure measured on a real Enterprise Grid organization.
    // On an enterprise install, `auth.test` reports `team_id` equal to the `E…` ORG,
    // identical to its own `enterprise_id`. A listing call returns
    // `team_access_not_granted` for that identifier, as measured against
    // `conversations.list` when this lookup used that call. `auth.teams.list` is the
    // only method that names the workspace. Reading `team_id` produced an identifier
    // that was wrong in a way whose error named neither the field nor the fix.
    const seen: string[] = [];
    const h = make({}, async (url) => {
      seen.push(url);
      if (url.includes("auth.test")) {
        return new Response(
          JSON.stringify({ ok: true, team_id: "E01EXAMPLE1", enterprise_id: "E01EXAMPLE1", is_enterprise_install: true }),
          { status: 200 },
        );
      }
      if (url.includes("auth.teams.list")) {
        return new Response(JSON.stringify({ ok: true, teams: [{ id: "T01EXAMPLE1", name: "Example Corp" }] }), { status: 200 });
      }
      if (url.includes("users.conversations")) {
        // Slack rejects the organization ID outright.
        if (url.includes("team_id=E01EXAMPLE1")) {
          return new Response(JSON.stringify({ ok: false, error: "team_access_not_granted" }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, channels: [{ id: "C9", name: "invited" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const r = await h.backend.post("invited", "hi", "bob");
    expect(r).toEqual({ ok: true });
    expect(seen.some((u) => u.includes("users.conversations") && u.includes("team_id=T01EXAMPLE1"))).toBe(true);
    expect(seen.some((u) => u.includes("users.conversations") && u.includes("team_id=E01EXAMPLE1"))).toBe(false);
  });

  test("a login covering several workspaces names none of them rather than guessing", async () => {
    const seen: string[] = [];
    const h = make({}, async (url) => {
      seen.push(url);
      if (url.includes("auth.teams.list")) {
        return new Response(JSON.stringify({ ok: true, teams: [{ id: "T1" }, { id: "T2" }] }), { status: 200 });
      }
      if (url.includes("users.conversations")) {
        return new Response(JSON.stringify({ ok: true, channels: [{ id: "C9", name: "invited" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    expect(await h.backend.post("invited", "hi", "bob")).toEqual({ ok: true });
    // If a request provides no `team_id` across two workspaces, no single right answer
    // exists, so Slack decides and the system reports its refusal, if any.
    expect(seen.some((u) => u.includes("users.conversations") && u.includes("team_id="))).toBe(false);
  });

  test("a RAW channel id is the answer, without asking Slack to name a channel after it", async () => {
    const seen: string[] = [];
    const h = make({}, async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    expect(await h.backend.post("C0EXAMPLE007", "hi", "bob")).toEqual({ ok: true });
    expect(seen.some((u) => u.includes("users.conversations"))).toBe(false);
  });

  test("a threaded reply keeps its metadata, so its origin and status survive the read", async () => {
    // Every read passed include_all_metadata except the thread expansion, so replies
    // returned without origin information. Because origin information was missing,
    // `peers` could not name the host or commit that wrote a reply, and status lines
    // inside a thread appeared as ordinary talk.
    let repliesUrl = "";
    const h = make({}, async (url) => {
      if (url.includes("conversations.history"))
        return new Response(
          JSON.stringify({ ok: true, messages: [{ ts: "1.1", thread_ts: "1.1", reply_count: 1, text: "root" }] }),
          { status: 200 },
        );
      if (url.includes("conversations.replies")) {
        repliesUrl = url;
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
      }
      return okRouter(url);
    });
    await h.backend.history("general", undefined, "bob");
    expect(repliesUrl).toContain("include_all_metadata=true");
  });

  test("the read expands the threads with the NEWEST replies, never the newest roots", async () => {
    // When the system picked 5 roots by root age, an agent replying in an older thread
    // read the channel back, saw no new messages, decided that the send had failed,
    // and posted the same report five times.
    const asked: string[] = [];
    const CAP = THREAD_EXPANSION_CAP;
    const roots = Array.from({ length: CAP + 1 }, (_, i) => ({
      ts: `${100 + i}.1`,
      thread_ts: `${100 + i}.1`,
      reply_count: 1,
      // The oldest root contains the newest reply.
      latest_reply: i === 0 ? "999.9" : `${200 + i}.1`,
      text: `root ${i}`,
    }));
    const h = make({}, async (url) => {
      if (url.includes("conversations.history"))
        return new Response(JSON.stringify({ ok: true, messages: [...roots].reverse() }), { status: 200 });
      if (url.includes("conversations.replies")) {
        asked.push(url);
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
      }
      return okRouter(url);
    });
    const read = await h.backend.history("general", undefined, "bob");
    expect(asked).toHaveLength(CAP);
    // The oldest root holds the newest reply and is expanded.
    expect(asked.some((u) => u.includes(encodeURIComponent("100.1")))).toBe(true);
    expect(read.problems.join(" ")).toContain("an absence here is not proof");
  });

  test("storedMessage pages a thread until it finds the reply", async () => {
    // The `conversations.replies` method returns a thread in oldest-first order, so a
    // newly posted reply sits on the last page. A single 200-reply request responded
    // with "slack has no message at <ts>" for a message in the thread, and a sender
    // who trusts that response posts again.
    const pagesSeen: string[] = [];
    const h = make({}, async (url) => {
      if (url.includes("conversations.replies")) {
        pagesSeen.push(url);
        return new Response(
          JSON.stringify(
            url.includes("cursor=page2")
              ? { ok: true, messages: [{ ts: "9.9", text: "the reply" }] }
              : { ok: true, messages: [{ ts: "1.1", text: "the root" }], response_metadata: { next_cursor: "page2" } },
          ),
          { status: 200 },
        );
      }
      return okRouter(url);
    });
    expect(await h.backend.storedMessage("general", "9.9", "bob", "1.1")).toEqual({
      ok: true,
      text: "the reply",
      mentions: [],
    });
    expect(pagesSeen).toHaveLength(2);
  });

  test("a read-back counts a BROADCAST as the live mention it is", async () => {
    // The entity list contained only user entities, so a stored `<!channel>`
    // returned no mentions and `--verify` reported that the broadcast notified
    // NOBODY. During a test send, an agent read this output and took it as proof
    // that the room was never pinged.
    const h = make({}, async (url) =>
      url.includes("conversations.history")
        ? new Response(JSON.stringify({ ok: true, messages: [{ ts: "5.5", text: "<!channel> install it" }] }), {
            status: 200,
          })
        : okRouter(url),
    );
    expect(await h.backend.storedMessage("general", "5.5", "bob")).toEqual({
      ok: true,
      text: "@channel install it",
      mentions: ["channel"],
    });
  });

  test("a read-back that runs out of pages says how far it looked", async () => {
    const h = make({}, async (url) =>
      url.includes("conversations.replies")
        ? new Response(JSON.stringify({ ok: true, messages: [{ ts: "1.1", text: "the root" }] }), { status: 200 })
        : okRouter(url),
    );
    const got = await h.backend.storedMessage("general", "9.9", "bob", "1.1");
    expect(got).toEqual({
      ok: false,
      error: "slack has no message at 9.9 in general, searched 1 page(s) of thread 1.1",
    });
  });

  test("a REFUSED lookup is not reported as a missing channel", async () => {
    const h = make({}, async (url) =>
      url.includes("users.conversations")
        ? new Response(JSON.stringify({ ok: false, error: "missing_argument" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await h.backend.post("nope", "hi", "bob");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("missing_argument");
    expect(r.ok ? "" : r.error).toContain('NOT "no such channel"');
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
    // The fake implementation responds as Slack does when a thread succeeds, echoing
    // the message's `thread_ts`. Omitting that value produces the dropped-thread case,
    // which the test below covers.
    const h = make({}, async (url) =>
      url.includes(POST)
        ? new Response(JSON.stringify({ ok: true, ts: "9.9", message: { thread_ts: "1.1" } }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await h.backend.post("general", "hi", "alice", "1.1");
    expect(r).toEqual({ ok: true, ts: "9.9", thread: "1.1" });
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

// ## History

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

  test("THE CURSOR FILTERS THE LINES, since Slack's oldest filters the roots", async () => {
    // An agent read a channel whose recent traffic lives inside old threads, passed
    // `--after` with a recent timestamp, and got nothing: the roots sat before the
    // cursor, so Slack returned none of them and their new replies came with none of
    // them. The read asks for the recent window and drops what sits at or before the
    // cursor, after the threads are in.
    const urls: string[] = [];
    const h = make({}, async (url) => {
      urls.push(String(url));
      if (String(url).includes("conversations.replies")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts: "5", text: "the old root", user: "U1" },
              { ts: "9", text: "a reply after the cursor", user: "U1", thread_ts: "5" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, messages: [{ ts: "5", text: "the old root", user: "U1", thread_ts: "5", reply_count: 1, latest_reply: "9" }] }),
        { status: 200 },
      );
    });
    const r = await h.backend.history("general", "7");
    expect(r.code).toBe(0);
    // No `oldest` reaches Slack, and the reply newer than the cursor comes back while
    // the root at "5" does not.
    expect(urls.join(" ")).not.toContain("oldest=");
    expect(r.messages.map((m) => m.ts)).toEqual(["9"]);
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
    // History returns every line. The output retains messages with a `bot_id`,
    // including posts from the reading agent itself, and skips only lines that Slack
    // sent with no text at all.
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
    // The read returns a transcript. The operation performs no self-suppression, so
    // the agent's own line and a peer's line both come back, matching a direct
    // conversations.history read.
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
    // The root appears exactly once and carries no thread.
    const root = r.messages.filter((m) => m.ts === "5.0");
    expect(root).toHaveLength(1);
    expect(root[0]!.text).toBe("root"); // the root's own text, not the replies' first-entry dup
    expect("thread" in root[0]!).toBe(false);
    // Each reply carries a thread identifier equal to the root message timestamp.
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
    // `conversations.history` returns results in newest-first order, where index 0 is
    // the newest root.
    const roots = [...Array(THREAD_EXPANSION_CAP + 2)].map((_, i) => `root${i}.0`);
    const h = make({}, async (url) => {
      if (url.includes(REPLIES)) {
        // The root and one reply are echoed back so expansions are observable.
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
    // The system sends exactly CAP conversations.replies requests, satisfying only
    // the cap.
    const reqs = h.fetches.filter((f) => f.url.includes(REPLIES));
    expect(reqs.length).toBe(THREAD_EXPANSION_CAP);
    // The system expanded the newest roots (idx 0..CAP-1) and dropped the oldest
    // roots (idx CAP..end).
    const expanded = reqs.map((f) => f.url.split("ts=")[1]!.split("&")[0]!);
    for (let i = 0; i < THREAD_EXPANSION_CAP; i++) expect(expanded).toContain(roots[i]!);
    for (let i = THREAD_EXPANSION_CAP; i < roots.length; i++) expect(expanded).not.toContain(roots[i]!);
    // Each expanded root includes its reply, which carries `thread == root`.
    for (let i = 0; i < THREAD_EXPANSION_CAP; i++) {
      const reply = r.messages.find((m) => m.text === `reply to ${roots[i]!}`);
      expect(reply?.thread).toBe(roots[i]!);
    }
    // The system sends no reply for the dropped roots, and the problems list names
    // the drop.
    for (let i = THREAD_EXPANSION_CAP; i < roots.length; i++) {
      expect(r.messages.find((m) => m.text === `reply to ${roots[i]!}`)).toBeUndefined();
    }
    expect(r.problems.some((p) => p.includes(`${roots.length - THREAD_EXPANSION_CAP} threaded root(s) left unexpanded`))).toBe(true);
  });


  // --- status filtering: the SEAM the defect is about --------------------
  // A living status is a message sent by chat.postMessage with the fixed text
  // "working" and its timestamp recorded in the status ledger. A read or a
  // delivery must exclude this status message using the timestamp from the
  // ledger. Filtering by text would discard a human user sending `working`, which
  // is a real message. The caller (src/cli.ts) reads the ledger and passes the set
  // of status timestamps, because the backend has no knowledge of where the
  // ledger lives.




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
    // The system keeps top-level messages intact.
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
    // When a threaded reply includes a mention and a file, the reply text names alice
    // and the file downloads onto the line, exactly as a live thread reply does.
    const reply = r.messages.find((m) => m.text.startsWith("@alice"))!;
    expect(reply.mentions).toContain("alice");
    // The connection transmits the file's metadata. A history read produces a
    // transcript and fetches no bytes, regardless of whom it names.
    expect(reply.files![0]!.id).toBe("F5");
    expect(reply.files![0]!.path).toBeUndefined();
  });
});

// ## listen

describe("listen", () => {
  test("delivers one line per matching message, mentioned stamped for the agent", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ text: "@alice check" }));
    await pump(5);
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
    void p;
    expect(lines).toHaveLength(1);
    const d = lines[0] as Record<string, unknown>;
    expect(d.channel).toBe("general");
    expect(d.from).toBe("ana");
    expect(d.mentions).toContain("alice");
    expect(d.mentioned).toBe(true);
  });

  test("a message from a DIFFERENT agent (own bot_id) IS delivered and mentions the reader", async () => {
    // A peer app's post originates outside the reading agent, so the system must
    // deliver it. When the post names the reading agent, `mentioned` is true.
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ bot_id: "B222", text: "@alice hello from another app" })); // U111 -> ana resolves, so from = ana
    await pump(8);
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
    void p;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.from).toBe("ana");
    expect(lines[0]!.mentioned).toBe(true);
  });

  test("the reading agent's OWN identity is NOT delivered to that listener", async () => {
    // The system suppresses a message when the resolved sender name matches the
    // consuming agent, because an agent must not answer itself. This check compares
    // the sender name directly without using a bot list.
    const h = make({ roster: { U1000: "alice" } });
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ user: "U1000", bot_id: "B999", text: "my own post" })); // from == alice == as
    await pump(8);
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
    void p;
    expect(lines).toHaveLength(0);
  });


  test("a status ts absent from the ledger is still delivered", async () => {
    // The system holds back only a timestamp that the caller marks as a status. A
    // timestamp not in the ledger delivers normally.
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ ts: "1.1", text: "@alice hi" })); // 1.1 not a status
    await pump(8);
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
    void p;
  });

  test("a disconnect frame closes the socket cleanly", async () => {
    const h = make();
    const p = h.backend.listen([], "alice", () => {}, () => {});
    await pump();
    h.sockets[0]?.onmessage?.(JSON.stringify({ type: "disconnect" }));
    expect(h.sockets[0]!.closed).toEqual([{ code: 1000, reason: "disconnect" }]);
    // The disconnect closes the socket. The listen process treats this closure as a
    // drop and attempts to reconnect, which never resolves in the healthy path. The
    // assertion above already ran, so do not await it.
    void p;
  });

  test("non-JSON frames are ignored without events", async () => {
    const h = make();
    const lines: unknown[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    h.sockets[0]?.onmessage?.("garbage");
    await pump(5);
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
    void p;
    expect((lines[0] as Record<string, unknown>).channel).toBe("dm/alice/ana");
  });

  test("a connection that opened then drops RECONNECTS (backoff), staying alive", async () => {
    // Once a connection has worked, the listener retries a drop by opening a second
    // socket. Tests reach this path because the injected sleep resolves immediately.
    const h = make();
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    expect(h.sockets).toHaveLength(1);
    // Deliver an event, then drop the socket. The stream must REOPEN and keep
    // delivering on the new connection.
    emit(h, msg({ text: "before drop" }));
    await pump(8);
    expect(lines).toHaveLength(1);
    h.sockets[0]!.close();
    await pump(12);
    // A second connection was opened to reconnect because the first connection
    // dropped.
    expect(h.sockets.length).toBeGreaterThan(1);
    // The new socket continues to deliver.
    emit2(h, msg({ text: "after reconnect" }));
    await pump(8);
    expect(lines[1]!.text).toBe("after reconnect");
    // The operation never resolves in the healthy path. Leave it pending on the new
    // socket.
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
    // A threaded delivery now queries Slack for the thread's participants, so it
    // settles one round-trip later than a top-level delivery. The fake clock must
    // reach it.
    await pump(10);
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
    void p;
    expect("thread" in lines[0]!).toBe(false);
  });

  test("the FIRST socket-open refusal fails listen with code 1 instead of retrying", async () => {
    // A connection that has never once succeeded must exit with code 1 and output
    // `scramble could not look`. A silent retry of the same refusal turns into an
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
    // A broken credential must not read as a silent channel. Running `next` against
    // an invalid app token fails nonzero with both Slack's error and the config key.
    // `make()` keeps the clock fixed so the open-refusal (a fast HTTP response)
    // settles before any timeout, which is the ordering a real `next()` sees when the
    // connection is refused in milliseconds against a seconds-long timeout.
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
    // When a working app token opens the socket, a quiet channel results in a
    // no-message timeout, and that timeout stays 64.
    const h = makeTimed(); // socket open succeeds (okRouter)
    const p = h.backend.next([], "alice", 1, () => {});
    const r = await p;
    expect(r).toEqual({ code: 64 });
  });
});

// ## CLI wiring

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

  test("with neither given, the backend FOLLOWS THE CONFIG on disk", () => {
    // The system previously defaulted to the local backend regardless of the
    // configuration, which is a failure surface. The local backend answers from a
    // store the listener fills, so a Slack agent that forgot the variable received
    // a TRANSCRIPT where an error belonged. `message read` on the channel the
    // operator had just invited it into printed nothing and exited 0 while Slack
    // held twenty messages in it.
    const dir = makeTmpDir("backend-default");
    mkdirSync(join(dir, ".scramble"), { recursive: true });
    const io = stubIo({ env: () => undefined, cwd: () => dir });
    expect(selectBackend(["message", "read"], io)).toBe("local");
    writeFileSync(
      join(dir, ".scramble", "slack.json"),
      JSON.stringify({ token: "xoxb-x", channels: {}, agents: { dev: { token: "T" } } }),
    );
    expect(selectBackend(["message", "read"], io)).toBe("slack");
    // An explicit choice still takes precedence over the file in both directions.
    expect(selectBackend(["message", "read", "--backend", "local"], io)).toBe("local");
  });
});

describe("slack commands through main", () => {
  /**
   *  The function writes a valid Slack configuration into a scratch workspace and
   *  returns an I/O object whose `cwd` points to that workspace.
   */
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

  test("a ledger that cannot be updated REPORTS itself and the message still goes", async () => {
    // The reply reached the channel, which was the primary objective. The accounting
    // failed, and that failure must be stated directly. A ledger that silently counts
    // nothing would appear as an inbox with nothing owed.
    const { io, errs } = configuredIo({
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      createSocket: () => new FakeSocket(),
    });
    const dir = io.cwd();
    mkdirSync(join(dir, ".scramble", "inbox"), { recursive: true });
    // A row must exist for the close operation to attempt a write.
    writeFileSync(
      join(dir, ".scramble", "inbox", "bob.jsonl"),
      `${JSON.stringify({ id: "1", channel: "general", from: "ana", text: "hi", at: "2026-08-22T00:00:00Z" })}\n`,
    );
    // Test the file itself, since a directory's write bit governs creating and
    // unlinking, so an existing file inside a locked directory is still writable and
    // the test would prove nothing.
    chmodSync(join(dir, ".scramble", "inbox", "bob.jsonl"), 0o400);
    try {
      const code = await main(["post", "general", "hi", "--as", "bob", "--backend", "slack"], io);
      expect(code).toBe(0);
      expect(errs.join(" ")).toContain("inbox ledger not updated");
    } finally {
      chmodSync(join(dir, ".scramble", "inbox", "bob.jsonl"), 0o600);
    }
  });

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

  test("a delivery keeps Slack's own bytes when the rendering changed them", async () => {
    // The wake file is the archive. Slack has already lost four of the five messages
    // the calibration table rests on, and an archive that holds only the rendered
    // form stops being checkable the day the rendering changes. The unescape step
    // arrived after listeners had written thousands of lines, and three agents spent
    // an hour reconciling three hashes of one message.
    const run = async (text: string): Promise<{ text: string; raw?: string }> => {
      const sockets: FakeSocket[] = [];
      const { io, writes } = configuredIo({
        fetch: async (url) => {
          if (String(url).includes(SOCKET_OPEN)) return new Response(JSON.stringify({ ok: true, url: "wss://s" }), { status: 200 });
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
      sockets[0]?.onmessage?.(frame({ type: "message", channel: "C1", user: "U123", text, ts: "1" }));
      await p;
      return JSON.parse(writes[0]!) as { text: string; raw?: string };
    };
    const escaped = await run("@alice run it with --as &lt;me&gt;");
    expect(escaped.text).toBe("@alice run it with --as <me>");
    expect(escaped.raw).toBe("@alice run it with --as &lt;me&gt;");
    // A plain message contains no second copy, since the rendering left it
    // byte-exact.
    const plain = await run("@alice hi");
    expect(plain.text).toBe("@alice hi");
    expect(plain.raw).toBeUndefined();
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
      // Disable the status-expiry ticker so the reconnecting listen (which never
      // resolves) leaves no lingering timer behind. The delivered line already proves
      // the stream works.
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
    // The listener reconnects on a drop and never resolves in the healthy path.
    // The delivered line is already written, so assert and leave main pending.
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
    // A broken credential must surface as "scramble could not look" with exit
    // code 1. Exit code 64 indicates a quiet channel. Standard error names both the
    // Slack error and the appToken configuration key.
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
// Every network seam is injected, so downloading a Slack message's `files`
// needs no token and no network. The fake fetch serves url_private from a
// queue. The process writes the bytes into a temporary filesDir and reads them
// back to prove the download arrived on the line.

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
        // The system uses the acting agent's (alice's) bot token for inbound downloads,
        // because file access follows the application.
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer T_ALICE");
        return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      return okRouter(String(url));
    });
    const lines: Delivery[] = [];
    const problems: string[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), (pr) => problems.push(pr));
    await pump();
    emit(h, msg({ text: "@alice see the screenshot", files: [{ id: "F1", name: "shot cat.png", url_private: "https://files.slack.com/v1/F1", mimetype: "image/png", size: 21 }] }));
    await pump(20);
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    emit(h, msg({ text: "@alice file", files: [{ id: "F2", name: "x.html", url_private: "https://files.slack.com/x", mimetype: "text/html" }] }));
    await pump(20);
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    // listen reconnects on a drop and never resolves in the healthy path, so the
    // assertions above already ran. Do not await p.
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
    emit(h, msg({ text: "@alice here", files: [{ id: "F3", name: "a.bin", url_private: "https://files.slack.com/f3", mimetype: "application/octet-stream" }] }));
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
    // A transcript carries metadata and contains no file bytes. A history read
    // addresses no messages to any recipient. Pulling every file a channel ever
    // carried placed three copies of one 41MB archive on one host. The command
    // `attachment view <id>` fetches the bytes from Slack when an operator requests
    // them.
    expect(r.messages[0]!.files![0]!.id).toBe("H1");
    expect(r.messages[0]!.files![0]!.name).toBe("doc.txt");
    expect(r.messages[0]!.files![0]!.path).toBeUndefined();
    expect(r.problems).toHaveLength(0);
  });
});

// --- acting-agent credentials -------------------------------------------
// Previously, only `post` honored the acting agent's credential. Every other call
// (read, threaded-reply expansion, attachment download, socket connect) used the
// configuration's default token regardless of the acting agent. These tests prove
// that each path now uses the acting agent's credential, with the default token
// serving only as a fallback.

describe("acting-agent credentials", () => {
  test("a read as agent B (with a token) goes out with B's token", async () => {
    // Alice has her own token T_ALICE. A history read performed as Alice must carry
    // it.
    const h = make({}, async (url) => {
      if (String(url).includes(HISTORY)) {
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1", user: "U111", text: "hi" }] }), { status: 200 });
      }
      return okRouter(String(url));
    });
    const r = await h.backend.history("general", undefined, "alice");
    expect(r.code).toBe(0);
    const call = h.fetches.find((f) => f.url.includes(HISTORY))!;
    expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer T_ALICE");
  });

  test("a read as an agent with no token of its own uses the DEFAULT token", async () => {
    // The base configuration contains no token for bob, so his read operations must
    // use the default.
    const h = make({}, async (url) => {
      if (String(url).includes(HISTORY)) {
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1", user: "U111", text: "hi" }] }), { status: 200 });
      }
      return okRouter(String(url));
    });
    const r = await h.backend.history("general", undefined, "bob");
    expect(r.code).toBe(0);
    const call = h.fetches.find((f) => f.url.includes(HISTORY))!;
    expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer xoxb-app");
  });

  test("a threaded-reply expansion uses the acting agent's token", async () => {
    // The `conversations.replies` call must also include Alice's credential.
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
    const r = await h.backend.history("general", undefined, "alice");
    expect(r.code).toBe(0);
    // The root renders with `T_ALICE` on its history call.
    expect(r.messages.find((m) => m.text === "root")).toBeTruthy();
    expect(r.messages.find((m) => m.text === "reply")).toBeTruthy();
    const repl = h.fetches.find((f) => f.url.includes(REPLIES))!;
    expect((repl.init?.headers as Record<string, string>).authorization).toBe("Bearer T_ALICE");
  });

  test("the inbound attachment download rides the acting agent's token", async () => {
    // When listening as alice, the download of the message's file carries T_ALICE.
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
    emit(h, msg({ text: "@alice file", files: [{ id: "FC", name: "c.bin", url_private: "https://files.slack.com/fc", mimetype: "application/octet-stream" }] }));
    await pump(12);
    // listen reconnects on a drop, and it never resolves along the healthy path, so
    // the assertions above have already run. Do not await p.
    void p;
    expect(lines[0]!.files![0]!.path).toContain("FC-c.bin");
  });

  test("the socket connect uses the acting agent's appToken when present", async () => {
    // Carol has her own appToken. A listen session as Carol must open with it.
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
    // listen reconnects on a drop, and it never resolves along the healthy path, so
    // the assertions above have already run. Do not await p.
    void p;
    const open = h.fetches.find((f) => f.url.includes(SOCKET_OPEN))!;
    expect((open.init?.headers as Record<string, string>).authorization).toBe("Bearer xapp-carol");
  });

  test("the socket connect falls back to the top-level appToken when an agent has none", async () => {
    // Alice has no per-agent `appToken`, so her connection must use `xapp-1`.
    const h = make({}, async (url) => {
      if (String(url).includes(SOCKET_OPEN)) {
        return new Response(JSON.stringify({ ok: true, url: "wss://s" }), { status: 200 });
      }
      return okRouter(String(url));
    });
    const p = h.backend.listen([], "alice", () => {}, () => {});
    await pump();
    // listen reconnects on a drop, and it never resolves along the healthy path, so
    // the assertions above have already run. Do not await p.
    void p;
    const open = h.fetches.find((f) => f.url.includes(SOCKET_OPEN))!;
    expect((open.init?.headers as Record<string, string>).authorization).toBe("Bearer xapp-1");
  });

  test("a read with no per-agent token and no default fails naming the agent and the key", async () => {
    // If `token:""` has no default and `dave` has no token, the read operation must
    // fail loudly.
    const h = make({ token: "", agents: { dave: { appToken: "xapp-dave" } } });
    const r = await h.backend.history("general", undefined, "dave");
    expect(r.code).toBe(1);
    expect(r.error).toContain("dave");
    expect(r.error).toContain("token");
  });
});

describe("a mention of the agent's Slack handle addresses the agent", () => {
  // Slack resolves <@U…> to the application handle. A handle differs from a
  // scramble name: the handle for `scramble-dev` is `scramble_dev`. In live
  // measurements, an incoming mention arrived as mentions:["scramble_dev"] with
  // mentioned:false, so the tier-one wake path, which filters on
  // `'"mentioned":true'`, slept through a message addressed to that agent.
  async function deliver(agents: SlackBackendConfig["agents"], as: string, text: string) {
    const h = make({ agents, roster: { U111: "andrew" } });
    const lines: Array<Record<string, unknown>> = [];
    const p = h.backend.listen(["general"], as, (d) => lines.push(d as unknown as Record<string, unknown>), () => {});
    await pump();
    emit(h, msg({ text }));
    await pump(5);
    void p;
    return lines;
  }

  test("mentioned is true when the line names the handle rather than the name", async () => {
    const lines = await deliver(
      { "scramble-dev": { token: "T_DEV", handle: "scramble_dev" } },
      "scramble-dev",
      "@scramble_dev can you see my message",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.mentions).toEqual(["scramble_dev"]);
    expect(lines[0]!.mentioned).toBe(true);
  });

  test("the scramble name still addresses the agent", async () => {
    const lines = await deliver(
      { "scramble-dev": { token: "T_DEV", handle: "scramble_dev" } },
      "scramble-dev",
      "@scramble-dev over here",
    );
    expect(lines[0]!.mentioned).toBe(true);
  });

  test("another agent's handle does NOT address this one", async () => {
    const lines = await deliver(
      {
        "scramble-dev": { token: "T_DEV", handle: "scramble_dev" },
        "other-agent": { token: "T_OTH", handle: "other_agent" },
      },
      "scramble-dev",
      "@other_agent your turn",
    );
    expect(lines[0]!.mentioned).toBe(false);
  });

  test("an agent with no recorded handle is matched on its name alone", async () => {
    const lines = await deliver({ alice: { token: "T_A" } }, "alice", "@alice hello");
    expect(lines[0]!.mentioned).toBe(true);
  });
});

describe("who said it: operator, teammate, or agent", () => {
  // The agent evaluates an instruction based on who issued it. Every sender arrives
  // as an ordinary name, so without this an unknown user appears like the operator.
  async function kindOf(ev: Partial<SlackInboundEvent>, cfg?: Partial<SlackBackendConfig>) {
    const h = make({ roster: { U111: "andrew", U999: "someone" }, humanUserId: "U111", ...cfg });
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg(ev));
    await pump(5);
    void p;
    return lines[0];
  }

  test("the human who authorized this session is the operator", async () => {
    expect((await kindOf({ user: "U111", text: "do this" }))!.sender).toBe("operator");
  });

  test("another human is a teammate", async () => {
    expect((await kindOf({ user: "U999", text: "hello" }))!.sender).toBe("teammate");
  });

  test("an app is an agent, whoever its user id belongs to", async () => {
    expect((await kindOf({ user: "U999", bot_id: "B1", text: "from a bot" }))!.sender).toBe("agent");
  });

  test("with no humanUserId configured a person still reads as HUMAN", async () => {
    // Scramble should clearly indicate whether the speaker is a human or an agent.
    // Slack's `bot_id` answers that distinction on every message, so it is never
    // unknown. Specifying which human is speaking requires the config entry, and
    // guessing which one is the operator is still worse than saying nothing.
    const line = await kindOf({ user: "U111", text: "hi" }, { humanUserId: undefined });
    expect(line!.sender).toBe("human");
    const bot = await kindOf({ user: "U111", bot_id: "B1", text: "hi" }, { humanUserId: undefined });
    expect(bot!.sender).toBe("agent");
  });
});

describe("a reply in your own thread wakes you without naming you", () => {
  // Slack treats a thread you participate in as addressed to you. A match based
  // only on your name misses every threaded reply to something you said.
  function withReplies(participants: Array<{ user?: string; bot_id?: string }>) {
    return make({ roster: { U111: "andrew", U222: "alice" } }, (url) => {
      if (url.includes("conversations.replies")) {
        return new Response(JSON.stringify({ ok: true, messages: participants }), { status: 200 });
      }
      return okRouter(url);
    });
  }

  async function deliverReply(h: H) {
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    // The `thread_ts` timestamp differs from `ts`, so the message stays a reply, and the
    // text names nobody.
    emit(h, msg({ user: "U111", text: "what about the parser", ts: "5.5", thread_ts: "1.1" }));
    await pump(8);
    void p;
    return lines[0];
  }

  test("a reply in a thread this agent posted in is mentioned", async () => {
    const line = await deliverReply(withReplies([{ user: "U222" }, { user: "U111" }]));
    expect(line!.thread).toBe("1.1");
    expect(line!.mentions).toEqual([]);
    expect(line!.mentioned).toBe(true);
  });

  test("a reply in a thread this agent is NOT in is not mentioned", async () => {
    const line = await deliverReply(withReplies([{ user: "U111" }]));
    expect(line!.mentioned).toBe(false);
  });

  test("a refused conversations.replies does not invent participation", async () => {
    const h = make({ roster: { U111: "andrew", U222: "alice" } }, (url) =>
      url.includes("conversations.replies")
        ? new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 })
        : okRouter(url));
    expect((await deliverReply(h))!.mentioned).toBe(false);
  });

  test("a TOP-LEVEL message asks Slack nothing about threads", async () => {
    let replies = 0;
    const h = make({ roster: { U111: "andrew" } }, (url) => {
      if (url.includes("conversations.replies")) replies += 1;
      return okRouter(url);
    });
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ user: "U111", text: "plain line", ts: "6.6" }));
    await pump(5);
    void p;
    expect(lines[0]!.mentioned).toBe(false);
    expect(replies).toBe(0);
  });
});

describe("the regular path never touches the Slack CLI credential", () => {
  // Ideally, the operator only needs to authenticate the Slack CLI when a new agent
  // joins the application or to run an emergency diagnostic repair. Regular
  // operations should run through the bot token. Delivery previously exported a
  // peer's application manifest under the CLI credential on every line, which
  // placed a twelve-hour token on the path a listener runs for days.
  test("a delivered line costs no apps.manifest.export", async () => {
    let exports = 0;
    const h = make({ roster: {} }, (url) => {
      if (url.includes("apps.manifest.export")) exports += 1;
      return okRouter(url);
    });
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ user: "U777", bot_id: "B7", text: "a claim about geometry" }));
    await pump(20);
    void p;
    expect(lines).toHaveLength(1);
    expect(exports).toBe(0);
    // The delivery included a bot token with every call it made.
    for (const f of h.fetches) {
      const auth = String((f.init?.headers as Record<string, string> | undefined)?.["authorization"] ?? "");
      expect(auth.startsWith("Bearer xoxe")).toBe(false);
    }
  });
});

describe("a refused call names the scope Slack asked for", () => {
  // Adding a new scope causes the call that requires it to fail with an unrelated
  // one-word error. Slack returns `needed` and `provided` on missing_scope, and the
  // system previously dropped both fields.
  const scoped = (body: Record<string, unknown>) =>
    make({}, async () => new Response(JSON.stringify(body), { status: 200 }));

  test("missing_scope carries what is needed and what the token has", async () => {
    const h = scoped({ ok: false, error: "missing_scope", needed: "reactions:write", provided: "chat:write,users:read" });
    const r = await h.backend.react("general", "9.9", "eyes", "bob");
    expect(r.ok).toBe(false);
    const said = r.ok ? "" : r.error;
    expect(said).toContain("needs reactions:write");
    expect(said).toContain("has chat:write,users:read");
    expect(said).toContain("A scope needs a reinstall");
  });

  test("missing_scope with no detail says that too, rather than inventing one", async () => {
    const h = scoped({ ok: false, error: "missing_scope" });
    const r = await h.backend.react("general", "9.9", "eyes", "bob");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("slack named no scope");
  });

  test("every other error is passed through as Slack sent it", async () => {
    const h = scoped({ ok: false, error: "channel_not_found" });
    const r = await h.backend.react("general", "9.9", "eyes", "bob");
    expect(r.ok ? "" : r.error).toContain("channel_not_found");
  });
});

describe("denormalize: an outgoing @name becomes a real Slack mention", () => {
  // Without this, a mention an agent writes is literal text. Slack displays the
  // mention in grey and sends no notification to a human, while agents still wake
  // because the receive path parses @name itself, so the defect is invisible from
  // an agent's side.
  const roster = { U1: "andrew", U2: "scramble_dev" };

  test("a handle in an inline backtick span stays text, the way a fence does", () => {
    // The processor skipped fenced lines and converted inline spans, so a handle in a
    // span notified that person while `computeMentions` read prose and recorded
    // nothing in their ledger. The scramble skill instructs agents to write examples
    // inside a span for this exact reason.
    expect(denormalize("write `@andrew` in an example", roster)).toBe("write `@andrew` in an example");
    // The system still converts the prose surrounding a span.
    expect(denormalize("`@andrew` and @andrew", roster)).toBe("`@andrew` and <@U1>");
    // A lone backtick is text, so the system still converts the mention beside it.
    expect(denormalize("` @andrew", roster)).toBe("` <@U1>");
    // A fenced block functions as it always did.
    expect(denormalize("```\n@andrew\n```", roster)).toBe("```\n@andrew\n```");
  });

  test("a known name becomes the entity", () => {
    expect(denormalize("@andrew can you confirm", roster)).toBe("<@U1> can you confirm");
  });

  test("A BROADCAST WRITTEN THE WAY AGENTS WRITE IT becomes the entity that notifies", () => {
    // The skill teaches the `@channel` syntax and every agent types it, but the
    // system sent it as plain text. The message displayed a grey `@channel` and
    // notified nobody, while the reading direction of this same pair had been fixed
    // months of incidents ago. A message sent to this channel never pinged the room.
    expect(denormalize("@channel install it", roster)).toBe("<!channel> install it");
    expect(denormalize("@here look", roster)).toBe("<!here> look");
    expect(denormalize("@everyone ok", roster)).toBe("<!everyone> ok");
    // The entity form already acts as the entity.
    expect(denormalize("<!channel> install it", roster)).toBe("<!channel> install it");
    // A span serves as an example, and an address functions as an address.
    expect(denormalize("an @channel in `@channel` a span", roster)).toBe("an <!channel> in `@channel` a span");
    expect(denormalize("mail me at name@channel.com", roster)).toBe("mail me at name@channel.com");
    // A read-back returns the reader's form, so sent text compares against it as an
    // equal.
    expect(readerBroadcasts("<!channel> x <!here> y")).toBe("@channel x @here y");
  });

  test("A QUOTED ENTITY NOTIFIES NOBODY, though Slack parses one inside a fence", () => {
    // Slack parses `<!channel>` and `<@U…>` wherever they appear, so a message that
    // explained the pair pinged the entire room and woke every agent. Escaping the
    // opening bracket keeps the visible text identical.
    expect(denormalize("a span `<!channel>` documenting it", roster)).toBe("a span `&lt;!channel>` documenting it");
    expect(denormalize("```\n<!channel> in a fence\n```", roster)).toBe("```\n&lt;!channel> in a fence\n```");
    expect(denormalize("```\n<@U1> in a fence\n```", roster)).toBe("```\n&lt;@U1> in a fence\n```");
    // In PROSE, a broadcast functions as an address, and it still notifies.
    expect(denormalize("<!channel> read this", roster)).toBe("<!channel> read this");
    // The read-back reverses Slack's escaping, so the author's text compares equal.
    expect(unescapeSlack("a span `&lt;!channel>` documenting it")).toBe("a span `<!channel>` documenting it");
  });

  test("the character before the @ can be ANY non-name character", () => {
    // Because the rule required whitespace or a line start, any mention after a full
    // stop, a comma, a bracket, or a CJK punctuation mark was sent as plain text and
    // notified nobody. Two agents encountered this behavior and both worked around it
    // by inserting a space. One agent provided a clear case where the same message
    // converted the mention at the start of the line and left the mention after the
    // stop unconverted.
    expect(denormalize("\u6536\u5230\u3002@andrew", roster)).toBe("\u6536\u5230\u3002<@U1>");
    expect(denormalize("ok, @andrew next", roster)).toBe("ok, <@U1> next");
    expect(denormalize("(@andrew)", roster)).toBe("(<@U1>)");
  });

  test("a mention at the END of a sentence still notifies", () => {
    // A Slack handle may contain a dot, so the match accepts a dot. When `@name.`
    // occurred at the end of a sentence, the system looked up a handle nobody has, so
    // the mention went out as plain text and notified nobody. A comma or an
    // exclamation mark never did this, since neither is a handle character. The agent
    // whose name it was measured this from raw Slack payloads.
    expect(denormalize("thanks @andrew.", roster)).toBe("thanks <@U1>.");
    expect(denormalize("ask @andrew..", roster)).toBe("ask <@U1>..");
    // A handle that contains a dot retains it.
    expect(denormalize("hi @scramble_dev here", roster)).toBe("hi <@U2> here");
    // A name that nobody answers to remains literal, with or without a dot.
    expect(denormalize("@nobody.", roster)).toBe("@nobody.");
  });

  test("an address and an already-converted entity are left alone", () => {
    // The character preceding an address's @ belongs to a name, and `<` is excluded
    // alongside name characters, so neither counts as a mention.
    expect(denormalize("mail me at me@andrew.dev", roster)).toBe("mail me at me@andrew.dev");
    expect(denormalize("already <@U1> here", roster)).toBe("already <@U1> here");
  });

  test("a name nobody answers to stays LITERAL rather than becoming a broken entity", () => {
    expect(denormalize("@nobody hello", roster)).toBe("@nobody hello");
  });

  test("an @name inside a fenced block is left alone, because it is a code sample", () => {
    const src = ["before @andrew", "```", "grep '@andrew' file", "```", "after @andrew"].join("\n");
    const out = denormalize(src, roster);
    expect(out).toContain("before <@U1>");
    expect(out).toContain("grep '@andrew' file");
    expect(out).toContain("after <@U1>");
  });

  test("an address inside a word is not a mention", () => {
    expect(denormalize("mail me at me@andrew.com", roster)).toBe("mail me at me@andrew.com");
  });

  test("several mentions on one line all convert", () => {
    expect(denormalize("@andrew and @scramble_dev", roster)).toBe("<@U1> and <@U2>");
  });

  test("an empty roster changes nothing", () => {
    expect(denormalize("@andrew hi", {})).toBe("@andrew hi");
  });

  test("post sends the converted text to Slack", async () => {
    let sent = "";
    const h = make({ roster }, (url, init) => {
      if (url.includes("chat.postMessage")) {
        sent = (JSON.parse(String(init?.body)) as { text: string }).text;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return okRouter(url);
    });
    await h.backend.post("general", "@andrew look at this", "alice");
    expect(sent).toBe("<@U1> look at this");
  });
});

describe("an agent is never delivered its own post", () => {
  // The `from` field contains the resolved sender, which represents an application's
  // Slack handle, whereas the `as` field contains the scramble name. Comparing `from`
  // and `as` never produced a match, so the agent woke on its own messages. This
  // behavior was caught when an outgoing reply returned as a wake.
  test("a post from this agent's handle is filtered out", async () => {
    const h = make({
      agents: { "scramble-dev": { token: "T", handle: "scramble_dev" } },
      roster: { U9: "scramble_dev", U1: "andrew" },
    });
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "scramble-dev", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ user: "U9", bot_id: "B9", text: "my own words", ts: "4.1" }));
    await pump(10);
    emit(h, msg({ user: "U1", text: "a real peer", ts: "4.2" }));
    await pump(10);
    void p;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("a real peer");
  });
});

describe("a peer's status is not a message either", () => {
  // The transcript ledger recorded only this agent's own status, so another agent's
  // `working` line arrived in this transcript as if someone had spoken it. The
  // marker travels with the message, so any agent recognises any agent's status.
  test("a line carrying the status marker is dropped from delivery", async () => {
    const h = make({ roster: { U1: "peer" } });
    const lines: Delivery[] = [];
    const p = h.backend.listen(["general"], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ user: "U1", text: "working", ts: "8.1", metadata: { event_type: "scramble_status" } }));
    await pump(8);
    emit(h, msg({ user: "U1", text: "working", ts: "8.2" }));
    await pump(8);
    void p;
    // An unmarked message represents a human (or agent) saying the word, and the
    // system delivers it. The system never bases the decision on the text.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ts).toBe("8.2");
  });

  test("a marked line is absent from history too", async () => {
    const h = make({ roster: { U1: "peer" } }, (url) => {
      if (url.includes("conversations.history")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts: "9.1", user: "U1", text: "working", metadata: { event_type: "scramble_status" } },
              { ts: "9.2", user: "U1", text: "a real line" },
            ],
          }),
          { status: 200 },
        );
      }
      return okRouter(url);
    });
    const r = await h.backend.history("general");
    expect(r.messages.map((m) => m.ts)).toEqual(["9.2"]);
  });

  test("every history read asks Slack for metadata, or the marker is invisible", async () => {
    let asked = "";
    const h = make({}, (url) => {
      if (url.includes("conversations.history")) asked = url;
      return okRouter(url);
    });
    await h.backend.history("general");
    expect(asked).toContain("include_all_metadata=true");
  });

  test("isStatusLine keys on the marker, never on the text", () => {
    expect(isStatusLine({ metadata: { event_type: "scramble_status" } })).toBe(true);
    expect(isStatusLine({ metadata: { event_type: "something_else" } })).toBe(false);
    expect(isStatusLine({})).toBe(false);
  });
});

describe("a channel the agent was invited to but the config does not name", () => {
  // Inviting an agent previously delivered nothing. An unmapped channel id had no
  // name, and the message was dropped silently with nothing reported.
  async function deliverFrom(channelId: string, router?: (u: string) => Response) {
    const h = make({ channels: { general: "C1" }, roster: { U1: "andrew" } }, (url) => {
      if (router && url.includes("conversations.info")) return router(url);
      if (url.includes("conversations.info")) {
        return new Response(JSON.stringify({ ok: true, channel: { name: "new-room" } }), { status: 200 });
      }
      return okRouter(url);
    });
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: channelId, user: "U1", text: "hello somewhere new" }));
    await pump(10);
    void p;
    return { lines, h };
  }

  test("the message ARRIVES, under the name Slack gives the channel", async () => {
    const { lines } = await deliverFrom("C_NEW");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.channel).toBe("new-room");
    expect(lines[0]!.text).toBe("hello somewhere new");
  });

  test("a name Slack will not give falls back to the id, rather than losing the message", async () => {
    const { lines } = await deliverFrom("C_SECRET", () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.channel).toBe("C_SECRET");
  });

  test("a mapped channel is named from the config and asks Slack nothing", async () => {
    let infos = 0;
    const h = make({ channels: { general: "C1" }, roster: { U1: "andrew" } }, (url) => {
      if (url.includes("conversations.info")) infos += 1;
      return okRouter(url);
    });
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "C1", user: "U1", text: "in a known room" }));
    await pump(6);
    void p;
    expect(lines[0]!.channel).toBe("general");
    expect(infos).toBe(0);
  });

  test("the lookup is cached, so a busy new channel is resolved once", async () => {
    let infos = 0;
    const h = make({ channels: { general: "C1" }, roster: { U1: "andrew" } }, (url) => {
      if (url.includes("conversations.info")) {
        infos += 1;
        return new Response(JSON.stringify({ ok: true, channel: { name: "new-room" } }), { status: 200 });
      }
      return okRouter(url);
    });
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    emit(h, msg({ channel: "C_NEW", user: "U1", text: "one", ts: "2.1" }));
    await pump(10);
    emit(h, msg({ channel: "C_NEW", user: "U1", text: "two", ts: "2.2" }));
    await pump(10);
    void p;
    expect(lines).toHaveLength(2);
    expect(infos).toBe(1);
  });
});

describe("being added to a channel reaches the inbox", () => {
  // An agent receives an explicit event when added. An agent that learns it was
  // added only by overhearing later traffic has already missed whatever it was
  // added for.
  function h2() {
    return make({
      channels: { general: "C1" },
      agents: { alice: { token: "T", handle: "alice_bot" } },
      roster: { U_ME: "alice_bot", U_BOSS: "andrew" },
    }, (url) => {
      if (url.includes("conversations.info")) {
        return new Response(JSON.stringify({ ok: true, channel: { name: "art-eval" } }), { status: 200 });
      }
      return okRouter(url);
    });
  }
  async function join(h: H, ev: Partial<SlackInboundEvent>) {
    const lines: Delivery[] = [];
    const p = h.backend.listen([], "alice", (d) => lines.push(d), () => {});
    await pump();
    h.sockets[0]?.onmessage?.(frame({ type: "member_joined_channel", ...ev }));
    await pump(10);
    void p;
    return lines;
  }

  test("this agent joining wakes it, names the channel and who added it", async () => {
    const lines = await join(h2(), { user: "U_ME", channel: "C_NEW", inviter: "U_BOSS", ts: "3.3" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.mentioned).toBe(true);
    expect(lines[0]!.channel).toBe("art-eval");
    expect(lines[0]!.text).toContain("You were added to art-eval by andrew");
    expect(lines[0]!.text).toContain("Read what the channel is doing");
  });

  test("SOMEONE ELSE joining is not this agent's wake", async () => {
    expect(await join(h2(), { user: "U_BOSS", channel: "C_NEW", ts: "3.4" })).toEqual([]);
  });

  test("a join with no inviter still wakes, without inventing one", async () => {
    const lines = await join(h2(), { user: "U_ME", channel: "C_NEW", ts: "3.5" });
    expect(lines[0]!.text).toBe(
      "You were added to art-eval. Read what the channel is doing before you speak in it.",
    );
  });

  test("a join with no channel is dropped rather than half-reported", async () => {
    expect(await join(h2(), { user: "U_ME", ts: "3.6" })).toEqual([]);
  });

  test("with the agent absent from the roster, a join cannot be told apart and is left alone", async () => {
    const h = make({ channels: { general: "C1" }, agents: { alice: { token: "T" } }, roster: {} });
    expect(await join(h, { user: "U_ME", channel: "C_NEW", ts: "3.7" })).toEqual([]);
  });

  test("a join in a channel the config DOES name uses that name", async () => {
    const lines = await join(h2(), { user: "U_ME", channel: "C1", ts: "3.8" });
    expect(lines[0]!.channel).toBe("general");
  });
});

