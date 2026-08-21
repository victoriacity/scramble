// src/cli.ts — the agent-facing CLI. Every command prints ONE JSON line per
// message to stdout and sends all diagnostics to stderr. All IO flows through
// the injected `io` seams so tests drive main() with a fake io and the
// in-process handler from src/server.ts as fetch — no child process, no
// socket, no real delay. Process argv and the real daemon bind live in
// src/bin.ts, which no test imports.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createStore, type ChannelStore } from "./store";
import type { Message, PostResult } from "./types";
import type { ServeOptions } from "./server";
import { createBridge, type SlackConfig, type SlackTransport } from "./slack";
import { RaftBackend, type RunFn } from "./raft";
import { SlackBackend, type SlackBackendConfig } from "./slack-backend";
import type { SlackSocket } from "./slack-transport";
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
  /** Build the Slack transport for a bridge. The real socket factory and
   *  network bind live in src/bin.ts; tests inject a fake transport so main()
   *  needs no network. */
  createTransport(cfg: SlackConfig): SlackTransport;
  /** The socket factory for the slack BACKEND's Socket Mode stream. The real
   *  wiring (bun's WebSocket) lives in src/bin.ts; tests inject a fake so
   *  next/listen touch no socket. */
  createSocket?(url: string): SlackSocket;
  /** The process seam for the raft backend: shell out to a command, piping
   *  stdin, returning its exit and output. The real spawn lives in src/bin.ts
   *  so tests inject a fake run and need no raft binary, no network, and no
   *  credential. */
  run?(cmd: string, args: string[], stdin: string): Promise<{ exit: number; stdout: string; stderr: string }>;
  /** this process's id, for the bridge's single-instance lock. */
  pid?(): number;
  /** is that pid still running? injected so the lock is testable without a
   *  real process. */
  alive?(pid: number): boolean;
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
  return postText(channel, text, flags, io, selectBackend(argv, io));
}

/** Local-backend post: one JSON line per crossing, nothing on a clean send with
 *  no crossing. The `--as`/name and config come from the flags. */
