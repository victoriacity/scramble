// src/cli.ts — the agent-facing CLI. Every command prints ONE JSON line per
// message to stdout and sends all diagnostics to stderr. All IO flows through
// the injected `io` seams so tests drive main() with a fake io and the
// in-process handler from src/server.ts as fetch — no child process, no
// socket, no real delay. Process argv and the real daemon bind live in
// src/bin.ts, which no test imports.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createStore, type ChannelStore } from "./store";
import type { Message, PostResult } from "./types";
import type { ServeOptions } from "./server";
import { SlackBackend, type SlackBackendConfig } from "./slack-backend";
import type { SlackSocket } from "./slack-transport";
import {
  findLocalRecord,
  guessMime,
  recordLocalUpload,
  uploadToSlack,
  sizeOf,
  type Attachment,
} from "./attachments";
import { StatusManager } from "./status";
import { SCOPE_NAMES, BOT_EVENT_NAMES } from "./app-manifest";
import { lintLanguage, languageRefusal, lineOf } from "./language";
import { closeAnsweredBefore, closeInboxItems, inboxPath, isAddressed, pendingInbox, pendingReport, recordInboxItem } from "./inbox";

const DEFAULT_URL = "http://127.0.0.1:7737";
const MAX_BACKOFF = 2000; // ms cap on reconnect delay

export interface Io {
  /** stdout: carries JSON message lines ONLY (one line per call). */
  write(line: string): void;
  /** stderr: diagnostics only, never message lines. */
  writeErr(line: string): void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  env(name: string): string | undefined;
  cwd(): string;
  /** injectable wait so tests need no real delay. */
  sleep(ms: number): Promise<void>;
  /** the daemon bind seam; the real wiring (a port bind) lives in src/bin.ts. */
  serve(store: ChannelStore, opts: ServeOptions): Promise<number>;
  /** The socket factory for the slack backend's Socket Mode stream. The real
   *  wiring (bun's WebSocket) lives in src/bin.ts; tests inject a fake so
   *  next/listen touch no socket. */
  createSocket?(url: string): SlackSocket;
  /** read ALL of stdin (the message body for the mirror `message send`). The
   *  real read lives in src/bin.ts; tests inject a fake. When absent, `message
   *  send` reads stdin as empty and reports it. */
  readStdin?(): Promise<string>;
  /** The directory this CLI's source sits in, so `version` can read the COMMIT
   *  file an install writes beside it. The real value comes from src/bin.ts;
   *  absent under test, which reads as a checkout. */
  moduleDir?(): string;
}

/** The CLI owns --bind string parsing. The one interpretation site: it turns a
 *  `--bind` value ("host:port", "port", or "host") into typed hostname/port
 *  fields that serve() consumes. A malformed value is reported, never silently
 *  defaulted. */
export interface BindSpec {
  hostname?: string;
  port?: number;
}

export function parseBind(raw: string): { ok: true; spec: BindSpec } | { ok: false; error: string } {
  if (raw === "") return { ok: false, error: "empty --bind" };
  const colon = raw.indexOf(":");
  if (colon >= 0) {
    const host = raw.slice(0, colon);
    const portStr = raw.slice(colon + 1);
    if (portStr.includes(":")) return { ok: false, error: `invalid --bind: ${raw}` };
    if (portStr === "") return { ok: false, error: `missing port in --bind: ${raw}` };
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      return { ok: false, error: `invalid port in --bind: ${portStr}` };
    return { ok: true, spec: { hostname: host === "" ? undefined : host, port } };
  }
  // No colon: a bare port (all digits) or a bare hostname.
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      return { ok: false, error: `invalid port: ${raw}` };
    return { ok: true, spec: { port } };
  }
  return { ok: true, spec: { hostname: raw } };
}

interface Parsed {
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(args: string[]): Parsed {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), "");
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function readConfig(io: Io): { url?: string; token?: string } {
  try {
    const raw = readFileSync(join(io.cwd(), ".scramble", "config.json"), "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      url: typeof j.url === "string" ? j.url : undefined,
      token: typeof j.token === "string" ? j.token : undefined,
    };
  } catch {
    return {};
  }
}

/** Config precedence: --url/--token flag > env > workspace config.json > localhost. */
function resolveConfig(
  flags: Map<string, string>,
  io: Io,
): { url: string; token: string | undefined } {
  const cfg = readConfig(io);
  const url = (flags.get("url") ?? io.env("SCRAMBLE_URL") ?? cfg.url ?? DEFAULT_URL) as string;
  const token = flags.has("token")
    ? (flags.get("token") as string)
    : (io.env("SCRAMBLE_TOKEN") ?? cfg.token);
  return { url, token };
}

function defaultName(io: Io): string {
  return basename(io.cwd());
}

function nameFor(flags: Map<string, string>, io: Io): string {
  return flags.get("as") ?? defaultName(io);
}

function authHeader(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function newMessageId(): string {
  return `${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

function intFlag(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** The mirrored-verb `--target`: a channel name with NO leading '#'. A scramble
 *  channel may contain '/' (that is how `dm/<a>/<b>` works), so a sigil would be
 *  ambiguous. A target that starts with '#' is REJECTED, with the reason, and
 *  a missing --target is reported with what the caller saw. */
function requireTarget(flags: Map<string, string>, io: Io): { ok: true; channel: string } | { ok: false } {
  const target = flags.get("target");
  if (target === undefined || target === "") {
    io.writeErr("missing --target <channel>");
    return { ok: false };
  }
  if (target.startsWith("#")) {
    io.writeErr(
      `--target takes a channel name with no leading '#' (a scramble channel may contain '/' — how dm/<a>/<b> works — so a sigil would be ambiguous). Got '${target}'`,
    );
    return { ok: false };
  }
  return { ok: true, channel: target };
}

/** The `.scramble/cursor.json` seam for `message check`: the store keeps no
 *  per-agent delivery cursor, so the CLIENT holds it, keyed by agent name. Read
 *  on entry, advanced to the highest seq drained on exit. An absent file or an
 *  absent key reads as 0. */
const CURSOR_FILE = "cursor.json";

/** Where the drain cursor lives.
 *
 *  BESIDE THE CONFIG for the slack backend, because the cursor belongs to the
 *  AGENT and not to whatever directory it was invoked from. Keyed by cwd, the
 *  same agent sweeping from two places has two cursors and re-drains whole
 *  channels: moving a sweep monitor onto the installed CLI changed its cwd, and
 *  the next sweep re-delivered the entire history of two channels, hundreds of
 *  lines, until the harness suppressed it for rate (2026-08-22).
 *
 *  The local backend keeps its cwd-relative file, since a local daemon's store
 *  is per workspace. When the config-side file is absent and a cwd one exists,
 *  the cwd one is read, so an existing agent does not re-drain once on upgrade. */
function cursorPath(io: Io, agent: string): string {
  // ONE FILE PER AGENT, the way the inbox ledger is. A single shared file beside
  // the config looked fine because the keys inside it are per agent, and it is
  // not: the peer agent read the previous version and found the step I missed.
  // The FIRST agent to sweep from a fresh cwd creates the shared file, and from
  // that moment every other agent on the host resolves to it, finds no key of
  // its own, reads 0, and re-drains full history. The same flood, one step
  // later, once per agent. A shared file also makes two sweeps a read-modify-
  // write race over each other's cursors.
  const mine = join(dirname(slackConfigPath(io)), "cursors", `${agent}.json`);
  if (existsSync(mine)) return mine;
  // MIGRATION, and it must be the agent's OWN old file: the cwd copy belongs to
  // whoever swept from that directory, so it is read only while this agent has
  // no file of its own yet.
  const local = join(io.cwd(), ".scramble", CURSOR_FILE);
  return existsSync(local) ? local : mine;
}

function readCursor(io: Io, name: string): number {
  try {
    const j = JSON.parse(readFileSync(cursorPath(io, name), "utf8")) as Record<string, number>;
    return typeof j[name] === "number" ? j[name] : 0;
  } catch {
    return 0;
  }
}

function writeCursor(io: Io, name: string, seq: number): void {
  const p = cursorPath(io, name);
  let j: Record<string, number> = {};
  try {
    j = JSON.parse(readFileSync(p, "utf8")) as Record<string, number>;
  } catch {
    /* absent cursor file is a fresh ledger */
  }
  j[name] = seq;
  // THE DIRECTORY OF THE FILE BEING WRITTEN. This made the cwd `.scramble`
  // whatever path `p` resolved to, so on a host where the cursor lives beside
  // the config the write would fail for a directory that does not exist yet.
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(j));
}

/** A message rendered for THIS agent: an agent-scoped Delivery already carries
 *  `mentioned`; a channel-scoped Message gets it stamped from its mentions list. */
function render(agentStream: boolean, name: string, m: Message & { mentioned?: boolean }): Record<string, unknown> {
  if (agentStream) return m as unknown as Record<string, unknown>;
  return { ...m, mentioned: m.mentions.includes(name) };
}

/** Read an NDJSON stream, emitting one hook per line, until the stream ends. */
async function drainStream(
  res: Response,
  agentStream: boolean,
  name: string,
  onLine: (msg: Record<string, unknown>) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let { done, value } = await reader.read();
  while (!done) {
    buf += dec.decode(value, { stream: true });
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(render(agentStream, name, JSON.parse(line)));
      idx = buf.indexOf("\n");
    }
    ({ done, value } = await reader.read());
  }
}

async function cmdPost(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const channel = positionals[0];
  const text = positionals.slice(1).join(" ");
  if (channel === undefined || !text) {
    io.writeErr("usage: scramble post <channel> <text> [--as <name>]");
    return 1;
  }
  const backend = selectBackend(argv, io);
  if (backend === null) return 1;
  return postText(channel, text, flags, io, backend);
}

/** Local-backend: one message posted through the daemon. One JSON line per
 *  crossing, nothing on a clean send with no crossing. When `files` are given
 *  (from `--attach`), they ride the POST body so the stored message carries
 *  them. */
async function postLocalCore(
  channel: string,
  text: string,
  flags: Map<string, string>,
  io: Io,
  files?: Attachment[],
  thread?: string,
): Promise<number> {
  const { url, token } = resolveConfig(flags, io);
  const from = nameFor(flags, io);
  const payload: Record<string, unknown> = { from, text, id: newMessageId() };
  if (files !== undefined && files.length > 0) payload.files = files;
  if (thread !== undefined) payload.thread = thread;
  const res = await io.fetch(`${url}/channels/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    io.writeErr(`post failed (${res.status})`);
    return 1;
  }
  const body = (await res.json()) as PostResult;
  for (const crossing of body.crossings) io.write(JSON.stringify(crossing));
  return 0;
}

/** Post one message under whichever backend the run selects. The mirrored verb
 *  (`message send`) and the alias (`post <channel> <text>`) share this path so
 *  the backend switch sits below the verb parsing. `files` rides the local
 *  store's message when `message send --attach` produced them; the slack
 *  backend attaches by its own upload flow (files are uploaded to the target
 *  before the text send). */
