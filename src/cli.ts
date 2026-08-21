// src/cli.ts — the agent-facing CLI. Every command prints ONE JSON line per
// message to stdout and sends all diagnostics to stderr. All IO flows through
// the injected `io` seams so tests drive main() with a fake io and the
// in-process handler from src/server.ts as fetch — no child process, no
// socket, no real delay. Process argv and the real daemon bind live in
// src/bin.ts, which no test imports.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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

function cursorPath(io: Io): string {
  return join(io.cwd(), ".scramble", CURSOR_FILE);
}

function readCursor(io: Io, name: string): number {
  try {
    const j = JSON.parse(readFileSync(cursorPath(io), "utf8")) as Record<string, number>;
    return typeof j[name] === "number" ? j[name] : 0;
  } catch {
    return 0;
  }
}

function writeCursor(io: Io, name: string, seq: number): void {
  const p = cursorPath(io);
  let j: Record<string, number> = {};
  try {
    j = JSON.parse(readFileSync(p, "utf8")) as Record<string, number>;
  } catch {
    /* absent cursor file is a fresh ledger */
  }
  j[name] = seq;
  mkdirSync(join(io.cwd(), ".scramble"), { recursive: true });
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
  const thread = flags.get("thread") ?? undefined;
  const status = statusTracker(io, backend);
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
          io.write(JSON.stringify(m));
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
        io.write(JSON.stringify(found.line));
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
    const r = await s.backend.history(channel, since > 0 ? String(since) : undefined, statusTts(statusTracker(io, "slack")), nameFor(flags, io));
    for (const p of r.problems) io.writeErr(`slack: ${p}`);
    if (r.code !== 0) {
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
    const agents = j.agents as Record<string, { token?: string; icon?: string; appToken?: string }> | undefined;
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
function statusTracker(io: Io, backend: "local" | "slack"): StatusManager | undefined {
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
      token = cfg.token;
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
function deliverStatus(status: StatusManager, m: { channel?: unknown; mentioned?: unknown }, agent: string): Promise<void> {
  if (m.mentioned !== true) return Promise.resolve();
  if (typeof m.channel !== "string") return Promise.resolve();
  return status.setOn(m.channel, agent);
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
function statusTts(status: StatusManager | undefined): ReadonlySet<string> {
  return status === undefined ? new Set<string>() : status.livingTts();
}

/** A slack-backend `message check` cursor is a PER-CHANNEL map (channel name ->
 *  newest Slack ts), stored under a namespaced key in the same cursor.json so it
 *  never collides with the local backend's agent-keyed integer cursor. Slack has
 *  no global sequence, so the honest resume point is a conversation ts per
 *  channel, kept client-side like the local cursor. */
const SLACK_CURSOR_PREFIX = "slack:";

function readSlackCursor(io: Io, name: string): Record<string, string> {
  try {
    const j = JSON.parse(readFileSync(cursorPath(io), "utf8")) as Record<string, unknown>;
    const v = j[`${SLACK_CURSOR_PREFIX}${name}`];
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      return v as Record<string, string>;
  } catch {
    /* absent or corrupt cursor: a fresh per-channel ledger, drain from the start */
  }
  return {};
}

function writeSlackCursor(io: Io, name: string, perChannel: Record<string, string>): void {
  const p = cursorPath(io);
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    /* absent cursor file is a fresh ledger */
  }
  j[`${SLACK_CURSOR_PREFIX}${name}`] = perChannel;
  mkdirSync(join(io.cwd(), ".scramble"), { recursive: true });
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
  const { flags, positionals } = parseArgs(argv);
  const name = nameFor(flags, io);
  const timeoutSec = intFlag(flags, "timeout", 300);
  const status = statusTracker(io, "slack");
  await settleStatus(status?.clearExpired(), io);
  const s = slackBackend(io);
  if (s.error !== undefined || s.backend === undefined) {
    io.writeErr(s.error ?? "slack unavailable");
    return 1;
  }
  const r = await s.backend.next(positionals, name, timeoutSec, (p) => io.writeErr(`slack: ${p}`), statusTts(status));
  if (r.code === 64) return 64;
  // code 1 means scramble could not look (the socket open was refused): the
  // refusal was already reported on stderr, so surface it as a nonzero exit
  // that a harness never mistakes for a quiet channel.
  if (r.code === 1) return 1;
  if (r.line !== undefined) {
    if (status !== undefined) await settleStatus(deliverStatus(status, r.line, name), io);
    io.write(JSON.stringify(r.line));
  }
  return 0;
}

async function slackCmdListen(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const name = nameFor(flags, io);
  const s = slackBackend(io);
  if (s.error !== undefined || s.backend === undefined) {
    io.writeErr(s.error ?? "slack unavailable");
    return 1;
  }
  const status = statusTracker(io, "slack");
  const stopTicker = status ? status.startExpiryTicker(2000, io.sleep) : undefined;
  try {
    return await s.backend.listen(
      positionals,
      name,
      (d) => {
        if (status !== undefined) void deliverStatus(status, d, name);
        io.write(JSON.stringify(d));
      },
      (p) => io.writeErr(`slack: ${p}`),
      statusTts(status),
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
    io.write(JSON.stringify(d));
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
  const name = nameFor(flags, io);
  const status = statusTracker(io, "slack");
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
  const tts = statusTts(status);
  for (const channel of Object.keys(cfg.channels).sort()) {
    const cursor = started[channel];
    // `oldest` is inclusive in Slack, so re-filter to strictly-newer lines: the
    // cursor line itself must not re-drain on a repeat `message check`.
    const r = await s.backend.history(channel, cursor === undefined ? undefined : cursor, tts, name);
    for (const p of r.problems) io.writeErr(`slack: ${p}`);
    if (r.code !== 0) {
      io.writeErr(`read failed: ${r.error}`);
      return 1;
    }
    const fresh =
      cursor === undefined ? r.messages : r.messages.filter((m) => slackTs(m.ts) > slackTs(cursor));
    let newest: string | undefined = cursor;
    for (const m of fresh) {
      // The cursor advances past EVERY fresh line, including a skipped one, so
      // a repeated sweep never re-reads an own message forever.
      newest = newerTs(newest, m.ts);
      const mentioned = m.mentions.includes(name);
      const line = { ...m, mentioned };
      // `message check` is a DELIVERY verb: its drain hands the agent what has
      // ARRIVED FOR it, and its own post has not arrived for anybody. Skip the
      // line whose resolved sender is the draining agent, by the same name
      // comparison `listen` and `next` use, so an agent sweeping does not read
      // its own last message as new traffic. `message read` (a transcript)
      // keeps every line — only the DELIVERY drain filters.
      if (m.from === name) continue;
      if (status !== undefined) await settleStatus(deliverStatus(status, line, name), io);
      io.write(JSON.stringify(line));
    }
    if (newest !== undefined) next[channel] = newest;
  }
  writeSlackCursor(io, name, next);
  return 0;
}

async function cmdMessageCheck(argv: string[], io: Io, backend: "local" | "slack"): Promise<number> {
  const { flags } = parseArgs(argv);
  if (backend === "slack") return messageCheckSlack(flags, io);
  return messageCheckLocal(flags, io);
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
): Promise<AttachResult> {
  if (backend === "slack") {
    const cfg = loadSlackConfig(io);
    if (cfg === null || !cfg.token) return { ok: false, error: "slack backend requires a bot token" };
    const slackId = cfg.channels[targetChannel];
    if (!slackId) return { ok: false, error: `no Slack channel for channel ${targetChannel}` };
    const token = (as !== undefined ? cfg.agents[as]?.token : undefined) ?? cfg.token;
    const r = await uploadToSlack(io.fetch, token, path, slackId, mimeOverride);
    return r.ok ? { ok: true, id: r.out.id, permalink: r.out.permalink } : { ok: false, error: r.error };
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
      // `--attach <path>` is repeatable: upload each file to the TARGET before
      // sending, so the message and its files arrive together, then send the
      // text carrying the uploaded file metadata (the id + local path).
      const attachPaths = collectValues(args, "--attach");
      let files: Attachment[] | undefined;
      const links: string[] = [];
      if (attachPaths.length > 0) {
        for (const p of attachPaths) {
          const up = await attachmentUpload(p, req.channel, flags.get("mime-type"), io, backend, nameFor(flags, io));
          if (!up.ok) {
            io.writeErr(up.error);
            return 1;
          }
          files = files ?? [];
          files.push({ id: up.id, name: basename(p), mime: guessMime(p), size: sizeOf(p), path: p });
          if (up.permalink !== undefined) links.push(up.permalink);
        }
      }
      // THE LINK IS THE ATTACHMENT on Slack. Slack unfurls a file permalink in
      // the message text into the file itself, and asking
      // completeUploadExternal to share instead answers ok:true while sharing
      // with nothing. So the link rides in the text, and the local backend,
      // which carries `files` on the line, needs no link.
      const body = links.length > 0 ? `${text.trimEnd()}\n${links.join("\n")}` : text;
      return postText(req.channel, body, flags, io, backend, files);
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
async function cmdChannel(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const sub = positionals[0];
  if (sub !== "join") {
    io.writeErr(`unknown channel verb: ${sub ?? "(none)"}`);
    return 1;
  }
  const req = requireTarget(flags, io);
  if (!req.ok) return 1;
  return joinChannel(req.channel, flags, io);
}

/** Which backend this run uses: the local daemon (the default) or the slack
 *  backend. Selected by `--backend <name>` (highest precedence) or
 *  `SCRAMBLE_BACKEND`. Defaults to local. An unknown backend name is REPORTED,
 *  naming the two backends that exist. Returns null when a name was given but
 *  matched neither, after the error is written to stderr. */
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
  if (name === undefined || name === "local") return "local";
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
  await settleStatus(statusTracker(io, backend)?.clearExpired(), io);
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
    case "join":
      return cmdJoin(argv.slice(1), io);
    case "serve":
      return cmdServe(argv.slice(1), io);
    default:
      io.writeErr(`unknown: ${argv[0] ?? "(none)"}`);
      return 1;
  }
}