async function postLocalCore(
  channel: string,
  text: string,
  flags: Map<string, string>,
  io: Io,
): Promise<number> {
  const { url, token } = resolveConfig(flags, io);
  const from = nameFor(flags, io);
  const res = await io.fetch(`${url}/channels/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ from, text, id: newMessageId() }),
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
 *  the backend switch sits below the verb parsing. */
async function postText(
  channel: string,
  text: string,
  flags: Map<string, string>,
  io: Io,
  backend: "local" | "raft" | "slack",
): Promise<number> {
  const status = statusTracker(io, backend);
  void status?.clearExpired();
  if (backend === "raft") {
    const from = nameFor(flags, io);
    const r = await raftBackend(flags, io).send(channel, text, from);
    if (!r.ok) {
      io.writeErr(`post failed: ${r.error}`);
      return 1;
    }
    if (status !== undefined) replyStatus(status, channel, from);
    return 0;
  }
  if (backend === "slack") {
    const from = nameFor(flags, io);
    const s = slackBackend(io);
    if (s.error !== undefined || s.backend === undefined) {
      io.writeErr(s.error ?? "slack backend unavailable");
      return 1;
    }
    const r = await s.backend.post(channel, text, from);
    if (!r.ok) {
      io.writeErr(`post failed: ${r.error}`);
      return 1;
    }
    if (status !== undefined) replyStatus(status, channel, from);
    return 0;
  }
  const code = await postLocalCore(channel, text, flags, io);
  if (code === 0 && status !== undefined) replyStatus(status, channel, nameFor(flags, io));
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
          if (status !== undefined) deliverStatus(status, m, name);
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
  void status?.clearExpired();
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
        if (status !== undefined) deliverStatus(status, found.line, name);
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
  return historyRead(channel, since, flags, io, selectBackend(argv, io));
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

/** Read a channel's messages under whichever backend the run selects. The mirrored
 *  verb (`message read --target <channel>`) and the alias (`history <channel>`) share
 *  `--since`/`--after` as the same cursor and both dispatch here, so the backend
 *  switch stays below the verb parsing. */
async function historyRead(
  channel: string,
  since: number,
  flags: Map<string, string>,
  io: Io,
  backend: "local" | "raft" | "slack",
): Promise<number> {
  if (backend === "raft") {
    const name = nameFor(flags, io);
    const r = await raftBackend(flags, io).history(channel, name, since > 0 ? since : undefined);
    for (const p of r.problems) io.writeErr(`raft: ${p}`);
    if (r.code !== 0) {
      io.writeErr(`read failed: ${r.error}`);
      return 1;
    }
    for (const m of r.messages) io.write(JSON.stringify(m));
    return 0;
  }
  if (backend === "slack") {
    const s = slackBackend(io);
    if (s.error !== undefined || s.backend === undefined) {
      io.writeErr(s.error ?? "slack unavailable");
      return 1;
    }
    const r = await s.backend.history(channel, since > 0 ? String(since) : undefined);
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

/** Join a channel as THIS agent: scaffold `.scramble/`, read or write the persona,
 *  and register (name + persona + channel) with the daemon. Shared by the alias
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

/** Path the bridge config is read from. SCRAMBLE_SLACK_CONFIG wins, else
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

/** Load the bridge master config. The config governs which channels map to which
 *  Slack channels, each agent's identity tier, the DM mirror, and the app-level/bot
 *  tokens. Returns null when the file is absent or malformed (the caller
 *  reports it, naming the path it tried). */
export function loadSlackConfig(io: Io): Omit<SlackConfig, "postToChannel"> | null {
  try {
    const raw = readFileSync(slackConfigPath(io), "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const channels = j.channels as Record<string, string> | undefined;
    const agents = j.agents as Record<string, { token?: string; icon?: string }> | undefined;
    if (!channels || typeof channels !== "object" || !agents || typeof agents !== "object") {
      return null;
    }
    return {
      channels,
      agents,
      dmChannels: (j.dmChannels as Record<string, string>) ?? {},
      roster: (j.roster as Record<string, string>) ?? {},
      botIds: (j.botIds as string[]) ?? [],
      token: typeof j.token === "string" ? j.token : undefined,
      appToken: typeof j.appToken === "string" ? j.appToken : undefined,
      dmMirrorChannel:
        typeof j.dmMirrorChannel === "string" ? j.dmMirrorChannel : undefined,
    };
  } catch {
    return null;
  }
}

/** Valid bridge config must carry the app-level token used to open the Socket
 *  Mode connection. This reports the first missing required token. */
function slackTokenError(cfg: Pick<SlackConfig, "appToken" | "token">): string | null {
  if (!cfg.appToken) return "missing appToken (the xapp- Socket Mode app-level token)";
  return null;
}

/** Fire an inbound Slack message into a channel through the daemon's POST seam.
 *  postToChannel is a sync void seam (the bridge's contract), so the async POST
 *  fires and forgets; a failure surfaces only in the daemon log. */
/** Insert Slack-origin text into a channel. Returns the message id it used, so the
 *  bridge can recognise its OWN insert on the firehose and NOT publish it back
 *  to Slack. Without that, a human's Slack message enters the channel, streams out
 *  on the firehose, and the bridge posts it to Slack again: an echo loop,
 *  observed live on 2026-08-21 ("hi" came back as the bot three times). */
function postToChannel(
  io: Io,
  url: string,
  token: string | undefined,
  channel: string,
  from: string,
  text: string,
  id: string,
): void {
  void io
    .fetch(`${url}/channels/${encodeURIComponent(channel)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: JSON.stringify({ from, text, id }),
    })
    .catch(() => {});
}

/** The daemon's current global seq, so a fresh bridge publishes only what
 *  arrives AFTER it starts. An unreachable daemon yields 0, and the reconnect
 *  loop reports the failure by its own path. */