async function postText(
  channel: string,
  text: string,
  flags: Map<string, string>,
  io: Io,
  backend: "local" | "slack",
  files?: Attachment[],
): Promise<number> {
  // THE CHOKE POINT: every verb that puts this agent's prose in front of a
  // person funnels through here, so the language check sits here and `post`
  // cannot be the way around what `message send` enforces. `message send` checks
  // once more BEFORE it uploads an attachment, which is not a second mechanism
  // but the same one called earlier, so a refused message does not leave a file
  // in the channel with no message to go with it.
  const postRefusal = languageRefusal(lintLanguage(text));
  if (postRefusal !== "") {
    io.writeErr(postRefusal);
    return 1;
  }
  const thread = flags.get("thread") ?? undefined;
  const status = statusTracker(io, backend, nameFor(flags, io));
  await settleStatus(status?.clearExpired(), io);
  if (backend === "slack") {
    const from = nameFor(flags, io);
    const s = slackBackend(io);
    if (s.error !== undefined || s.backend === undefined) {
      io.writeErr(s.error ?? "slack backend unavailable");
      return 1;
    }
    const r = await s.backend.post(channel, text, from, thread);
    if (!r.ok) {
      io.writeErr(`post failed: ${r.error}`);
      return 1;
    }
    // A post that landed somewhere other than where it was aimed is REPORTED,
    // never inferred from a clean exit.
    if (r.problem !== undefined) io.writeErr(`slack: ${r.problem}`);
    // A REPLY CLOSES WHAT IT ANSWERS. Here, after Slack accepted it, so a
    // refused post never retires an item that is still waiting.
    try {
      closeInboxItems(inboxPath(slackConfigPath(io), from), channel, new Date().toISOString(), thread);
    } catch (e) {
      io.writeErr(`inbox ledger not updated after posting to ${channel}: ${String(e)}`);
    }
    if (status !== undefined) await settleStatus(replyStatus(status, channel, from), io);
    return 0;
  }
  const code = await postLocalCore(channel, text, flags, io, files, thread);
  if (code === 0 && status !== undefined)
    await settleStatus(replyStatus(status, channel, nameFor(flags, io)), io);
  return code;
}

function streamUrls(base: string, name: string, channels: string[], since: number): string[] {
  if (channels.length) {
    return channels.map(
      (c) =>
        `${base}/channels/${encodeURIComponent(c)}/stream?since=${since}&exclude=${encodeURIComponent(name)}`,
    );
  }
  return [`${base}/agents/${encodeURIComponent(name)}/stream?since=${since}`];
}

/** Open every stream at the shared cursor, read concurrently, report a clean stop. */
async function listenOnce(
  io: Io,
  urls: string[],
  agentStream: boolean,
  name: string,
  token: string | undefined,
  onLine: (msg: { seq: number; channel?: string; mentioned?: unknown }) => void,
): Promise<boolean> {
  const stops = await Promise.all(
    urls.map(async (u) => {
      let res: Response;
      try {
        res = await io.fetch(u, { headers: authHeader(token) });
      } catch {
        return false;
      }
      if (res.status !== 200) return false;
      if (res.body === null) return true;
      try {
        await drainStream(res, agentStream, name, (m) => onLine(m as { seq: number; channel?: string; mentioned?: unknown }));
        return true; // the stream ended cleanly: a clean stop
      } catch {
        return false; // the connection dropped: retry with backoff
      }
    }),
  );
  return stops.some(Boolean);
}

async function cmdListen(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const name = nameFor(flags, io);
  const { url, token } = resolveConfig(flags, io);
  const channels = positionals;
  const agentStream = channels.length === 0;
  const status = statusTracker(io, "local");
  const stopTicker = status ? status.startExpiryTicker(2000, io.sleep) : undefined;
  let lastSeq = 0;
  let backoff = 100;
  let staying = true;
  try {
    while (staying) {
      const stop = await listenOnce(
        io,
        streamUrls(url, name, channels, lastSeq),
        agentStream,
        name,
        token,
        (m) => {
          if (status !== undefined) void deliverStatus(status, m, name);
          if (m.seq > lastSeq) lastSeq = m.seq;
          emitDelivery(io, name, m as unknown as Record<string, unknown>);
        },
      );
      staying = !stop;
      if (staying) {
        await io.sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      }
    }
  } finally {
    stopTicker?.();
  }
  return 0;
}

async function cmdNext(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const name = nameFor(flags, io);
  const { url, token } = resolveConfig(flags, io);
  const channels = positionals;
  const agentStream = channels.length === 0;
  const timeoutSec = intFlag(flags, "timeout", 300);
  const deadline = Date.now() + timeoutSec * 1000;
  const urls = streamUrls(url, name, channels, 0);
  const status = statusTracker(io, "local");
  await settleStatus(status?.clearExpired(), io);
  const responses: Response[] = [];
  const states = await Promise.all(
    urls.map(async (u) => {
      let res: Response;
      try {
        res = await io.fetch(u, { headers: authHeader(token) });
      } catch {
        return undefined;
      }
      if (res.status !== 200 && res.body) {
        try {
          await res.body.cancel();
        } catch {
          /* stream teardown only */
        }
        return undefined;
      }
      responses.push(res);
      const state = { done: false, line: undefined as Record<string, unknown> | undefined };
      if (res.status === 200 && res.body) {
        drainStream(res, agentStream, name, (line) => {
          if (!state.done) {
            state.done = true;
            state.line = line;
          }
        }).catch(() => {
          if (!state.done) state.done = true;
        });
      }
      return state;
    }),
  );
  let resolved = false;
  let exitCode = 64;
  while (!resolved) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      exitCode = 64;
      resolved = true;
    } else {
      await io.sleep(Math.min(remain, 100));
      const found = states.find((s) => s?.done && s.line);
      if (found?.line !== undefined) {
        if (status !== undefined) await settleStatus(deliverStatus(status, found.line, name), io);
        emitDelivery(io, name, found.line as unknown as Record<string, unknown>);
        exitCode = 0;
        resolved = true;
      }
    }
  }
  for (const r of responses) await r.body?.cancel().catch(() => {});
  return exitCode;
}

async function cmdHistory(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const channel = positionals[0];
  if (channel === undefined) {
    io.writeErr("history requires a channel");
    return 1;
  }
  const since = intFlag(flags, "since", 0);
  const backend = selectBackend(argv, io);
  if (backend === null) return 1;
  return historyRead(channel, since, flags, io, backend);
}

/** Local-backend read: one JSON line per message from the channel catch-up. */
async function historyLocal(
  channel: string,
  since: number,
  flags: Map<string, string>,
  io: Io,
): Promise<number> {
  const { url, token } = resolveConfig(flags, io);
  const res = await io.fetch(`${url}/channels/${encodeURIComponent(channel)}?since=${since}`, {
    headers: authHeader(token),
  });
  if (!res.ok) {
    io.writeErr(`read failed (${res.status})`);
    return 1;
  }
  const msgs = (await res.json()) as Array<Record<string, unknown>>;
  for (const m of msgs) io.write(JSON.stringify(m));
  return 0;
}

/** Read a channel's history under whichever backend the run selects. The mirrored
 *  verb (`message read --target <channel>`) and the alias (`history <channel>`) share
 *  `--since`/`--after` as the same cursor and both dispatch here, so the backend
 *  switch stays below the verb parsing. */
async function historyRead(
  channel: string,
  since: number,
  flags: Map<string, string>,
  io: Io,
  backend: "local" | "slack",
): Promise<number> {
  if (backend === "slack") {
    const s = slackBackend(io);
    if (s.error !== undefined || s.backend === undefined) {
      io.writeErr(s.error ?? "slack unavailable");
      return 1;
    }
    // This caller (src/cli.ts) builds BOTH the status manager (which reads the
    // ledger) and the slack backend, so the living-status ts is read here and
    // handed in, rather than letting the backend know where the ledger lives.
    const r = await s.backend.history(channel, since > 0 ? String(since) : undefined, nameFor(flags, io));
    for (const p of r.problems) io.writeErr(`slack: ${p}`);
    if (r.code !== 0) {
      // ONE channel was asked for by name here, so its refusal IS the answer.
      io.writeErr(`read failed: ${r.error}`);
      return 1;
    }
    for (const m of r.messages) io.write(JSON.stringify(m));
    return 0;
  }
  return historyLocal(channel, since, flags, io);
}

async function cmdJoin(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const channel = positionals[0];
  if (channel === undefined) {
    io.writeErr("join requires a channel");
    return 1;
  }
  return joinChannel(channel, flags, io);
}

/** Join a channel as THIS agent: scaffold `.scramble/`, read the persona, and
 *  register (name + persona + channel) with the daemon. Shared by the alias
 *  (`join <channel>`) and the mirror (`channel join --target <channel>`). */
