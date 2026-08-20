// src/cli.ts — the agent-facing CLI. Every command prints ONE JSON line per
// message to stdout and sends all diagnostics to stderr. All IO flows through
// the injected `io` seams so tests drive main() with a fake io and the
// in-process handler from src/server.ts as fetch — no child process, no
// socket, no real delay. Process argv and the real daemon bind live in
// src/bin.ts, which no test imports.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createStore, type RoomStore } from "./store";
import type { Message, PostResult } from "./types";
import type { ServeOptions } from "./server";

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
  serve(store: RoomStore, opts: ServeOptions): Promise<number>;
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

/** A message rendered for THIS agent: an agent-scoped Delivery already carries
 *  `mentioned`; a room-scoped Message gets it stamped from its mentions list. */
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
  const room = positionals[0];
  const text = positionals.slice(1).join(" ");
  if (room === undefined || !text) {
    io.writeErr("usage: scramble post <room> <text> [--as <name>]");
    return 1;
  }
  const { url, token } = resolveConfig(flags, io);
  const from = nameFor(flags, io);
  const res = await io.fetch(`${url}/rooms/${encodeURIComponent(room)}`, {
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

function streamUrls(base: string, name: string, rooms: string[], since: number): string[] {
  if (rooms.length) {
    return rooms.map(
      (r) =>
        `${base}/rooms/${encodeURIComponent(r)}/stream?since=${since}&exclude=${encodeURIComponent(name)}`,
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
  onLine: (msg: { seq: number }) => void,
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
        await drainStream(res, agentStream, name, (m) => onLine(m as unknown as { seq: number }));
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
  const rooms = positionals;
  const agentStream = rooms.length === 0;
  let lastSeq = 0;
  let backoff = 100;
  let staying = true;
  while (staying) {
    const stop = await listenOnce(
      io,
      streamUrls(url, name, rooms, lastSeq),
      agentStream,
      name,
      token,
      (m) => {
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
  return 0;
}

async function cmdNext(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const name = nameFor(flags, io);
  const { url, token } = resolveConfig(flags, io);
  const rooms = positionals;
  const agentStream = rooms.length === 0;
  const timeoutSec = intFlag(flags, "timeout", 300);
  const deadline = Date.now() + timeoutSec * 1000;
  const urls = streamUrls(url, name, rooms, 0);
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
      if (found) {
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
  const room = positionals[0];
  if (room === undefined) {
    io.writeErr("history requires a room");
    return 1;
  }
  const { url, token } = resolveConfig(flags, io);
  const since = intFlag(flags, "since", 0);
  const res = await io.fetch(`${url}/rooms/${encodeURIComponent(room)}?since=${since}`, {
    headers: authHeader(token),
  });
  if (!res.ok) {
    io.writeErr(`history failed (${res.status})`);
    return 1;
  }
  const msgs = (await res.json()) as Array<Record<string, unknown>>;
  for (const m of msgs) io.write(JSON.stringify(m));
  return 0;
}

async function cmdJoin(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const room = positionals[0];
  if (room === undefined) {
    io.writeErr("join requires a room");
    return 1;
  }
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
    body: JSON.stringify({ persona, room }),
  });
  if (!res.ok) {
    io.writeErr(`join failed (${res.status})`);
    return 1;
  }
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

export async function main(argv: string[], io: Io): Promise<number> {
  switch (argv[0]) {
    case "post":
      return cmdPost(argv.slice(1), io);
    case "listen":
      return cmdListen(argv.slice(1), io);
    case "next":
      return cmdNext(argv.slice(1), io);
    case "history":
      return cmdHistory(argv.slice(1), io);
    case "join":
      return cmdJoin(argv.slice(1), io);
    case "serve":
      return cmdServe(argv.slice(1), io);
    default:
      io.writeErr(`unknown command: ${argv[0] ?? "(none)"}`);
      return 1;
  }
}