export async function firehoseTip(io: Io, url: string, token: string | undefined): Promise<number> {
  try {
    const res = await io.fetch(`${url}/seq`, { headers: authHeader(token) });
    if (!res.ok) return 0;
    const j = (await res.json()) as { seq?: number };
    return typeof j.seq === "number" ? j.seq : 0;
  } catch {
    return 0;
  }
}

/** Feed one firehose response's messages into the bridge's publish path,
 *  pulling the NDJSON stream to its end. */
async function feedFirehose(
  io: Io,
  res: Response,
  onMessage: (m: Message) => void,
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
      if (line) onMessage(JSON.parse(line) as Message);
      idx = buf.indexOf("\n");
    }
    ({ done, value } = await reader.read());
  }
}

/** The bridge's single-instance lock. Two bridges on one config each subscribe
 *  to the firehose, so EVERY channel message reaches Slack twice (observed
 *  2026-08-21: one line delivered at ts …024 and again at …035). The lock is a
 *  pidfile beside the config; a second bridge refuses to start while the first
 *  is alive, and a stale pidfile from a crashed bridge is reclaimed. */
export function bridgeLockPath(io: Io): string {
  return `${slackConfigPath(io)}.bridge.pid`;
}

export function acquireBridgeLock(io: Io): { ok: true; path: string } | { ok: false; holder: number } {
  const path = bridgeLockPath(io);
  const alive = io.alive ?? (() => false);
  try {
    const held = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(held) && held > 0 && alive(held)) return { ok: false, holder: held };
  } catch {
    /* absent or unreadable pidfile: nothing holds the lock */
  }
  writeFileSync(path, `${io.pid ? io.pid() : 0}\n`);
  return { ok: true, path };
}

async function cmdSlack(argv: string[], io: Io): Promise<number> {
  const { flags } = parseArgs(argv);
  const dryRun = flags.has("dry-run");
  const cfg = loadSlackConfig(io);
  if (cfg === null) {
    io.writeErr(`${slackConfigPath(io)} is missing or malformed`);
    return 1;
  }
  const tokenErr = slackTokenError(cfg);
  if (tokenErr !== null) {
    io.writeErr(tokenErr);
    return 1;
  }
  if (!dryRun) {
    const lock = acquireBridgeLock(io);
    if (!lock.ok) {
      io.writeErr(`a slack bridge is already running for this config (pid ${lock.holder})`);
      io.writeErr(`every channel message would reach Slack twice; stop that bridge or remove ${bridgeLockPath(io)} if it is stale`);
      return 1;
    }
  }
  const { url, token } = resolveConfig(flags, io);
  // Inbound Slack text lands in the channel through the daemon's POST path.
  // Ids this bridge inserted from Slack. The firehose replays them like any
  // other channel message, and publishing one back to Slack is an echo loop.
  const fromSlack = new Set<string>();
  const slack: SlackConfig = {
    ...cfg,
    postToChannel: (channel, from, text) => {
      const id = newMessageId();
      fromSlack.add(id);
      postToChannel(io, url, token, channel, from, text, id);
    },
  };
  slack.dryRun = dryRun;
  try {
    const transport = io.createTransport(slack);
    const bridge = createBridge(slack, transport);
    if (dryRun) {
      // Never connect: prove the config maps to actionable Slack calls.
      printBridgeSummary(slack, url, io);
      return 0;
    }
    bridge.connect();
    // Open the firehose at the CURRENT tip, never at 0: a reconnect that starts
    // from 0 republishes the whole channel to Slack (observed live 2026-08-21,
    // older lines re-posted at ts ...305 and ...325). `since` advances past
    // every message seen, so a reconnect resumes instead of replaying.
    let since = await firehoseTip(io, url, token);
    let backoff = 100;
    let staying = true;
    while (staying) {
      let res: Response;
      try {
        res = await io.fetch(`${url}/stream?since=${since}`, { headers: authHeader(token) });
      } catch {
        await io.sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
        continue;
      }
      if (res.status !== 200 || res.body === null) {
        await io.sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
        continue;
      }
      try {
        await feedFirehose(io, res, (m) => {
          since = Math.max(since, m.seq);
          if (fromSlack.has(m.id)) return; // our own Slack-origin insert
          bridge.publish(m);
        });
        staying = false; // the daemon closed the stream: a clean stop
      } catch {
        await io.sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      }
    }
    return 0;
  } catch {
    io.writeErr("slack bridge failed to start");
    return 1;
  }
}