async function joinChannel(
  channel: string,
  flags: Map<string, string>,
  io: Io,
): Promise<number> {
  const { url, token } = resolveConfig(flags, io);
  const name = nameFor(flags, io);
  const scamDir = join(io.cwd(), ".scramble");
  const personaFile = join(scamDir, "persona.md");
  const knowledgeDir = join(scamDir, "knowledge");
  if (!existsSync(scamDir)) mkdirSync(scamDir, { recursive: true });
  if (!existsSync(personaFile)) writeFileSync(personaFile, "goal + lens\n");
  if (!existsSync(knowledgeDir)) mkdirSync(knowledgeDir, { recursive: true });
  if (!existsSync(join(knowledgeDir, "INDEX.md"))) writeFileSync(join(knowledgeDir, "INDEX.md"), "");
  const persona = flags.get("persona") ?? readFileSync(personaFile, "utf8");
  const res = await io.fetch(`${url}/agents/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ persona, channel }),
  });
  if (!res.ok) {
    io.writeErr(`join failed (${res.status})`);
    return 1;
  }
  // A successful join should tell the joining agent where to look without
  // hunting: the join procedure and the conversational rules. These go to
  // stderr (stdout stays JSON-only per the CLI contract).
  const repoDir = import.meta.dir ? join(import.meta.dir, "..") : io.cwd();
  io.writeErr(`joined ${channel} as ${name}; read the join procedure at ${join(repoDir, "JOIN.md")}`);
  io.writeErr(`the channel's rules live at ${join(repoDir, "skills", "scramble", "CONTRACT.md")}`);
  return 0;
}

function dataDir(flags: Map<string, string>, io: Io): string {
  const flag = flags.get("data");
  if (flag) return flag;
  const home = io.env("HOME");
  return home ? join(home, ".scramble") : join(io.cwd(), ".scramble");
}

async function cmdServe(argv: string[], io: Io): Promise<number> {
  const { flags } = parseArgs(argv);
  const store = createStore(dataDir(flags, io));
  const opts: ServeOptions = {};
  const bind = flags.get("bind");
  if (bind !== undefined) {
    const parsed = parseBind(bind);
    if (!parsed.ok) {
      io.writeErr(`invalid --bind: ${parsed.error}`);
      return 1;
    }
    if (parsed.spec.hostname !== undefined) opts.hostname = parsed.spec.hostname;
    if (parsed.spec.port !== undefined) opts.port = parsed.spec.port;
  }
  const token = flags.get("token");
  if (token) opts.token = token;
  return io.serve(store, opts);
}

/** Path the slack config is read from. SCRAMBLE_SLACK_CONFIG wins, else
 *  ~/.config/scramble/slack.json, else the workspace copy. The config holds
 *  BOT TOKENS, so the default is deliberately OUTSIDE the repo: this repo is
 *  public-bound, and a credential in a commit is readable in every clone. */
export function slackConfigPath(io: Io): string {
  const explicit = io.env("SCRAMBLE_SLACK_CONFIG");
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const home = io.env("HOME");
  if (home !== undefined && home.length > 0) return join(home, ".config", "scramble", "slack.json");
  return join(io.cwd(), ".scramble", "slack.json");
}

/** Load the slack backend config. The config governs which channels map to which
 *  Slack channels, each agent's identity, and the app-level/bot tokens. Returns
 *  null when the file is absent or malformed (the caller reports it, naming the
 *  path it tried). */
export function loadSlackConfig(io: Io): SlackBackendConfig | null {
  try {
    const raw = readFileSync(slackConfigPath(io), "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const channels = j.channels as Record<string, string> | undefined;
    const agents = j.agents as
      | Record<string, { token?: string; icon?: string; appToken?: string; handle?: string; appId?: string }>
      | undefined;
    if (!channels || typeof channels !== "object" || !agents || typeof agents !== "object") {
      return null;
    }
    return {
      channels,
      agents,
      dmChannels: (j.dmChannels as Record<string, string>) ?? {},
      roster: (j.roster as Record<string, string>) ?? {},
      token: typeof j.token === "string" ? j.token : "",
      appToken: typeof j.appToken === "string" ? j.appToken : undefined,
      filesDir: typeof j.filesDir === "string" ? j.filesDir : "",
      humanUserId: typeof j.humanUserId === "string" ? j.humanUserId : undefined,
    };
  } catch {
    return null;
  }
}

/** The directory Slack attachments are downloaded into (and the local ledger
 *  lives in). The config's `filesDir` wins; the default keeps files OUT of the
 *  repo (public-bound), mirroring how the config keeps tokens out of the tree. */
function slackFilesDir(io: Io): string {
  const cfg = loadSlackConfig(io);
  if (cfg !== null && cfg.filesDir !== "") return cfg.filesDir;
  const home = io.env("HOME");
  return home ? join(home, ".config", "scramble", "files") : join(io.cwd(), ".scramble", "files");
}

/** Build the slack BACKEND with the io seams. The config is read from the slack
 *  config path, and every outbound call/socket goes through io.fetch and
 *  io.createSocket, so tests need no token, network or socket. Returns an
 *  error string instead of a backend when the config or seams are missing. */
// What a scramble agent's app must declare lives in one place, which the
// onboarding script builds the manifest from and doctor checks a live app
// against. It used to be a second hand-kept copy here, under a comment claiming
// doctor compared the two; doctor never did, and the copies had diverged.

/** The one line an agent whose config is stale must see. Returned rather than
 *  printed so the caller decides the stream, and empty when nothing is wrong. */
export function staleConfigWarning(cfg: SlackBackendConfig | null, agent: string): string {
  if (cfg === null) return "";
  const entry = cfg.agents[agent];
  if (entry === undefined) return "";
  if (entry.handle === undefined || entry.handle === "") {
    return (
      `scramble: ${agent} has no recorded Slack handle, so a mention of it resolves to a ` +
      `name this config cannot match and every mention arrives with mentioned:false. ` +
      `Run: scramble doctor --as ${agent}`
    );
  }
  return "";
}

/** The Slack CLI's app-configuration token, when this host has one. Only this
 *  credential can read another app's description, so a host without the CLI
 *  simply gets no peer descriptions rather than a broken lookup. */
export function slackCliToken(io: Io): string | undefined {
  const home = io.env("HOME");
  if (home === undefined || home === "") return undefined;
  try {
    const creds = JSON.parse(readFileSync(join(home, ".slack", "credentials.json"), "utf8")) as Record<
      string,
      { token?: string }
    >;
    for (const v of Object.values(creds)) {
      if (typeof v.token === "string" && v.token !== "") return v.token;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function slackBackend(io: Io): { backend?: SlackBackend; error?: string } {
  const cfg = loadSlackConfig(io);
  if (cfg === null) return { error: `${slackConfigPath(io)} is missing or malformed` };
  if (!cfg.token) return { error: "slack backend requires a bot token (xoxb-) in the config" };
  if (!io.createSocket) return { error: "no socket factory seam is bound for the slack backend" };
  const backend = new SlackBackend(
    {
      token: cfg.token,
      appToken: cfg.appToken,
      channels: cfg.channels,
      agents: cfg.agents,
      roster: cfg.roster,
      dmChannels: cfg.dmChannels,
      filesDir: slackFilesDir(io),
      humanUserId: cfg.humanUserId,
      cliToken: slackCliToken(io),
    },
    { fetch: io.fetch, createSocket: io.createSocket, sleep: io.sleep },
  );
  return { backend };
}

/** A real clock for the status tracker (a named function so coverage tracks it;
 *  the manager invokes it on every status lifecycle operation). */
function statusNow(): number {
  return Date.now();
}

/** Build the status tracker for a run, or undefined when the operator disabled
 *  it (the one `SCRAMBLE_STATUS=off` switch). The Slack-mode tracker rides on
 *  the slack config's token and channel mapping; any other backend records the
 *  status locally so a reader (or a test) sees it. A missing or broken slack
 *  config yields a local-style record, because a status can never fail the verb
 *  it brackets. */
function statusTracker(io: Io, backend: "local" | "slack", agent?: string): StatusManager | undefined {
  if (io.env("SCRAMBLE_STATUS") === "off") return undefined;
  const raw = Number(io.env("SCRAMBLE_STATUS_TTL"));
  const ttlMs = Number.isFinite(raw) && raw > 0 ? raw * 1000 : 120_000;
  const mode: "local" | "slack" = backend === "slack" ? "slack" : "local";
  let channels: Record<string, string> | undefined;
  let token: string | undefined;
  if (mode === "slack") {
    const cfg = loadSlackConfig(io);
    if (cfg !== null) {
      channels = cfg.channels;
      // THE ACTING AGENT'S token, not the config default. The status is posted
      // into the agent's OWN channel, and the default app is a different app
      // that is usually not in it: Slack answers channel_not_found, a failed
      // status never fails the work it brackets, and the whole feature is
      // silently dead for every agent that is not the default. That is what
      // "assistant statuses do not work at all" was (operator, 2026-08-21).
      token = (agent !== undefined ? cfg.agents[agent]?.token : undefined) ?? cfg.token;
    }
  }
  return new StatusManager({
    file: join(io.cwd(), ".scramble", "status.json"),
    backend: mode,
    now: statusNow,
    ttlMs,
    fetch: io.fetch,
    writeErr: io.writeErr,
    channels,
    token,
  });
}

/** A delivery turns status ON for its channel when (and only when) the message
 *  is addressed to this agent. A message on a channel that will stay silent must
 *  not show the agent busy, so an unaddressed line sets nothing. The status is
 *  potentially awaited by a SHORT-LIVED verb (which would otherwise exit with the
 *  ledger write in flight); a failure is swallowed by the awaiting caller.
 *  Callers guard with a non-null status. */
function deliverStatus(
  status: StatusManager,
  m: { channel?: unknown; mentioned?: unknown; thread?: unknown; ts?: unknown; id?: unknown },
  agent: string,
): Promise<void> {
  if (m.mentioned !== true) return Promise.resolve();
  if (typeof m.channel !== "string") return Promise.resolve();
  // Slack's status hangs off a THREAD, so the thread this message belongs to is
  // where the agent shows as working: the thread root when the message is a
  // reply, and the message itself when it is top-level, since answering it
  // starts that thread.
  const thread =
    typeof m.thread === "string" ? m.thread : typeof m.ts === "string" ? m.ts : undefined;
  return status.setOn(m.channel, agent, thread);
}

/** A reply by the agent clears the channel's active status as part of the same
 *  call. Returned so a short-lived verb can AWAIT the ledger write (the delete
 *  goes out, THEN status.json drops the record) before its process exits. */
function replyStatus(status: StatusManager, channel: string, agent: string): Promise<void> {
  return status.clearOn(channel, agent);
}

/** Await a status call, swallowing a failure so it can never fail the work that
 *  brackets it. The StatusManager already reports its own Slack failures on
 *  stderr; this catches an unexpected throw on top. A short-lived verb awaits
 *  every status call it fired, so ledger writes (delivery set / reply clear /
 *  expiry sweep) finish before the process exits. */
async function settleStatus(p: Promise<unknown> | undefined, io: Io): Promise<void> {
  if (p === undefined) return;
  try {
    await p;
  } catch (e) {
    io.writeErr(`status: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The living-status message ts for a run, read from the status ledger by the
 *  caller (src/cli.ts) that builds BOTH the status manager and the slack
 *  backend — handed into a read or a delivery so the backend filters a status
 *  line without knowing where the ledger lives. No status means no line hidden. */

/** A slack-backend `message check` cursor is a PER-CHANNEL map (channel name ->
 *  newest Slack ts), stored under a namespaced key in the same cursor.json so it
 *  never collides with the local backend's agent-keyed integer cursor. Slack has
 *  no global sequence, so the honest resume point is a conversation ts per
 *  channel, kept client-side like the local cursor. */
const SLACK_CURSOR_PREFIX = "slack:";

function readSlackCursor(io: Io, name: string): Record<string, string> {
  try {
    const j = JSON.parse(readFileSync(cursorPath(io, name), "utf8")) as Record<string, unknown>;
    const v = j[`${SLACK_CURSOR_PREFIX}${name}`];
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      return v as Record<string, string>;
  } catch {
    /* absent or corrupt cursor: a fresh per-channel ledger, drain from the start */
  }
  return {};
}

function writeSlackCursor(io: Io, name: string, perChannel: Record<string, string>): void {
  const p = cursorPath(io, name);
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    /* absent cursor file is a fresh ledger */
  }
  j[`${SLACK_CURSOR_PREFIX}${name}`] = perChannel;
  // THE DIRECTORY OF THE FILE BEING WRITTEN. This made the cwd `.scramble`
  // whatever path `p` resolved to, so on a host where the cursor lives beside
  // the config the write would fail for a directory that does not exist yet.
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(j));
}

/** A Slack ts (`seconds.microseconds`) as a comparable number; -1 when it does
 *  not parse so it can never win a "newest" comparison. */
function slackTs(ts: string): number {
  const n = Number.parseFloat(ts);
  return Number.isFinite(n) ? n : -1;
}

/** The newer of two ts values; an undefined cursor counts as the oldest. */
function newerTs(a: string | undefined, b: string): string {
  if (a === undefined || slackTs(b) > slackTs(a)) return b;
  return a;
}

async function slackCmdNext(argv: string[], io: Io): Promise<number> {
  // A STALE CONFIG ANNOUNCES ITSELF ON THE PATH IT BREAKS. An agent onboarded
  // before a fix keeps running and silently lacks it, so the delivery verbs, the
  // ones a mention has to travel through, print the one line that names the
  // repair. Costs nothing: it reads the config already being loaded.
  {
    const w = staleConfigWarning(loadSlackConfig(io), nameFor(parseArgs(argv).flags, io));
    if (w !== "") io.writeErr(w);
  }

  const { flags, positionals } = parseArgs(argv);
  const name = nameFor(flags, io);
  const timeoutSec = intFlag(flags, "timeout", 300);
  const status = statusTracker(io, "slack", name);
  await settleStatus(status?.clearExpired(), io);
  const s = slackBackend(io);
  if (s.error !== undefined || s.backend === undefined) {
    io.writeErr(s.error ?? "slack unavailable");
    return 1;
  }
  const r = await s.backend.next(positionals, name, timeoutSec, (p) => io.writeErr(`slack: ${p}`));
  if (r.code === 64) return 64;
  // code 1 means scramble could not look (the socket open was refused): the
  // refusal was already reported on stderr, so surface it as a nonzero exit
  // that a harness never mistakes for a quiet channel.
  if (r.code === 1) return 1;
  if (r.line !== undefined) {
    if (status !== undefined) await settleStatus(deliverStatus(status, r.line, name), io);
    emitDelivery(io, name, r.line as unknown as Record<string, unknown>);
  }
  return 0;
}

async function slackCmdListen(argv: string[], io: Io): Promise<number> {
  // A STALE CONFIG ANNOUNCES ITSELF ON THE PATH IT BREAKS. An agent onboarded
  // before a fix keeps running and silently lacks it, so the delivery verbs, the
  // ones a mention has to travel through, print the one line that names the
  // repair. Costs nothing: it reads the config already being loaded.
  {
    const w = staleConfigWarning(loadSlackConfig(io), nameFor(parseArgs(argv).flags, io));
    if (w !== "") io.writeErr(w);
  }

  const { flags, positionals } = parseArgs(argv);
  const name = nameFor(flags, io);
  const s = slackBackend(io);
  if (s.error !== undefined || s.backend === undefined) {
    io.writeErr(s.error ?? "slack unavailable");
    return 1;
  }
  const status = statusTracker(io, "slack", name);
  const stopTicker = status ? status.startExpiryTicker(2000, io.sleep) : undefined;
  try {
    return await s.backend.listen(
      positionals,
      name,
      (d) => {
        if (status !== undefined) void deliverStatus(status, d, name);
        emitDelivery(io, name, d as unknown as Record<string, unknown>);
      },
      (p) => io.writeErr(`slack: ${p}`),
    );
  } finally {
    stopTicker?.();
  }
}

/** Local-backend `message check`: drain the agent's pending messages and
 *  advance the client-side cursor. Slightly non-blocking: fetch the pending
 *  list, print one JSON line per message, record the highest seq in
 *  `.scramble/cursor.json`, exit 0. Nothing pending prints nothing and exits 0. */
async function messageCheckLocal(flags: Map<string, string>, io: Io): Promise<number> {
  const name = nameFor(flags, io);
  const status = statusTracker(io, "local");
  await settleStatus(status?.clearExpired(), io);
  const cursor = readCursor(io, name);
  const { url, token } = resolveConfig(flags, io);
  const res = await io.fetch(`${url}/agents/${encodeURIComponent(name)}/pending?since=${cursor}`, {
    headers: authHeader(token),
  });
  if (!res.ok) {
    io.writeErr(`message check failed (${res.status})`);
    return 1;
  }
  const deliveries = (await res.json()) as Array<{ seq: number; channel?: string; mentioned?: unknown }>;
  for (const d of deliveries) {
    if (status !== undefined) await settleStatus(deliverStatus(status, d, name), io);
    emitDelivery(io, name, d as unknown as Record<string, unknown>);
  }
  if (deliveries.length) {
    const highest = Math.max(...deliveries.map((d) => d.seq));
    writeCursor(io, name, highest);
  }
  return 0;
}

/** Slack-backend `message check`: drain every configured channel from the
 *  agent's per-channel Slack cursor, exactly as the local path drains a pending
 *  list — the direct mirror of `messageCheckLocal`. Slack has no server-held
 *  per-agent inbox and no global sequence, so the cursor is the conversation ts
 *  per channel, kept client-side in `.scramble/cursor.json` under a namespaced
 *  key. Print one JSON line per drained message in the same shape `listen`
 *  prints (with a `mentioned` flag for THIS agent), set the working status for
 *  addressed lines exactly as the local path does, advance the cursor to the
 *  newest line seen per channel, and exit 0. A broken or missing config is
 *  REPORTED, never a silent nothing. */
async function messageCheckSlack(flags: Map<string, string>, io: Io): Promise<number> {
  // A STALE CONFIG ANNOUNCES ITSELF ON THE PATH IT BREAKS. An agent onboarded
  // before a fix keeps running and silently lacks it, so the delivery verbs, the
  // ones a mention has to travel through, print the one line that names the
  // repair. Costs nothing: it reads the config already being loaded.
  {
    const w = staleConfigWarning(loadSlackConfig(io), nameFor(flags, io));
    if (w !== "") io.writeErr(w);
  }

  const name = nameFor(flags, io);
  const status = statusTracker(io, "slack", name);
  await settleStatus(status?.clearExpired(), io);
  const cfg = loadSlackConfig(io);
  if (cfg === null) {
    io.writeErr(`${slackConfigPath(io)} is missing or malformed`);
    return 1;
  }
  const s = slackBackend(io);
  if (s.error !== undefined || s.backend === undefined) {
    io.writeErr(s.error ?? "slack backend unavailable");
    return 1;
  }
  const started = readSlackCursor(io, name);
  const next = { ...started };
  const ids = s.backend.identities(name);
  let unreachable = 0;
  let drained = 0;
  // What I have already said that today's rules would refuse.
  const selfHits: string[] = [];
  // WHAT THIS AGENT IS IN, unioned with what the config names. The sweep used to
  // walk cfg.channels alone, a hand-kept map in a config several agents share:
  // a peer removed two entries while testing resolution and this sweep stopped
  // covering the channel the operator talks to me in, reporting "none of the 3
  // configured channels are readable" while the listener kept delivering, so
  // nothing looked broken. The config still contributes, because a name mapped
  // there may be a DM or a conversation the listing does not return.
  const mine = await s.backend.myChannels(name);
  if (mine.problem !== undefined) io.writeErr(`slack: ${mine.problem}`);
  for (const channel of [...new Set([...Object.keys(cfg.channels), ...mine.names])].sort()) {
    let newestOwn: string | undefined;
    const cursor = started[channel];
    // `oldest` is inclusive in Slack, so re-filter to strictly-newer lines: the
    // cursor line itself must not re-drain on a repeat `message check`.
    const r = await s.backend.history(channel, cursor === undefined ? undefined : cursor, name, true);
    for (const p of r.problems) io.writeErr(`slack: ${p}`);
    if (r.code !== 0) {
      // ONE UNREACHABLE CHANNEL MUST NOT SILENCE THE REST. This loop walks EVERY
      // configured channel, the config is shared by every agent on the host, and
      // each is invited to different ones, so a channel this agent is not in is
      // the normal case rather than a fault. Failing the whole drain there meant
      // an agent with one uninvited channel drained NOTHING and said
      // `read failed`, which a sweeping agent cannot tell from a quiet channel.
      io.writeErr(`slack: ${channel}: ${r.error}`);
      unreachable += 1;
      continue;
    }
    const fresh =
      cursor === undefined ? r.messages : r.messages.filter((m) => slackTs(m.ts) > slackTs(cursor));
    let newest: string | undefined = cursor;
    for (const m of fresh) {
      // The cursor advances past EVERY fresh line, including a skipped one, so
      // a repeated sweep never re-reads an own message forever.
      newest = newerTs(newest, m.ts);
      // The SAME identity set the backend delivers with: a mention of this
      // agent's Slack handle addresses this agent, and computing it here from
      // the name alone is what made a real mention arrive with mentioned:false.
      // The BACKEND decides this for a drain, including a thread the agent is in,
      // which a name match here cannot see. No local fallback: a second way to
      // compute `mentioned` is a second answer that will disagree with the first.
      const mentioned = (m as { mentioned?: boolean }).mentioned === true;
      const line = { ...m, mentioned };
      // `message check` is a DELIVERY verb: its drain hands the agent what has
      // ARRIVED FOR it, and its own post has not arrived for anybody. Skip the
      // line whose resolved sender is the draining agent, by the same name
      // comparison `listen` and `next` use, so an agent sweeping does not read
      // its own last message as new traffic. `message read` (a transcript)
      // keeps every line — only the DELIVERY drain filters.
      // `from` is the RESOLVED sender, which for an app is its handle, so
      // comparing against the scramble name alone let an agent drain its own
      // messages back.
      if (ids.includes(m.from)) {
        // MY OWN LINES ARE READ BACK AGAINST TODAY'S RULES. The sweep walks them
        // anyway on its way past, and every rule in this file was added AFTER a
        // message had already gone out carrying what it bans, so the messages
        // already sent are the evidence for whether the newest rule was needed.
        //
        // The operator, 2026-08-22, having caught three of these in a row:
        // "You need to understand this general pattern and use the message check
        // to guard it." A rule that only guards the NEXT message leaves every
        // earlier one standing in the channel, unmarked, as though it were fine.
        // MY NEWEST LINE HERE ANSWERS EVERYTHING OLDER. A reply is a reply
        // whether or not it went through this CLI while the ledger existed.
        newestOwn = newerTs(newestOwn, m.ts);
        const late = lintLanguage(m.text ?? "");
        if (late.length > 0) {
          selfHits.push(
            `${channel} ${m.ts}: ${late.map((h) => `[${h.label}] ${JSON.stringify(h.match)}`).join(" ")}`,
          );
        }
        continue;
      }
      if (status !== undefined) await settleStatus(deliverStatus(status, line, name), io);
      emitDelivery(io, name, line as unknown as Record<string, unknown>);
    }
    if (newest !== undefined) next[channel] = newest;
    if (newestOwn !== undefined) {
      try {
        closeAnsweredBefore(inboxPath(slackConfigPath(io), name), channel, newestOwn);
      } catch (e) {
        io.writeErr(`inbox ledger not updated for ${channel}: ${String(e)}`);
      }
    }
    drained += 1;
  }
  writeSlackCursor(io, name, next);
  if (selfHits.length > 0) {
    io.writeErr(
      `${selfHits.length} message(s) you already sent would be refused by today's rules:\n` +
        `${selfHits.map((h) => `  ${h}`).join("\n")}\n` +
        `Each rule here was added after a message went out carrying what it bans. ` +
        `Correct them in the channel where they are still standing.`,
    );
  }
  // Every configured channel refused is a REPORT, never a silent exit 0: an
  // agent invited to none of them must not read as a quiet workspace.
  if (drained === 0 && unreachable > 0) {
    io.writeErr(
      `message check: none of the ${unreachable} configured channel(s) are readable by ${name}. ` +
        `Ask a member to run /invite for the channel this agent belongs in.`,
    );
    return 1;
  }
  return 0;
}

async function cmdMessageCheck(argv: string[], io: Io, backend: "local" | "slack"): Promise<number> {
  const { flags } = parseArgs(argv);
  const code = backend === "slack" ? await messageCheckSlack(flags, io) : await messageCheckLocal(flags, io);
  // WHAT IS STILL OWED, on every sweep. The timed check is the one thing that
  // runs whatever the agent is doing, so the reminder about an unanswered
  // message belongs here (operator, 2026-08-22): "Inbox pending check can be
  // done in the 15 minute message check monitor and prompt you any pending
  // inbox item you have not replied. This avoids having to implement custom
  // hook scripts for Claude and codex."
  //
  // It rides the drain rather than a closing hook because a hook is per client,
  // and the same agent runs under more than one. The sweep is the product's own
  // surface, so every client gets it.
  //
  // Printed AFTER the drain, so the lines just delivered are already counted,
  // and on stderr, so the stdout contract stays one JSON line per message.
  const owed = pendingInbox(inboxPath(slackConfigPath(io), nameFor(flags, io)));
  if (owed.length > 0) io.writeErr(pendingReport(owed, nameFor(flags, io)));
  return code;
}

/** The mirrored `message` family: `send`, `check`, `read`. Each dispatches to
 *  the selected backend below the verb parsing, and reports an unknown verb. */
/** Collect every value passed for a REPEATABLE flag (`--attach a --attach b`),
 *  supporting both `--flag value` and `--flag=value` spellings. */
function collectValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--")) out.push(v);
    } else if (a.startsWith(`${flag}=`)) {
      out.push(a.slice(flag.length + 1));
    }
  }
  return out;
}

type AttachResult =
  /** `permalink` is Slack's link to the stored file, absent on the local
   *  backend. The SEND path puts it in the message text, which is what makes
   *  Slack attach the file to that message; without it the bytes sit in Slack's
   *  storage attached to nothing. */
  { ok: true; id: string; permalink?: string } | { ok: false; error: string };

/** Upload one local file under the selected backend and return the file id the
 *  backend assigned (Slack's file id or a local ledger id). The `path` carries
 *  through so a session can read the bytes. */
async function attachmentUpload(
  path: string,
  targetChannel: string,
  mimeOverride: string | undefined,
  io: Io,
  backend: "local" | "slack",
  as?: string,
  initialComment?: string,
  threadTs?: string,
): Promise<AttachResult> {
  if (backend === "slack") {
    // THROUGH THE BACKEND, which owns channel resolution and mention conversion.
    // This function used to read cfg.channels itself and hand the text to Slack
    // raw, so an attach failed on a channel a plain send reached, and a name in
    // the text notified nobody.
    const s = slackBackend(io);
    if (s.error !== undefined || s.backend === undefined) {
      return { ok: false, error: s.error ?? "slack backend unavailable" };
    }
    const r = await s.backend.upload(targetChannel, path, as ?? "", mimeOverride, initialComment, threadTs);
    return r.ok ? { ok: true, id: r.id, permalink: r.permalink } : { ok: false, error: r.error };
  }
  const r = recordLocalUpload(slackFilesDir(io), path, mimeOverride);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, id: r.record.id };
}

/** Resolve an attachment id to a local path, for `attachment view`: the local
 *  backend finds it in the filesDir ledger; the slack backend finds the file
 *  recorded there (inbound downloads land in filesDir under the file id). */
async function attachmentView(
  id: string,
  out: string | undefined,
  io: Io,
  backend: "local" | "slack",
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  void backend;
  const dir = slackFilesDir(io);
  const rec = findLocalRecord(dir, id);
  if (!rec) return { ok: false, error: `no recorded attachment ${id}` };
  const finalPath = out !== undefined ? out : rec.path;
  if (out !== undefined) copyFileSync(rec.path, out);
  return { ok: true, path: finalPath };
}

/** The mirrored `attachment` verbs: `upload` and `view`, mirroring raft's
 *  grammar. `upload` prints the file id as one JSON line; `view` prints the
 *  path written. */
async function cmdAttachment(args: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(args);
  const sub = positionals[0];
  const backend = selectBackend(args, io);
  if (backend === null) return 1;
  if (sub === "upload") {
    const path = flags.get("path");
    if (!path) {
      io.writeErr("attachment upload requires --path <file>");
      return 1;
    }
    const req = requireTarget(flags, io);
    if (!req.ok) return 1;
    const r = await attachmentUpload(path, req.channel, flags.get("mime-type"), io, backend, nameFor(flags, io));
    if (!r.ok) {
      io.writeErr(r.error);
      return 1;
    }
    io.write(JSON.stringify({ id: r.id }));
    return 0;
  }
  if (sub === "view") {
    const id = positionals[1];
    if (!id) {
      io.writeErr("attachment view requires <attachmentId>");
      return 1;
    }
    const v = await attachmentView(id, flags.get("path"), io, backend);
    if (!v.ok) {
      io.writeErr(v.error);
      return 1;
    }
    io.write(JSON.stringify({ path: v.path }));
    return 0;
  }
  io.writeErr(`unknown attachment verb: ${sub ?? "(none)"}`);
  return 1;
}

/** `scramble version`: which commit this CLI IS, read from the COMMIT file the
 *  installer writes beside the source.
 *
 *  An agent could not answer this before. `bun link` points the name on PATH at
 *  the maintainer's checkout, so `scramble` was whatever that tree happened to
 *  hold at the moment of the call, including a half-saved edit. The answer here
 *  says which copy is running and where it lives, and says RUNNING FROM A
 *  CHECKOUT when there is no COMMIT file, because that is the case where the
 *  version is a moving target. */
function cmdVersion(io: Io): number {
  const dir = io.moduleDir ? io.moduleDir() : "";
  let commit = "";
  try {
    commit = readFileSync(join(dir, "COMMIT"), "utf8").trim();
  } catch {
    /* no COMMIT file: this is a checkout, reported as such below */
  }
  if (commit === "") {
    io.write(JSON.stringify({ scramble: "running from a checkout", source: dir, commit: null }));
    io.writeErr(
      `scramble is running from a checkout at ${dir}, so its behaviour changes when that tree ` +
        `changes, with no pull and no signal. Install a copy you hold: bash scripts/install.sh`,
    );
    return 1;
  }
  io.write(JSON.stringify({ scramble: "installed", commit, source: dir }));
  return 0;
}

/** `scramble lint <file>...`, or the text on stdin: the SAME rules `message send`
 *  enforces, pointed at anything else worth checking.
 *
 *  Operator, 2026-08-22: "the linter should be individually callable to check
 *  other documents such as lark docs or markdown files." The rules belong to the
 *  send, and a document going to the same people deserves the same reading, so
 *  the verb reuses the rule list rather than owning a copy of it.
 *
 *  Prints `file:line: [label] "match"` and exits 1 when anything hit. */
async function cmdLint(argv: string[], io: Io): Promise<number> {
  const { positionals } = parseArgs(argv);
  const sources: Array<{ name: string; text: string }> = [];
  if (positionals.length === 0) {
    const text = await (io.readStdin ? io.readStdin() : Promise.resolve(""));
    if (text.trim() === "") {
      io.writeErr("usage: scramble lint <file> [<file> ...], or pipe the text in on stdin");
      return 1;
    }
    sources.push({ name: "(stdin)", text });
  } else {
    for (const p of positionals) {
      try {
        sources.push({ name: p, text: readFileSync(p, "utf8") });
      } catch (e) {
        // A FILE THAT COULD NOT BE READ IS A FAILURE, never a silent pass: a
        // lint that skips what it cannot open reports clean on a typo.
        io.writeErr(`lint: cannot read ${p}: ${String(e)}`);
        return 1;
      }
    }
  }
  let total = 0;
  for (const src of sources) {
    for (const h of lintLanguage(src.text)) {
      io.writeErr(`${src.name}:${lineOf(src.text, h.index)}: [${h.label}] ${JSON.stringify(h.match)}`);
      total += 1;
    }
  }
  io.write(JSON.stringify({ lint: total === 0 ? "clean" : "hits", files: sources.length, hits: total }));
  return total === 0 ? 0 : 1;
}

/** `scramble inbox pending --as <name>`: every line addressed to this agent that
 *  nothing has answered, one JSON object per line, and EXIT 1 while any is open.
 *
 *  The exit code is the point. It is what a closing gate reads to refuse a turn
 *  that leaves someone waiting, so the obligation is counted per ITEM by the
 *  delivery path and not per turn by whoever is writing the turn. Empty exits 0
 *  and prints nothing. */
async function cmdInbox(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const sub = positionals[0] ?? "pending";
  const name = nameFor(flags, io);
  if (sub !== "pending") {
    io.writeErr(`unknown inbox verb: ${sub}. The verb is: inbox pending [--as <name>]`);
    return 1;
  }
  const items = pendingInbox(inboxPath(slackConfigPath(io), name));
  for (const item of items) io.write(JSON.stringify(item));
  if (items.length === 0) return 0;
  io.writeErr(pendingReport(items, name));
  return 1;
}

/** WRITE A DELIVERED LINE, AND RECORD IT. The only way a delivery reaches
 *  stdout, so a line cannot be handed to an agent without the ledger knowing an
 *  answer is owed. `read` does not go through here: a transcript is not an
 *  inbox.
 *
 *  The recording is best-effort and never blocks the delivery: an unwritable
 *  ledger must not stop a message reaching the agent, since the message is the
 *  point and the ledger is the accounting. It is REPORTED, so an inbox that
 *  quietly counts nothing does not read as an inbox with nothing in it. */
function emitDelivery(io: Io, agent: string, line: Record<string, unknown>): void {
  io.write(JSON.stringify(line));
  if (!isAddressed(line, agent)) return;
  try {
    recordInboxItem(inboxPath(slackConfigPath(io), agent), {
      id: String(line.id ?? line.ts ?? line.seq ?? ""),
      channel: String(line.channel ?? ""),
      from: String(line.from ?? ""),
      ...(typeof line.thread === "string" ? { thread: line.thread } : {}),
      text: String(line.text ?? "").slice(0, 120),
      at: new Date().toISOString(),
    });
  } catch (e) {
    io.writeErr(`inbox ledger not written for ${String(line.id ?? "")}: ${String(e)}`);
  }
}

async function cmdMessage(args: string[], io: Io, backend: "local" | "slack"): Promise<number> {
  const { flags, positionals } = parseArgs(args);
  const sub = positionals[0];
  switch (sub) {
    case "send": {
      const req = requireTarget(flags, io);
      if (!req.ok) return 1;
      const text = await (io.readStdin ? io.readStdin() : Promise.resolve(""));
      if (!text.trim()) {
        io.writeErr("message send requires the message on stdin");
        return 1;
      }
      // THE LANGUAGE RULES ARE CHECKED HERE, where the message leaves, and not by
      // a chain the sender has to remember. The documented chain was draft-file
      // then lint then send; I piped text straight in all day, the lint ran on
      // nothing, and the operator read a long dash and told me the linting had
      // failed. It had not failed. It had not run.
      const refusal = languageRefusal(lintLanguage(text));
      if (refusal !== "") {
        io.writeErr(refusal);
        return 1;
      }
      // A REPLY GOES IN THE THREAD IT ANSWERS, by default (operator,
      // 2026-08-22): "shall we make inbox reply default to within the thread?
      // Posting to the channel directly can be made a separate flag."
      //
      // The ledger already knows which item in this channel is unanswered, so
      // the thread is READ rather than guessed. With something open and no
      // --thread given, the reply threads under the newest open item, which is
      // the one the conversation is on; with several open across threads, the
      // reply closes them all anyway, since answering in the room answers the
      // room. Nothing open means nothing to reply to, so it posts at channel
      // level as before.
      //
      // `--top-level` is the way out, and the chosen thread is REPORTED, because
      // a message that quietly went somewhere other than where the sender
      // pictured it is the defect this same day already produced once.
      if (flags.get("thread") === undefined && !flags.has("top-level")) {
        const open = pendingInbox(inboxPath(slackConfigPath(io), nameFor(flags, io))).filter(
          (r) => r.channel === req.channel,
        );
        const newest = open[open.length - 1];
        if (newest !== undefined) {
          const root = newest.thread !== undefined && newest.thread !== "" ? newest.thread : newest.id;
          flags.set("thread", root);
          io.writeErr(
            `replying in thread ${root}, which is where ${newest.from} asked. ` +
              `Pass --top-level to post to the channel itself.`,
          );
        }
      }
      // `--attach <path>` is repeatable: upload each file to the TARGET before
      // sending, so the message and its files arrive together, then send the
      // text carrying the uploaded file metadata (the id + local path).
      const attachPaths = collectValues(args, "--attach");
      let files: Attachment[] | undefined;
      const links: string[] = [];
      if (attachPaths.length > 0) {
        for (const p of attachPaths) {
          // The FIRST attachment carries the message text, so the words and the
          // file are one message rather than two; the rest are bare uploads.
          const up = await attachmentUpload(
            p,
            req.channel,
            flags.get("mime-type"),
            io,
            backend,
            nameFor(flags, io),
            files === undefined ? text : undefined,
            flags.get("thread"),
          );
          if (!up.ok) {
            io.writeErr(up.error);
            return 1;
          }
          files = files ?? [];
          files.push({ id: up.id, name: basename(p), mime: guessMime(p), size: sizeOf(p), path: p });
          if (up.permalink !== undefined) links.push(up.permalink);
        }
      }
      // The upload SHARES the file into the channel (channel_id on
      // completeUploadExternal), so the text carries the message and nothing
      // else. The permalink used to be appended here because a broken upload
      // shared nothing and the unfurl was the only thing that attached it; with
      // the bytes posted correctly that workaround would just add a link nobody
      // needs to read.
      void links;
      // With an attachment the upload already posted the message and its text,
      // so posting again would repeat the words beside the file.
      if (backend === "slack" && attachPaths.length > 0) return 0;
      return postText(req.channel, text, flags, io, backend, files);
    }
    case "react": {
      // `message react --target <channel> --to <ts> --emoji <name>`: a reaction
      // is an acknowledgement that costs the channel no line.
      const req = requireTarget(flags, io);
      if (!req.ok) return 1;
      const to = flags.get("to");
      const emoji = flags.get("emoji");
      if (to === undefined || emoji === undefined) {
        io.writeErr("message react requires --to <message-ts> and --emoji <name>");
        return 1;
      }
      if (backend !== "slack") {
        io.writeErr("message react needs the slack backend");
        return 1;
      }
      const s2 = slackBackend(io);
      if (s2.error !== undefined || s2.backend === undefined) {
        io.writeErr(s2.error ?? "slack backend unavailable");
        return 1;
      }
      const rr = await s2.backend.react(req.channel, to, emoji, nameFor(flags, io));
      if (!rr.ok) {
        io.writeErr(`react failed: ${rr.error}`);
        return 1;
      }
      return 0;
    }
    case "check":
      return cmdMessageCheck(args, io, backend);
    case "read": {
      const req = requireTarget(flags, io);
      if (!req.ok) return 1;
      const since = intFlag(flags, "after", intFlag(flags, "since", 0));
      return historyRead(req.channel, since, flags, io, backend);
    }
    default:
      io.writeErr(`unknown message verb: ${sub ?? "(none)"}`);
      return 1;
  }
}

/** The mirrored `profile` family. `show` prints this agent's name and persona
 *  as one JSON line; `update --description <text>` writes `.scramble/persona.md`
 *  and registers it (the `join --persona` alias), under any backend since
 *  profile is the workspace identity. */
async function cmdProfile(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const sub = positionals[0];
  const name = nameFor(flags, io);
  if (sub === "show") {
    const file = join(io.cwd(), ".scramble", "persona.md");
    let persona = "";
    try {
      persona = readFileSync(file, "utf8");
    } catch {
      /* no persona written yet: report an empty persona */
    }
    io.write(JSON.stringify({ name, persona }));
    return 0;
  }
  if (sub === "update") {
    const description = flags.get("description");
    if (description === undefined || description === "") {
      io.writeErr("profile update requires --description");
      return 1;
    }
    const scamDir = join(io.cwd(), ".scramble");
    mkdirSync(scamDir, { recursive: true });
    writeFileSync(join(scamDir, "persona.md"), description);
    const { url, token } = resolveConfig(flags, io);
    const res = await io.fetch(`${url}/agents/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: JSON.stringify({ persona: description }),
    });
    if (!res.ok) {
      io.writeErr(`profile update failed (${res.status})`);
      return 1;
    }
    return 0;
  }
  io.writeErr(`unknown profile verb: ${sub ?? "(none)"}`);
  return 1;
}

/** The mirrored `channel` verbs: `channel join --target <channel>` behaves and
 *  reads exactly as the alias `join <channel>`. */
/** `scramble doctor --as <name>`: is this agent's Slack app still what the
 *  current scramble needs? An agent onboarded before a fix keeps working in the
 *  ways it always did and silently lacks the fix, which is the failure this verb
 *  exists for: nothing else tells a RUNNING agent that its own config went out of
 *  date. It repairs what it can locally (the handle, from auth.test) and names
 *  the one command for what it cannot (a scope, which needs a reinstall). */
async function cmdDoctor(argv: string[], io: Io): Promise<number> {
  const { flags } = parseArgs(argv);
  const name = nameFor(flags, io);
  const cfg = loadSlackConfig(io);
  if (cfg === null) {
    io.writeErr(`${slackConfigPath(io)} is missing or malformed`);
    return 1;
  }
  const entry = cfg.agents[name];
  if (entry === undefined) {
    io.writeErr(`doctor: no agent "${name}" in ${slackConfigPath(io)}`);
    return 1;
  }
  const token = entry.token ?? cfg.token;
  if (!token) {
    io.writeErr(`doctor: agent "${name}" has no bot token, and the config has no default`);
    return 1;
  }
  const problems: string[] = [];
  const fixed: string[] = [];

  // ONE call answers both questions: auth.test returns the handle in its body
  // and the granted scopes in its x-oauth-scopes header.
  const res = await io.fetch("https://slack.com/api/auth.test", {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as {
    ok?: boolean;
    user?: string;
    error?: string;
    is_enterprise_install?: boolean;
  };
  if (body.ok !== true) {
    io.writeErr(`doctor: auth.test answered ${String(body.error)}; this agent's token is not usable`);
    return 1;
  }
  const handle = String(body.user);
  const granted = new Set((res.headers.get("x-oauth-scopes") ?? "").split(",").map((x) => x.trim()).filter((x) => x !== ""));

  if (entry.handle !== handle) {
    const raw = JSON.parse(readFileSync(slackConfigPath(io), "utf8")) as {
      agents?: Record<string, Record<string, unknown>>;
    };
    raw.agents = raw.agents ?? {};
    raw.agents[name] = { ...(raw.agents[name] ?? {}), handle };
    writeFileSync(slackConfigPath(io), `${JSON.stringify(raw, null, 2)}\n`);
    fixed.push(`recorded the Slack handle @${handle}, so a mention of it now marks this agent`);
  }

  // THE SILENT INBOX. An org install of an app whose manifest says
  // org_deploy_enabled:false is a contradiction Slack accepts without a word:
  // every REST call works, the socket opens and says hello, and no event is ever
  // delivered, so `listen` runs forever and the agent looks like it is in a quiet
  // channel. Checked here because doctor is where an agent asks whether its own
  // wake path is real, and because nothing else would ever say it.
  //
  // AN UNSUBSCRIBED EVENT IS THE SAME SILENCE, reached a different way: Slack
  // sends nothing for an event the app does not ask for, so an app created
  // before an event was added to the manifest keeps a wake path that is dead for
  // exactly that one kind of news and healthy for every other. That is how an
  // invite delivered nothing while mentions kept arriving (operator, 2026-08-22:
  // "invited but inbox does not fire"). Both answers come from ONE manifest read.
  const declared = await declaredManifest(io, name);
  if (declared !== undefined) {
    if (body.is_enterprise_install === true && !declared.orgDeploy) {
      problems.push(
        `this app is installed ORG-WIDE (auth.test: is_enterprise_install true) while its ` +
          `manifest declares org_deploy_enabled:false. Slack accepts that combination and ` +
          `delivers NO events for it, so your inbox monitor will sit silent forever while ` +
          `every read still works. Fix: bun scripts/onboard-agent.ts ${name}`,
      );
    }
    const unsubscribed = BOT_EVENT_NAMES.filter((e) => !declared.botEvents.includes(e));
    if (unsubscribed.length > 0) {
      problems.push(
        `this app does not subscribe to ${unsubscribed.join(", ")}. Slack delivers NOTHING ` +
          `for an unsubscribed event, so that news never reaches your inbox while everything ` +
          `else arrives normally. Fix: bun scripts/onboard-agent.ts ${name}`,
      );
    }
  }

  // A LISTENER OLDER THAN THE CODE is running a build that no longer exists,
  // which looks exactly like a defect that was already fixed.
  const staleProblem = staleListenerProblem(staleListeners(io, name), name);
  if (staleProblem !== undefined) problems.push(staleProblem);

  // AND FOR AN INSTALLED AGENT, the commit is a fact rather than an inference.
  // The launcher execs the resolved commit directory, so a listener carries its
  // version in its own command line; comparing that against the installed one
  // answers "is this process running the code I have" without touching mtimes,
  // which for an installed copy describe the wrong tree entirely.
  // A HOST WHOSE PROCESS TABLE CANNOT BE READ SAYS SO. Both listener checks read
  // /proc, which a Linux host has and others do not, and both answer "nothing
  // wrong" when they cannot look. `ok` would then mean "checked and fine" on a
  // machine where nothing was checked.
  const procRoot = io.env("SCRAMBLE_PROC") ?? "/proc";
  if (!processesReadable(procRoot)) {
    problems.push(
      `this host has no readable process table at ${procRoot}, so NOTHING here checked your ` +
        `listeners: neither whether one is running stale code nor whether one runs a different ` +
        `commit than the install. Check by hand with ps, and treat a quiet inbox as unexplained.`,
    );
  }
  const installedNow = installedCommit(io);
  const behind = listenersBehind(readProcesses(io.env("SCRAMBLE_PROC") ?? "/proc"), name, installedNow);
  if (behind.length > 0) {
    problems.push(
      `${behind.length} listener(s) for ${name} run a different commit than the installed ${installedNow}: ` +
        `${behind.map((b) => `pid ${b.pid} on ${b.commit}`).join(", ")}. They hold the code they started ` +
        `with, so a fix you installed has not reached them. Stop them and arm the inbox again.`,
    );
  }

  const missing = SCOPE_NAMES.filter((sc) => !granted.has(sc));
  if (missing.length > 0) {
    problems.push(
      `this app is missing ${missing.length} scope(s): ${missing.join(", ")}. ` +
        `A scope needs a reinstall, which the agent does for itself: ` +
        `bun scripts/onboard-agent.ts ${name}`,
    );
  }

  // `--wake <channel>` is opt-in because it POSTS a line into that channel.
  const wakeChannel = flags.get("wake");
  if (wakeChannel !== undefined && wakeChannel !== "") {
    // A TEST WHOSE ANSWER WOULD BE MEANINGLESS IS NOT RUN. Slack hands each
    // Socket Mode event to ONE connection, so an armed listener takes the probe
    // and this test times out and calls the wake path DEAD. Its own advice then
    // says to re-onboard, which rotates the bot token and strands that listener.
    // Refusing to run beats answering wrongly on the most alarming surface here.
    const holding = liveListeners(readProcesses(io.env("SCRAMBLE_PROC") ?? "/proc"), name);
    if (holding.length > 0) {
      io.writeErr(
        `doctor: not testing the wake path while ${holding.length} listener(s) for ${name} hold the ` +
          `socket (pid ${holding.join(", ")}). Slack gives each event to ONE connection, so they would ` +
          `take the probe and this would report the path DEAD when it is alive. Stop them, run this, ` +
          `then arm the inbox again.`,
      );
      return problems.length === 0 ? 0 : 1;
    }
    const w = await proveWake(io, name, wakeChannel, intFlag(flags, "wake-timeout", 20));
    if (w.ok) {
      io.write(JSON.stringify({ doctor: "wake", agent: name, channel: wakeChannel, delivered: w.ts }));
    } else {
      problems.push(w.error);
    }
  }

  for (const f of fixed) io.write(JSON.stringify({ doctor: "fixed", agent: name, detail: f }));
  for (const p of problems) io.writeErr(`doctor: ${p}`);
  if (problems.length === 0) {
    io.write(JSON.stringify({ doctor: "ok", agent: name, handle, scopes: granted.size }));
    return 0;
  }
  return 1;
}

/** `doctor --wake`: prove the wake path CARRIES A MESSAGE, rather than proving
 *  it connects. A listener whose socket delivers nothing is indistinguishable
 *  from a quiet channel, so on 2026-08-21 I armed a monitor, watched the process
 *  stay alive, and reported it working while it delivered nothing for hours
 *  (postmortem: akrust log/postmortems/
 *  2026-08-21-armed-a-monitor-without-proving-it-receives.md).
 *
 *  Open the socket, post one probe line, and require the FRAME for that exact ts
 *  to come back. The probe is the agent's own message on purpose: it needs no
 *  second identity, and the socket carries an app's own posts even though
 *  `listen` filters them out of delivery, so this tests the transport without
 *  needing anyone else to type. */
async function proveWake(
  io: Io,
  agent: string,
  channel: string,
  seconds: number,
): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  const cfg = loadSlackConfig(io);
  if (cfg === null) return { ok: false, error: `${slackConfigPath(io)} is missing or malformed` };
  const slackId = cfg.channels[channel];
  if (slackId === undefined) return { ok: false, error: `no Slack channel for channel ${channel}` };
  const appToken = cfg.agents[agent]?.appToken ?? cfg.appToken ?? "";
  const botToken = cfg.agents[agent]?.token ?? cfg.token;
  if (appToken === "") {
    return { ok: false, error: `agent "${agent}" has no appToken, so it has no socket to wake on` };
  }
  if (!io.createSocket) return { ok: false, error: "no socket factory seam is bound" };
  const opened = await io.fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}` },
  });
  const oj = (await opened.json()) as { ok?: boolean; url?: string; error?: string };
  if (oj.ok !== true || typeof oj.url !== "string") {
    return { ok: false, error: `apps.connections.open answered ${String(oj.error)}` };
  }
  const socket = io.createSocket(oj.url);
  // BUFFER THE FRAMES. Checking each frame against the ts we are waiting for
  // loses the race when Slack echoes the post back before chat.postMessage has
  // returned that ts, which a test caught: the frame arrives, the code does not
  // yet know what to look for, and a live path reports itself dead.
  const frames: string[] = [];
  socket.onmessage = (data) => {
    frames.push(data);
  };
  // Give the socket a moment to finish its handshake before the probe is posted,
  // or the frame can be missed and a healthy path reported as dead.
  await io.sleep(2000);
  const sent = await io.fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: slackId, text: `scramble doctor --wake probe for ${agent}` }),
  });
  const sj = (await sent.json()) as { ok?: boolean; ts?: string; error?: string };
  if (sj.ok !== true || typeof sj.ts !== "string") {
    socket.close();
    return { ok: false, error: `the probe could not be posted: ${String(sj.error)}` };
  }
  const posted = sj.ts;
  const arrived = (): boolean => frames.some((f) => f.includes(posted));
  for (let waited = 0; waited < seconds * 1000 && !arrived(); waited += 500) {
    await io.sleep(500);
  }
  socket.close();
  if (!arrived()) {
    return {
      ok: false,
      error:
        `the socket opened and no frame arrived for the probe (ts ${posted}) within ${seconds}s. ` +
        `The wake path is DEAD: an inbox monitor on it would sit silent forever while every ` +
        `read keeps working. Run: bun scripts/onboard-agent.ts ${agent}`,
    };
  }
  return { ok: true, ts: posted };
}

/** A `listen` process for this agent that STARTED BEFORE the newest source file
 *  is running code that no longer exists. Twice on 2026-08-21 that produced a
 *  visible defect the code had already fixed: an agent delivered its own posts
 *  for minutes after the self-filter landed, and kept posting `working` messages
 *  after the living message was deleted. A landed fix does not reach a running
 *  process, and nothing said so.
 *
 *  Reads /proc, so it answers undefined where that is absent rather than
 *  guessing. */
export function staleListeners(io: Io, agent: string): Array<{ pid: string; ageBehind: number }> | undefined {
  const newest = newestSourceMs(io);
  if (newest === undefined) return undefined;
  return pickStale(readProcesses(io.env("SCRAMBLE_PROC") ?? "/proc"), agent, newest);
}

/** The newest mtime among this workspace's sources, or undefined when there is
 *  no `src` to compare against. */
function newestSourceMs(io: Io): number | undefined {
  let newest = 0;
  try {
    for (const f of readdirSync(join(io.cwd(), "src"))) {
      if (f.endsWith(".ts")) newest = Math.max(newest, statSync(join(io.cwd(), "src", f)).mtimeMs);
    }
  } catch {
    return undefined;
  }
  return newest === 0 ? undefined : newest;
}

/** Every process this host will admit to, as (pid, cmdline, startedMs). Reads
 *  /proc and answers an empty list where that is absent, so the DECISION below
 *  stays pure and testable while the reading stays thin. */
/** Can this host's process table be read at all?
 *
 *  `readProcesses` answers the empty list for BOTH "nothing matched" and "there
 *  is no /proc here", and doctor cannot tell those apart: on a host without
 *  /proc it printed `doctor: ok` having inspected no listener at all, and the
 *  agent reading that has been told its listeners are fine when nothing looked.
 *  Anything that is about to run on other machines needs this separated. */
export function processesReadable(root = "/proc"): boolean {
  try {
    readdirSync(root);
    return true;
  } catch {
    return false;
  }
}

export function readProcesses(root = "/proc"): Array<{ pid: string; cmd: string; startedMs: number }> {
  const out: Array<{ pid: string; cmd: string; startedMs: number }> = [];
  let pids: string[] = [];
  try {
    pids = readdirSync(root);
  } catch {
    return out;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      out.push({
        pid,
        cmd: readFileSync(`${root}/${pid}/cmdline`, "utf8").replace(/\0/g, " "),
        startedMs: statSync(`${root}/${pid}`).mtimeMs,
      });
    } catch {
      // A process that exited between the listing and the read is not stale, it
      // is gone.
    }
  }
  return out;
}

/** What doctor SAYS about stale listeners, or undefined when there is nothing to
 *  say. Separated from the finding so the sentence an operator acts on is tested
 *  rather than assumed. */
export function staleListenerProblem(
  stale: Array<{ pid: string; ageBehind: number }> | undefined,
  agent: string,
): string | undefined {
  if (stale === undefined || stale.length === 0) return undefined;
  return (
    `${stale.length} listener(s) for ${agent} started BEFORE the newest source change ` +
    `(pid ${stale.map((x) => `${x.pid}, ${x.ageBehind}s behind`).join("; ")}). They are running code ` +
    `that no longer exists, so a landed fix has not reached them. Stop them and arm the inbox again.`
  );
}

/** The commit the launcher on PATH would run now, read from the COMMIT file of
 *  the directory `current` resolves to. Empty when nothing is installed, which
 *  makes every comparison against it a no-op. */
export function installedCommit(io: Io): string {
  const home = io.env("HOME");
  const root = io.env("SCRAMBLE_HOME") ?? (home === undefined ? "" : join(home, ".local", "share", "scramble"));
  if (root === "") return "";
  try {
    return readFileSync(join(root, "current", "src", "COMMIT"), "utf8").trim();
  } catch {
    return "";
  }
}

/** The commit a listener is RUNNING, taken from its own command line.
 *
 *  The installed launcher execs the resolved commit directory, so a long-lived
 *  process carries its version where anyone can read it. Empty for a listener
 *  started from a checkout, which has no commit to name and is the case worth
 *  reporting differently.
 *
 *  This replaces guessing from file mtimes for installed agents: mtimes compare
 *  a process against whatever `src` happens to sit in the CURRENT directory,
 *  which for an agent running an installed copy is not the code it loaded. */
export function listenerCommit(cmd: string): string {
  const m = /\/scramble\/([0-9a-f]{7,40})\/src\/bin\.ts/.exec(cmd);
  return m?.[1] ?? "";
}

/** Listeners for this agent running a commit OTHER than the one installed now,
 *  as `pid → commit`. Empty when nothing is behind, and a listener with no
 *  commit in its command line is left out: it is a checkout, which the stale
 *  mtime check already reports. */
export function listenersBehind(
  procs: Array<{ pid: string; cmd: string }>,
  agent: string,
  installed: string,
): Array<{ pid: string; commit: string }> {
  if (installed === "") return [];
  const asFlag = `--as ${agent}`;
  return procs
    .filter((p) => p.cmd.includes("bin.ts listen") && p.cmd.includes(asFlag))
    .map((p) => ({ pid: p.pid, commit: listenerCommit(p.cmd) }))
    .filter((p) => p.commit !== "" && p.commit !== installed);
}

/** Every LIVE listener for this agent, whatever its age. Pure, and separate from
 *  pickStale because the question is different: pickStale asks which listeners
 *  are behind the code, and this asks whether anything is holding the socket at
 *  all.
 *
 *  `doctor --wake` needs it. Slack delivers each Socket Mode event to ONE
 *  connection, so an armed listener takes the probe frame and doctor's own
 *  socket waits out its timeout and pronounces the wake path DEAD. Measured
 *  2026-08-22: with the inbox armed, `doctor --wake` said "The wake path is
 *  DEAD" and told me to re-onboard, which rotates the bot token; with the same
 *  inbox stopped and nothing else changed, the same command answered
 *  `"delivered":"1787365205.175139"`. The advice was worse than the verdict —
 *  following it would have rotated a working token and stranded the listener. */
export function liveListeners(
  procs: Array<{ pid: string; cmd: string; startedMs: number }>,
  agent: string,
): string[] {
  const asFlag = `--as ${agent}`;
  return procs.filter((p) => p.cmd.includes("bin.ts listen") && p.cmd.includes(asFlag)).map((p) => p.pid);
}

/** WHICH of those are listeners for this agent that predate the code. Pure, so
 *  the rule is tested without spawning anything. */
export function pickStale(
  procs: Array<{ pid: string; cmd: string; startedMs: number }>,
  agent: string,
  newestSourceMs: number,
): Array<{ pid: string; ageBehind: number }> {
  // `--as <agent>`, not the name ANYWHERE in the command line. A bare substring
  // match reported every listener as belonging to every agent whenever an
  // agent's name also appeared in the checkout path, which is ordinary: name an
  // agent after the product and every process running from the product's own
  // directory matches it. Measured here, doctor named the same three pids under
  // two agents and told me to restart listeners that were not mine. A detector
  // that cries wolf is worth less than no detector, since I stop reading it.
  const asFlag = `--as ${agent}`;
  return procs
    .filter((p) => p.cmd.includes("bin.ts listen") && p.cmd.includes(asFlag) && p.startedMs < newestSourceMs)
    .map((p) => ({ pid: p.pid, ageBehind: Math.round((newestSourceMs - p.startedMs) / 1000) }));
}

/** What this agent's app DECLARES: whether it deploys org-wide, and which events
 *  it subscribes to. Read from the app's own manifest through the Slack CLI
 *  credential, which is the only token that can export it, in ONE call because
 *  both answers come from the same document. Returns undefined when that
 *  credential is absent, so a host without it reports nothing rather than
 *  guessing. */
async function declaredManifest(
  io: Io,
  agent: string,
): Promise<{ orgDeploy: boolean; botEvents: string[] } | undefined> {
  const home = io.env("HOME");
  if (home === undefined || home === "") return undefined;
  let cliToken = "";
  let appId = "";
  try {
    const creds = JSON.parse(readFileSync(join(home, ".slack", "credentials.json"), "utf8")) as Record<
      string,
      { token?: string }
    >;
    for (const v of Object.values(creds)) {
      if (typeof v.token === "string" && v.token !== "") {
        cliToken = v.token;
        break;
      }
    }
  } catch {
    return undefined;
  }
  const cfg = loadSlackConfig(io);
  if (cfg === null || cliToken === "") return undefined;
  // THE AGENT BEING CHECKED, not whichever entry happens to be last. The first
  // version of this took the last appId in the config, so a healthy agent's
  // manifest answered for a broken one and doctor cleared an app whose inbox
  // was dead. Its own control caught it.
  appId = cfg.agents[agent]?.appId ?? "";
  if (appId === "") return undefined;
  const r = await io.fetch("https://slack.com/api/apps.manifest.export", {
    method: "POST",
    headers: { authorization: `Bearer ${cliToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId }),
  });
  const j = (await r.json()) as {
    ok?: boolean;
    manifest?: {
      settings?: { org_deploy_enabled?: boolean; event_subscriptions?: { bot_events?: string[] } };
    };
  };
  if (j.ok !== true) return undefined;
  const settings = j.manifest?.settings;
  return {
    orgDeploy: settings?.org_deploy_enabled === true,
    botEvents: settings?.event_subscriptions?.bot_events ?? [],
  };
}