/** Print the dry-run plan to stderr: the wired channel mappings and identity
 *  tiers the bridge would act on, so an operator verifies the config before
 *  going live with no network connection involved. */
function printBridgeSummary(cfg: SlackConfig, base: string, io: Io): void {
  io.writeErr(`slack dry-run for ${base}`);
  for (const [channel, ch] of Object.entries(cfg.channels)) {
    io.writeErr(`  channel ${channel} -> slack ${ch}`);
  }
  for (const [name, agent] of Object.entries(cfg.agents)) {
    const tier = agent.token ? "real bot-user" : "persona";
    const icon = agent.icon ? ` icon=${agent.icon}` : "";
    io.writeErr(`  ${name}: ${tier}${icon}`);
  }
  if (cfg.dmChannels !== undefined) {
    for (const [ch, agent] of Object.entries(cfg.dmChannels)) {
      io.writeErr(`  DM channel ${ch} -> ${agent}`);
    }
  }
  if (cfg.dmMirrorChannel) io.writeErr(`  DM mirror -> ${cfg.dmMirrorChannel}`);
  io.writeErr(`dry-run OK: no transport was connected`);
}

/** Which backend this run uses: the local daemon (the default, so nothing
 *  currently working changes), the raft backend, or the slack backend. Selected
 *  by the `--backend <name>` flag (highest precedence) or `SCRAMBLE_BACKEND`.
 *  An unknown flag value is treated as raft (a toggle, matching the pre-slack
 *  contract); `SCRAMBLE_BACKEND` likewise picks local/raft/slack and defaults
 *  to local. */
export function selectBackend(argv: string[], io: Io): "local" | "raft" | "slack" {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--backend") {
      const v = argv[i + 1];
      return v === "slack" ? "slack" : v === "local" ? "local" : "raft";
    }
    if (a.startsWith("--backend=")) {
      const v = a.slice("--backend=".length);
      return v === "slack" ? "slack" : v === "local" ? "local" : "raft";
    }
  }
  const env = io.env("SCRAMBLE_BACKEND");
  if (env === "local") return "local";
  if (env === "slack") return "slack";
  return env === "raft" ? "raft" : "local";
}

/** Build the raft backend with the injected run seam (io.run) so tests need no
 *  raft binary. `--max-polls` bounds a listen loop for test termination. */
function raftBackend(flags: Map<string, string>, io: Io): RaftBackend {
  const profile = flags.get("profile") ?? io.env("RAFT_PROFILE");
  const maxPolls = intFlag(flags, "max-polls", Number.POSITIVE_INFINITY);
  return new RaftBackend({ run: io.run!, profile, maxPolls });
}

async function raftCmdNext(argv: string[], io: Io): Promise<number> {
  const { flags } = parseArgs(argv);
  const name = nameFor(flags, io);
  const timeoutSec = intFlag(flags, "timeout", 300);
  const status = statusTracker(io, "raft");
  void status?.clearExpired();
  const r = await raftBackend(flags, io).next(name, timeoutSec);
  for (const p of r.problems) io.writeErr(`raft: ${p}`);
  if (r.code === 64) return 64;
  if (r.line !== undefined) {
    if (status !== undefined) deliverStatus(status, r.line, name);
    io.write(JSON.stringify(r.line));
  }
  return 0;
}

async function raftCmdListen(argv: string[], io: Io): Promise<number> {
  const { flags } = parseArgs(argv);
  const name = nameFor(flags, io);
  const b = raftBackend(flags, io);
  const status = statusTracker(io, "raft");
  const stopTicker = status ? status.startExpiryTicker(2000, io.sleep) : undefined;
  try {
    await b.listen(
      name,
      (d) => {
        if (status !== undefined) deliverStatus(status, d, name);
        io.write(JSON.stringify(d));
      },
      (p) => io.writeErr(`raft: ${p}`),
    );
  } finally {
    stopTicker?.();
  }
  return 0;
}

/** Build the slack BACKEND with the io seams. The config is the bridge config
 *  (loadSlackConfig), and every outbound call/socket goes through io.fetch and
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
      botIds: cfg.botIds ?? [],
    },
    { fetch: io.fetch, createSocket: io.createSocket, sleep: io.sleep },
  );
  return { backend };
}

/** Supply a real clock for the status tracker (a named function so coverage
 *  tracks it; the manager invokes it on every status lifecycle operation). */
function statusNow(): number {
  return Date.now();
}

/** Build the status tracker for a run, or undefined when the operator disabled
 *  it (the one `SCRAMBLE_STATUS=off` switch). The Slack-mode tracker rides on
 *  the slack config's token and channel mapping; any other backend records the
 *  status locally so a reader (or a test) sees it. A missing or broken slack
 *  config yields a local-style record, because a status can never fail the verb
 *  it brackets. */