async function cmdChannel(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const sub = positionals[0];
  if (sub !== "join") {
    io.writeErr(`unknown channel verb: ${sub ?? "(none)"}`);
    return 1;
  }
  const req = requireTarget(flags, io);
  if (!req.ok) return 1;
  const backend = selectBackend(argv, io);
  if (backend === null) return 1;
  if (backend === "slack") return joinChannelSlack(req.channel, flags, io);
  return joinChannel(req.channel, flags, io);
}

/** `channel join` on the Slack backend. Joining is not something an app can do:
 *  a member invites it, public channel or private. So this REPORTS the state
 *  that matters, whether the invite has happened, and prints the invite line
 *  when it has not. It never writes to the local daemon, which is not running
 *  under this backend. */
async function joinChannelSlack(channel: string, flags: Map<string, string>, io: Io): Promise<number> {
  const name = nameFor(flags, io);
  const s = slackBackend(io);
  if (s.error !== undefined || s.backend === undefined) {
    io.writeErr(s.error ?? "slack backend unavailable");
    return 1;
  }
  const m = await s.backend.membership(channel, name);
  if (!m.ok) {
    io.writeErr(`channel join: ${m.error}`);
    return 1;
  }
  if (m.joined) {
    io.write(JSON.stringify({ channel, agent: name, joined: true, detail: m.detail }));
    return 0;
  }
  io.writeErr(
    `channel join: ${name} is NOT in ${channel} (${m.detail}). An app cannot add itself to a ` +
      `Slack conversation: ask a member of ${channel} to run  /invite @${m.handle}`,
  );
  return 1;
}