function statusTracker(io: Io, backend: "local" | "raft" | "slack"): StatusManager | undefined {
  if (io.env("SCRAMBLE_STATUS") === "off") return undefined;
  const raw = Number(io.env("SCRAMBLE_STATUS_TTL"));
  const ttlMs = Number.isFinite(raw) && raw > 0 ? raw * 1000 : 120_000;
  const mode: "local" | "slack" = backend === "slack" ? "slack" : "local";
  let channels: Record<string, string> | undefined;
  let token: string | undefined;
  if (mode === "slack") {
    const cfg = loadSlackConfig(io);
    if (cfg) {
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
 *  is addressed to this agent. A message a channel that will stay silent must
 *  not show the agent working, so an unaddressed line sets nothing. The status
 *  fire-and-forgets ahead of the stdout write; a failure is reported by the
 *  manager, never escalated. Callers guard with a non-null status. */
function deliverStatus(status: StatusManager, m: { channel?: unknown; mentioned?: unknown }, agent: string): void {
  if (m.mentioned !== true) return;
  if (typeof m.channel !== "string") return;
  void status.setOn(m.channel, agent);
}

/** A reply by the agent clears the channel's active status as part of the same
 *  call. Fire-and-forget like the delivery hook: a failure never fails the post.
 *  Callers guard with a non-null status. */
function replyStatus(status: StatusManager, channel: string, agent: string): void {
  void status.clearOn(channel, agent);
}

async function slackCmdNext(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const name = nameFor(flags, io);
  const timeoutSec = intFlag(flags, "timeout", 300);
  const s = slackBackend(io);
  if (s.error !== undefined || s.backend === undefined) {
    io.writeErr(s.error ?? "slack unavailable");
    return 1;
  }
  const r = await s.backend.next(positionals, name, timeoutSec, (p) => io.writeErr(`slack: ${p}`));
  if (r.code === 64) return 64;
  if (r.line !== undefined) {
    const status = statusTracker(io, "slack");
    void status?.clearExpired();
    if (status !== undefined) deliverStatus(status, r.line, name);
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
    await s.backend.listen(
      positionals,
      name,
      (d) => {
        if (status !== undefined) deliverStatus(status, d, name);
        io.write(JSON.stringify(d));
      },
      (p) => io.writeErr(`slack: ${p}`),
    );
  } finally {
    stopTicker?.();
  }
  return 0;
}

/** Local-backend `message check`: drain the agent's pending messages and
 *  advance the client-side cursor. Slightly non-blocking: fetch the pending
 *  list, print one JSON line per message, record the highest seq in
 *  `.scramble/cursor.json`, exit 0. Nothing pending prints nothing and exits 0. */
async function messageCheckLocal(flags: Map<string, string>, io: Io): Promise<number> {
  const name = nameFor(flags, io);
  const status = statusTracker(io, "local");
  void status?.clearExpired();
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
    if (status !== undefined) deliverStatus(status, d, name);
    io.write(JSON.stringify(d));
  }
  if (deliveries.length) {
    const highest = Math.max(...deliveries.map((d) => d.seq));
    writeCursor(io, name, highest);
  }
  return 0;
}

/** raft-backend `message check`: raft tracks the per-agent cursor server-side,
 *  so the drain is `raft message check` verbatim, one Delivery per line. */
async function messageCheckRaft(flags: Map<string, string>, io: Io): Promise<number> {
  const name = nameFor(flags, io);
  const status = statusTracker(io, "raft");
  void status?.clearExpired();
  const b = raftBackend(flags, io);
  const d = await b.drain(name);
  for (const p of d.problems) io.writeErr(`raft: ${p}`);
  for (const m of d.deliveries) {
    if (status !== undefined) deliverStatus(status, m, name);
    io.write(JSON.stringify(m));
  }
  return 0;
}

/** Slack-backend `message check`: Slack is a live stream with no server-held
 *  inbox backlog and no per-agent cursor, so the drain is the quiet case:
 *  nothing is pending, so print nothing and exit 0. The backend switch (config
 *  + socket seam) is still validated so a broken slack config is REPORTED. */
async function messageCheckSlack(flags: Map<string, string>, io: Io): Promise<number> {
  const s = slackBackend(io);
  if (s.error !== undefined || s.backend === undefined) {
    io.writeErr(s.error ?? "slack unavailable");
    return 1;
  }
  return 0;
}

async function cmdMessageCheck(argv: string[], io: Io, backend: "local" | "raft" | "slack"): Promise<number> {
  const { flags } = parseArgs(argv);
  if (backend === "raft") return messageCheckRaft(flags, io);
  if (backend === "slack") return messageCheckSlack(flags, io);
  return messageCheckLocal(flags, io);
}

/** The mirrored `message` family: `send`, `check`, `read`. Each dispatches to
 *  the selected backend below the verb parsing, and reports an unknown verb. */
async function cmdMessage(args: string[], io: Io, backend: "local" | "raft" | "slack"): Promise<number> {
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
      return postText(req.channel, text, flags, io, backend);
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
      io.writeErr("profile update requires --description <text>");
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

export async function main(argv: string[], io: Io): Promise<number> {
  const backend: "local" | "raft" | "slack" = selectBackend(argv, io);
  // Every scramble invocation clears whatever has expired before its own work,
  // whatever verb it is. SCRAMBLE_STATUS=off makes this a no-op.
  void statusTracker(io, backend)?.clearExpired();
  switch (argv[0]) {
    case "post":
      return cmdPost(argv.slice(1), io);
    case "listen":
      if (backend === "raft") return raftCmdListen(argv.slice(1), io);
      if (backend === "slack") return slackCmdListen(argv.slice(1), io);
      return cmdListen(argv.slice(1), io);
    case "next":
      if (backend === "raft") return raftCmdNext(argv.slice(1), io);
      if (backend === "slack") return slackCmdNext(argv.slice(1), io);
      return cmdNext(argv.slice(1), io);
    case "history":
      return cmdHistory(argv.slice(1), io);
    case "message":
      return cmdMessage(argv.slice(1), io, backend);
    case "profile":
      return cmdProfile(argv.slice(1), io);
    case "channel":
      return cmdChannel(argv.slice(1), io);
    case "join":
      return cmdJoin(argv.slice(1), io);
    case "serve":
      return cmdServe(argv.slice(1), io);
    case "slack":
      return cmdSlack(argv.slice(1), io);
    default:
      io.writeErr(`unknown command: ${argv[0] ?? "(none)"}`);
      return 1;
  }
}