/** Which backend this run uses. Selected by `--backend <name>` (highest
 *  precedence), then `SCRAMBLE_BACKEND`, and with NEITHER given it follows the
 *  config on disk: a slack config present means slack, its absence means the
 *  local daemon. An unknown backend name is REPORTED, naming the two backends
 *  that exist. Returns null when a name was given but matched neither, after the
 *  error is written to stderr.
 *
 *  IT USED TO DEFAULT TO LOCAL WHATEVER WAS CONFIGURED, and that is a failure
 *  surface rather than a preference. The local backend answers from a store that
 *  the listener fills, so a Slack agent that forgot the environment variable got
 *  a TRANSCRIPT, not an error: `message read` on a channel it had just been
 *  invited to printed nothing and exited 0 while Slack held twenty messages in
 *  it, and the same read of a busy channel returned whatever the store happened
 *  to have cached. An empty answer that looks like a quiet channel is exactly the
 *  shape that has to be impossible to construct, so the default now comes from
 *  the same file that decides everything else about a Slack agent. */
export function selectBackend(argv: string[], io: Io): "local" | "slack" | null {
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--backend") {
      name = argv[i + 1];
      break;
    }
    if (a.startsWith("--backend=")) {
      name = a.slice("--backend=".length);
      break;
    }
  }
  if (name === undefined) name = io.env("SCRAMBLE_BACKEND");
  if (name === undefined) return loadSlackConfig(io) === null ? "local" : "slack";
  if (name === "local") return "local";
  if (name === "slack") return "slack";
  io.writeErr(`unknown backend '${name}'; the backends are 'local' and 'slack'`);
  return null;
}

export async function main(argv: string[], io: Io): Promise<number> {
  const backend = selectBackend(argv, io);
  if (backend === null) return 1;
  // Every scramble invocation clears whatever has expired before its own work,
  // whatever verb it is. Awaited (not fire-and-forget) so a short-lived verb
  // finishes the expiry sweep's ledger write before the process exits.
  // SCRAMBLE_STATUS=off makes this a no-op.
  await settleStatus(statusTracker(io, backend, nameFor(parseArgs(argv.slice(1)).flags, io))?.clearExpired(), io);
  switch (argv[0]) {
    case "post":
      return cmdPost(argv.slice(1), io);
    case "listen":
      if (backend === "slack") return slackCmdListen(argv.slice(1), io);
      return cmdListen(argv.slice(1), io);
    case "next":
      if (backend === "slack") return slackCmdNext(argv.slice(1), io);
      return cmdNext(argv.slice(1), io);
    case "history":
      return cmdHistory(argv.slice(1), io);
    case "message":
      return cmdMessage(argv.slice(1), io, backend);
    case "attachment":
      return cmdAttachment(argv.slice(1), io);
    case "profile":
      return cmdProfile(argv.slice(1), io);
    case "channel":
      return cmdChannel(argv.slice(1), io);
    case "inbox":
      return cmdInbox(argv.slice(1), io);
    case "lint":
      return cmdLint(argv.slice(1), io);
    case "version":
      return cmdVersion(io);
    case "doctor":
      return cmdDoctor(argv.slice(1), io);
    case "join":
      return cmdJoin(argv.slice(1), io);
    case "serve":
      return cmdServe(argv.slice(1), io);
    default:
      io.writeErr(`unknown: ${argv[0] ?? "(none)"}`);
      return 1;
  }
}