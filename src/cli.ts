// src/cli.ts provides the agent-facing command-line interface. Every command
// prints one JSON line per message to stdout and sends all diagnostics to
// stderr. All I/O flows through the injected `io` seams, so tests drive
// main() with mock I/O and the in-process handler from src/server.ts as fetch,
// with no child process, no socket, and no real delay. Process argv and the
// real daemon binding live in src/bin.ts, which no test imports.
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
import { readerBroadcasts, SlackBackend, unescapeSlack, type SlackBackendConfig } from "./slack-backend";
import type { SlackSocket } from "./slack-transport";
import {
  downloadFile,
  findLocalRecord,
  guessMime,
  recordLocalUpload,
  uploadToSlack,
  sizeOf,
  type Attachment,
} from "./attachments";
import { StatusManager } from "./status";
import { SCOPE_NAMES, BOT_EVENT_NAMES } from "./app-manifest";
import { CODE_RULES, DATE_RULES, languageRefusal, lengthRefusal, lineOf, lintLanguage, wordCount } from "./language";
import { createHash } from "node:crypto";
import { tierFor, unclassified, type Tier } from "./tier";
import { credentialsPath, firstCredential, freshCliToken } from "./slack-credential";

/**
 *  A draft counts as already sent for ten minutes. This duration covers the retry
 *  an agent makes after reading a warning as a failure, and it is short enough that
 *  saying the same thing again in a later conversation goes through.
 */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/**
 *  Each send limits the number of cited timestamps it checks. A message carrying
 *  an evidence table cites a handful of them, and a cap keeps a long table from
 *  spending twenty API calls after the message has already gone out. The system
 *  prints the timestamps it skips.
 */
const CITED_TS_CAP = 6;

/**
 *  This threshold defines the fraction of content words a draft message may share
 *  with an earlier message sent by the agent to the same channel inside the window.
 *
 *  Measurements on four pairs using this containment score:
 *
 *  a reworded retry of one report 0.833
 *  the identical draft 1.000
 *  two status reports, different runs 0.429
 *  two unrelated messages 0.000
 *
 *  The score 0.81 is the only threshold that separates every labeled pair across
 *  both synthetic and real test cases: the highest pair intended for delivery
 *  measured 0.800, a synthetic retry measured 0.833, and the single confirmed
 *  duplicate measured 0.968. A wider margin above 0.800 fails to capture the 0.833
 *  case, and whether a real message falls in that range remains unconfirmed.
 *  `CALIBRATION` in `src/inbox.ts` stores each labeled pair alongside its
 *  measurer, where a row lacking a timestamp represents an unsent pair.
 *
 *  The system evaluates a short draft across every token against a 0.85 threshold
 *  because the draft contains too few content words for the primary metric. A
 *  confirmed duplicate where two agents sent a line twice 127 seconds apart
 *  contained 6 and 5 content words, so the earlier evaluation never scored that
 *  case during threshold discussions. Measurements across six labeled short pairs:
 *
 *  the real duplicate 0.889 refused
 *  one thing retyped 0.800 sent
 *  two short status reports 0.667 sent
 *  an addendum to a line 0.571 sent
 *  two unrelated one-liners 0.500 sent
 *  two different topics 0.000 sent
 *
 *  Refusing a legitimate second report would train agents to pass `--again` by
 *  reflex, which disables the guard.
 */
const NEAR_DUPLICATE_OVERLAP = { content: 0.81, short: 0.85 };
import {
  chooseText,
  composePrompt,
  citedTimestamps,
  readDocumentTemplate,
  commentRuns,
  renderComment,
  splitSections,
  critiquePrompt,
  readTierBlock,
  mentionsIn,
  readPromptTemplate,
  readRewrites,
  recordRewrite,
  rewriteConfig,
  rewriteWith,
  rewritesPath,
  rewritesReport,
  type RewriteChoice,
} from "./rewrite";
import {
  originOf,
  peersOnOtherCommits,
  peersPath,
  currentPeers,
  peersReport,
  readPeerFile,
  readPeers,
  recordPeer,
  runtimeOf,
  type Origin,
} from "./origin";
import {
  closeAnsweredBefore,
  closeInboxItems,
  closeItemById,
  readSent,
  allWords,
  CALIBRATION,
  closestSaid,
  nearReport,
  pairScore,
  readSentRows,
  recordSent,
  type SentRow,
  sentAlready,
  sentPath,
  inboxPath,
  isAddressed,
  pendingInbox,
  pendingReport,
  readInbox,
  recordInboxItem,
  traceReport,
} from "./inbox";

const DEFAULT_URL = "http://127.0.0.1:7737";
const MAX_BACKOFF = 2000; // ms cap on reconnect delay

export interface Io {
  /**
   *  stdout carries only JSON message lines, with one line per call.
   */
  write(line: string): void;
  /**
   *  The command emits only diagnostics to stderr and writes message lines to
   *  stdout.
   */
  writeErr(line: string): void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  env(name: string): string | undefined;
  cwd(): string;
  /**
   *  The wait is injectable so tests need no real delay.
   */
  sleep(ms: number): Promise<void>;
  /**
   *  The daemon exposes a binding interface, and `src/bin.ts` binds the port.
   */
  serve(store: ChannelStore, opts: ServeOptions): Promise<number>;
  /**
   *  This module provides the socket factory for the Slack backend's Socket Mode
   *  stream. The production implementation uses Bun's `WebSocket` in `src/bin.ts`.
   *  Tests inject a fake socket so `next` and `listen` touch no socket.
   */
  createSocket?(url: string): SlackSocket;
  /**
   *  The command reads all of standard input as the message body for the mirror
   *  `message send`. The production read logic resides in src/bin.ts, and tests
   *  inject a fake. When standard input is absent, `message send` reads standard
   *  input as empty and reports it.
   */
  readStdin?(): Promise<string>;
  /**
   *  This path points to the directory where this CLI's source sits, so `version`
   *  can read the COMMIT file an install writes beside it. The runtime value comes
   *  from src/bin.ts. The value is absent under test, which reads as a checkout.
   */
  moduleDir?(): string;
  /**
   *  This value sets this machine's hostname for the origin an agent publishes on
   *  its messages. It provides a seam so a test is deterministic, and its absence
   *  means this build publishes no origin at all.
   */
  hostname?(): string;
  /**
   *  The system tracks every environment variable name provided to this process so
   *  that it can report misspelled overrides. Because `io.env` inspects one name at
   *  a time, it never detects a variable that nothing queries. If a variable is
   *  absent, the check stays quiet.
   */
  envNames?(): string[];
}

/**
 *  This section lists every `SCRAMBLE_` name that this code reads. Any name
 *  outside this list is a typo or a leftover, and the system previously ignored
 *  such names in silence.
 *
 *  An agent pointed a check at a copy of a file with `SCRAMBLE_CONFIG`. Because
 *  nothing reads that name, the command read the production file and answered
 *  `damaged: 0`, which was true of the file it read. The agent nearly filed a bug
 *  saying that the field did not work, and reading `slackConfigPath` stopped them.
 *  An override that misses reads exactly like a clean result.
 */
export const KNOWN_ENV = [
  "SCRAMBLE_BACKEND",
  "SCRAMBLE_BIN",
  "SCRAMBLE_BUN",
  "SCRAMBLE_HOME",
  "SCRAMBLE_PROC",
  "SCRAMBLE_REWRITE_KEY",
  "SCRAMBLE_REWRITE_MODEL",
  "SCRAMBLE_REWRITE_PROVIDER",
  "SCRAMBLE_REWRITE_TIMEOUT_MS",
  "SCRAMBLE_REWRITE_URL",
  "SCRAMBLE_RUNTIME",
  "SCRAMBLE_RUNTIME_PID",
  "SCRAMBLE_RUNTIME_VERSION",
  "SCRAMBLE_SESSION_ID",
  "SCRAMBLE_SLACK_CONFIG",
  "SCRAMBLE_STATUS",
  "SCRAMBLE_STATUS_TTL",
  "SCRAMBLE_TOKEN",
  "SCRAMBLE_URL",
];

/**
 *  The build prints this line for any `SCRAMBLE_` name it does not read, along
 *  with the nearest name it reads. This line is empty when every name is known.
 */
export function unknownEnvNote(names: string[], known: string[] = KNOWN_ENV): string {
  const unknown = names.filter((n) => n.startsWith("SCRAMBLE_") && !known.includes(n)).sort();
  if (unknown.length === 0) return "";
  const nearest = (name: string): string => {
    // The known name that shares the longest prefix catches a dropped or added word,
    // as with SCRAMBLE_CONFIG against SCRAMBLE_SLACK_CONFIG, and SCRAMBLE_KEY against
    // SCRAMBLE_REWRITE_KEY.
    const shared = (a: string): number => {
      let i = 0;
      while (i < a.length && i < name.length && a[i] === name[i]) i += 1;
      return i;
    };
    const tail = name.slice("SCRAMBLE_".length);
    const byTail = known.filter((k) => k.endsWith(`_${tail}`) || k === `SCRAMBLE_${tail}`);
    const pick = byTail[0] ?? [...known].sort((a, b) => shared(b) - shared(a))[0];
    return pick ?? "";
  };
  return unknown
    .map((n) => `env: ${n} is set and this build reads no such name. Did you mean ${nearest(n)}?`)
    .join("\n");
}

/**
 *  The CLI parses the `--bind` string as the single interpretation site. It
 *  converts a `--bind` value formatted as `"host:port"`, `"port"`, or `"host"` into
 *  typed hostname and port fields that `serve()` consumes. The CLI reports any
 *  malformed value and never falls back to a silent default.
 */
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
  // A value without a colon specifies either a bare port containing all digits or a
  // bare hostname.
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

/**
 *  These flags take no value. Without this list, the parser treats the next word
 *  as the flag's value, so `lint --comments a.ts b.ts` silently linted only b.ts
 *  because the first requested file became the value of `--comments`. Every
 *  valueless flag followed by a positional argument behaves this way.
 */
const BOOLEAN_FLAGS = new Set([
  "again",
  "comments",
  "document",
  "once",
  "calibrate",
  "dates",
  "json",
  "near",
  // This command does not include `--why`. The `inbox close --why <text>` command
  // takes the reason it stores on every row, and `scramble rewrite --why` reads its
  // own argv, so both work.
  "verify",
  "no-verify",
  "same-dir",
  "addressed",
  "top-level",
  "print-manifest",
]);

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
      if (next !== undefined && !next.startsWith("--") && !BOOLEAN_FLAGS.has(a.slice(2))) {
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

/**
 *  Configuration resolution follows this order of precedence: the `--url` and
 *  `--token` flags override environment variables, environment variables override
 *  the workspace `config.json` file, and the `config.json` file overrides the
 *  `localhost` default.
 */
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

/**
 *  The `--target` flag accepts a channel name without a leading '#'. A channel
 *  may contain '/' (which is how `dm/<a>/<b>` works), so a sigil would be
 *  ambiguous. The command rejects a target that starts with '#' and provides the
 *  reason, and it reports a missing `--target` with what the caller saw.
 */
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

/**
 *  The store does not keep a per-agent delivery cursor, so the client maintains
 *  this state in `.scramble/cursor.json` for `message check`, keyed by agent name.
 *  The client reads the cursor on entry and advances it on exit to the highest
 *  sequence number drained. An absent file or an absent key reads as 0.
 */
const CURSOR_FILE = "cursor.json";

/**
 *  The system stores the drain cursor based on the active backend.
 *
 *  The Slack backend places the cursor beside the configuration file, because the
 *  cursor belongs to the agent across all invocation directories. When keyed by
 *  the current working directory, the same agent sweeping from two locations
 *  produces two cursors and re-drains whole channels. Moving a sweep monitor onto
 *  the installed CLI changed its working directory, and the next sweep re-delivered
 *  the entire history of two channels, spanning hundreds of lines, until the
 *  harness suppressed it for rate.
 *
 *  The local backend keeps its working-directory-relative file, since a local
 *  daemon maintains its store per workspace. When the configuration-side file is
 *  absent and a working-directory file exists, the system reads the
 *  working-directory file, so an existing agent does not re-drain once on upgrade.
 */
function cursorPath(io: Io, agent: string, forWrite = false): string {
  // Each agent uses its own file, matching the structure of the inbox ledger. A
  // single shared file beside the configuration appeared acceptable because the
  // keys inside it are partitioned per agent, but it is not: the peer agent read
  // the previous version and identified an omitted step. The first agent that
  // sweeps from a fresh working directory creates the shared file. From that
  // moment, every other agent on the host resolves to that file, finds no key of
  // its own, reads 0, and re-drains the full history. This creates the same
  // flood one step later, once per agent. A shared file also subjects two sweeps
  // to a read-modify-write race over each other's cursors.
  const mine = join(dirname(slackConfigPath(io)), "cursors", `${agent}.json`);
  if (existsSync(mine)) return mine;
  // During migration, the copy in the current working directory is read-only. The
  // agent used this copy previously, so the agent reads it while no per-agent file
  // exists yet. The agent writes to the per-agent path regardless, which ends the
  // coupling. Returning the current working directory path for writes would keep
  // every existing agent on a cursor keyed by the current working directory
  // forever, and the defect was that the current working directory is not a
  // property of the agent.
  const local = join(io.cwd(), ".scramble", CURSOR_FILE);
  return forWrite ? mine : existsSync(local) ? local : mine;
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
  const p = cursorPath(io, name, true);
  let j: Record<string, number> = {};
  try {
    // The agent reads from the file where the values exist. On a first write after
    // migration, the old file still holds these values. Reading from the absent new
    // file would drop every cursor this agent already had and re-drain everything
    // exactly once.
    j = JSON.parse(readFileSync(cursorPath(io, name), "utf8")) as Record<string, number>;
  } catch {
    /**
     *  An absent cursor file is a fresh ledger.
     */
  }
  j[name] = seq;
  // The system used the directory of the file being written. This made the current
  // working directory `.scramble` whatever path `p` resolved to, so on a host where
  // the cursor lives beside the config, the write would fail for a directory that
  // does not exist yet.
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(j));
}

/**
 *  When rendering a message for this agent, an agent-scoped delivery already
 *  carries `mentioned`, and a channel-scoped message stamps `mentioned` from its
 *  mentions list.
 */
function render(agentStream: boolean, name: string, m: Message & { mentioned?: boolean }): Record<string, unknown> {
  if (agentStream) return m as unknown as Record<string, unknown>;
  return { ...m, mentioned: m.mentions.includes(name) };
}

/**
 *  The parser reads an NDJSON stream and emits one hook per line until the stream
 *  ends.
 */
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

/**
 *  The local backend posts one message through the daemon. It outputs one JSON line
 *  for each crossing, and emits nothing on a clean send with no crossing. When the
 *  operator passes `files` using `--attach`, the client includes them in the POST
 *  body so the stored message carries them.
 */
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

/**
 *  The command uploads every `--attach` file to the target and attaches the
 *  message text to the first file, which causes Slack to attach the file to the
 *  message.
 *
 *  The response matches the structure returned by `post`, so the send path treats
 *  an attachment send and a plain send the same way from this point forward.
 */
async function uploadAsMessage(
  paths: string[],
  channel: string,
  text: string,
  flags: Map<string, string>,
  io: Io,
  backend: "local" | "slack",
  as: string,
  thread?: string,
): Promise<{ ok: true; ts?: string; thread?: string; problem?: string; files?: Attachment[] } | { ok: false; error: string }> {
  let files: Attachment[] | undefined;
  let ts: string | undefined;
  for (const path of paths) {
    const up = await attachmentUpload(
      path,
      channel,
      flags.get("mime-type"),
      io,
      backend,
      as,
      files === undefined ? text : undefined,
      thread,
    );
    if (!up.ok) return { ok: false, error: up.error };
    files = files ?? [];
    files.push({ id: up.id, name: basename(path), mime: guessMime(path), size: sizeOf(path), path });
    if (ts === undefined) ts = up.ts;
  }
  return {
    ok: true,
    ...(ts === undefined ? {} : { ts }),
    ...(thread === undefined ? {} : { thread }),
    ...(files === undefined ? {} : { files }),
  };
}

/**
 *  This command posts one message to whichever backend the run selects. Both the
 *  `message send` verb and the `post <channel> <text>` alias share this path, so
 *  the backend switch sits below verb parsing. When `message send --attach`
 *  produces files, `files` travels with the local store's message. The Slack
 *  backend attaches files through its own upload workflow, which uploads files to
 *  the target before sending the message text.
 */
/**
 *  The operator sets the register a channel calls for.
 *
 *  The operator manually classifies each channel. The system previously determined
 *  this from membership by counting people against agents. A channel with no entry
 *  gets the careful register and a line naming the command that sets one.
 */
function channelTier(channel: string, io: Io): { tier: Tier; why: string } {
  return tierFor(channel, loadSlackConfig(io)?.tiers);
}

/**
 *  The system runs the rewrite attempt with one retry. It tests the model's
 *  answer against the guards and queries the model again with what it broke.
 *
 *  `postText` calls this process on the way to Slack, and `scramble rewrite` calls
 *  it with nowhere to send, so the preview an author reads uses the same code path
 *  their message takes. A preview built from a second copy of these steps would
 *  drift away from the send and misrepresent the output.
 */
/**
 *  The system supplies instructions to the model without the author's draft.
 *
 *  Rewrites intentionally share long spans with the draft, so the evaluation
 *  excludes the draft when checking the answer. Only the instructions remain, and
 *  an answer that repeats spans from them quotes those instructions into the
 *  channel.
 */
function instructionOf(template: string, register?: string): string {
  return register === undefined || register === "" ? template : `${template}\n\n${register}`;
}

async function attemptRewrite(
  text: string,
  io: Io,
  register?: string,
): Promise<{ chosen: RewriteChoice; retried: boolean; retriedWhy?: string; configured: boolean }> {
  const cfg = rewriteConfig(io.env);
  const template = cfg.key === undefined ? undefined : readPromptTemplate(io.moduleDir ? io.moduleDir() : "src");
  // The system retries an unanswered call once. During a measured send, the
  // model timed out at 20s, the send refused, and the same text went through on
  // the next attempt seconds later. A timeout says nothing about the message,
  // so spending the whole send on one slow call is the wrong price.
  const ask = async (prompt: string): Promise<{ ok: true; text: string } | { ok: false; why: string }> => {
    const first = await rewriteWith(io.fetch, cfg, prompt);
    if (first.ok) return first;
    io.writeErr(`rewrite: the model did not answer (${first.why}). Asking once more.`);
    return rewriteWith(io.fetch, cfg, prompt);
  };
  let chosen: RewriteChoice =
    template === undefined
      ? { send: text, note: "" }
      : template.ok
        ? chooseText(text, await ask(composePrompt(template.text, text, register)), instructionOf(template.text, register))
        : chooseText(text, { ok: false, why: template.why });
  // This attempt documents the resulting failures. Every guard fires on an action
  // the model took, so the model can resolve the issue, while the author receives a
  // refusal for an error produced elsewhere. Two agents deliberately wrote prose
  // that avoided a banned form, observed the rewriter restore it, and sent nothing.
  if ("refuse" in chosen && chosen.retry !== undefined && template !== undefined && template.ok) {
    const why = guardName(chosen.why);
    io.writeErr(`rewrite: ${chosen.retry} Asking once more.`);
    return {
      chosen: chooseText(
        text,
        await ask(`${composePrompt(template.text, text, register)}\n\n${chosen.retry}`),
        `${instructionOf(template.text, register)}\n\n${chosen.retry}`,
      ),
      retried: true,
      retriedWhy: why,
      configured: true,
    };
  }
  return { chosen, retried: false, configured: template !== undefined };
}

/**
 *  This command posts one message to whichever backend the run selects. Both the
 *  `message send` verb and the `post <channel> <text>` alias share this path, so
 *  the backend switch sits below verb parsing. When `message send --attach`
 *  produces files, `files` travels with the local store's message. The Slack
 *  backend attaches files through its own upload workflow, which uploads files to
 *  the target before sending the message text.
 */
async function postText(
  channel: string,
  text: string,
  flags: Map<string, string>,
  io: Io,
  backend: "local" | "slack",
  files?: Attachment[],
  attachPaths: string[] = [],
): Promise<number> {
  // Every action that displays this agent's prose to a person passes through this
  // point. The language check runs here, so `post` cannot bypass the rules that
  // `message send` enforces. The `message send` command executes this same check
  // earlier, before it uploads an attachment, so a refused message does not leave a
  // file in the channel without an accompanying message.
  //
  // The system preserves the original text the author typed before the rewriter
  // replaces it. The duplicate check hashes this text, since a single draft
  // rewrites differently on every run.
  const draft = text;
  const postRefusal = languageRefusal(lintLanguage(text));
  if (postRefusal !== "") {
    io.writeErr(postRefusal);
    return 1;
  }
  // The system refuses duplicate submissions of the same draft to the same channel,
  // and this check runs before the rewriter. In a measurement taken after the
  // `posted:` line shipped, two byte-identical copies reached a third agent's inbox
  // 27 seconds apart. A retry after a genuine post must become a no-op, so the
  // system sets an idempotency key on the draft hash.
  //
  // The system hashes the draft because a single draft rewrites differently on each
  // run, so a digest of the final posted text would permit duplicate deliveries.
  // The `--again` flag sends the draft anyway when the sender intends to post the
  // same content twice.
  const sender = nameFor(flags, io);
  const digest = createHash("sha256").update(draft).digest("hex").slice(0, 16);
  // This send measured and recorded whether or not it crossed the threshold, so
  // the distribution accumulates in the field. The number this guard uses rests on
  // corpus runs three agents did by hand.
  let closest: { row: SentRow; overlap: number; scale: "content" | "short" } | undefined;
  // The system measures every send, including sends with `--again`. Recording only
  // outbound messages captures the negative class alone, because every row is a
  // message the author intended to send. The `--again` re-sends are the labeled
  // false positives, which is the class that indicates where the threshold is
  // incorrect, and an agent identified this gap the hour the system shipped.
  closest = closestSaid(
    readSentRows(sentPath(slackConfigPath(io), sender)),
    channel,
    allWords(draft),
    Date.now(),
    DUPLICATE_WINDOW_MS,
  );
  if (!flags.has("again")) {
    const already = sentAlready(
      readSentRows(sentPath(slackConfigPath(io), sender)),
      channel,
      digest,
      Date.now(),
      DUPLICATE_WINDOW_MS,
    );
    if (already !== undefined) {
      io.writeErr(
        `message send REFUSED: you already sent this exact draft to ${channel} at ts ${already.ts} ` +
          `(${already.at}). Slack has that copy, so this would be a second one. Pass --again to send it ` +
          `twice on purpose.`,
      );
      return 1;
    }
    // The digest misses duplicate content when different wording describes the same
    // event. An agent reported one end-to-end run twice, 127 seconds apart, naming the
    // same ports and the same three images in different sentences. The text carried a
    // 0.970 word overlap by measurement, and the digest passed it because no two
    // bytes lined up. A reader of the channel still receives two reports for one run
    // either way.
    const said =
      closest !== undefined &&
      closest.overlap >= (closest.scale === "short" ? NEAR_DUPLICATE_OVERLAP.short : NEAR_DUPLICATE_OVERLAP.content)
        ? closest
        : undefined;
    if (said !== undefined) {
      io.writeErr(
        `message send REFUSED: this says what you already sent to ${channel} at ts ${said.row.ts} ` +
          `(${said.row.at}), sharing ${(said.overlap * 100).toFixed(0)}% of its content words. Slack has ` +
          `that copy. Read it, and pass --again if this adds something it lacks.`,
      );
      return 1;
    }
  }
  // A configured model rewrites outgoing messages. For every sentence processed
  // through the scramble message routine, Gemini 3.7 Flash rewrites the text to
  // meet professional product and technical communication standards.
  //
  // A rewriter can change what a claim says. An agent that already publishes
  // incorrect claims gains no new failure mode from this, so the argument reduces
  // to the fact that rewriting does not fix that problem.
  //
  // The message always transmits. A missing key, a timeout, or a bad response costs
  // the rewrite. Nothing changes silently: when the system sends a rewrite, it
  // prints the sender's original words beside it. The rewrite must pass the same
  // rules that the sender's words passed, or the system drops the rewrite in favour
  // of the words that passed. The channel determines the register, and the operator
  // classifies the channel manually. The matching block attaches to the instruction
  // the model already receives, and a channel with no tier receives the careful
  // one. The output appears only where the rewrite acts. With no model configured,
  // no rewrite carries a register, and the line would sit ahead of whatever the
  // send reports next, including a failure.
  const rewriteOn = rewriteConfig(io.env).key !== undefined;
  const decided = channelTier(channel, io);
  if (rewriteOn) io.writeErr(`register: ${decided.tier} for ${channel} (${decided.why}).`);
  const registerBlock = rewriteOn
    ? readTierBlock(io.moduleDir ? io.moduleDir() : "src", decided.tier)
    : ({ ok: false, why: "" } as const);
  if (!registerBlock.ok && registerBlock.why !== "") io.writeErr(`register: ${registerBlock.why}`);
  const { chosen, retried, retriedWhy, configured } = await attemptRewrite(
    text,
    io,
    registerBlock.ok ? registerBlock.text : undefined,
  );
  // An unusable rewrite stops the send. The system previously transmitted the
  // author's original words at this point, which published the exact prose that the
  // rewrite exists to replace.
  //
  // The log records one row for each send that encountered the rewriter. Every
  // claim about whether the rewriter helps has been a single remembered case, on a
  // feature that now runs on every send from two hosts.
  const noteRewrite = (outcome: "sent" | "unchanged" | "retried" | "refused" | "skipped", why?: string): void => {
    if (rewriteConfig(io.env).key === undefined) return;
    try {
      recordRewrite(rewritesPath(slackConfigPath(io)), {
        at: new Date().toISOString(),
        agent: nameFor(flags, io),
        channel,
        outcome,
        ...(why === undefined ? {} : { why }),
        words: [wordCount(text), "send" in chosen ? wordCount(chosen.send) : 0],
        // THE DRAFT IS KEPT WHERE THE GUARD FIRED, so a change to the instruction
        // can be replayed against the messages it was written for. See
        // `RewriteRecord.draft`.
        ...(outcome === "refused" || outcome === "retried" ? { draft: text } : {}),
      });
    } catch (e) {
      io.writeErr(`rewrite record not written: ${String(e)}`);
    }
  };
  if ("refuse" in chosen) {
    noteRewrite("refused", guardName(chosen.why));
    io.writeErr(chosen.refuse);
    return 1;
  }
  noteRewrite(
    !configured ? "skipped" : chosen.note === "" ? "unchanged" : retried ? "retried" : "sent",
    retried ? retriedWhy : undefined,
  );
  if (chosen.note !== "") io.writeErr(`rewrite: ${chosen.note}`);
  text = chosen.send;
  const thread = flags.get("thread") ?? undefined;
  const status = statusTracker(io, backend, nameFor(flags, io));
  await settleStatus(status?.clearExpired());
  // Both backends run the upload after the guards and the rewrite. The upload
  // previously ran inside the verb and returned before any of them ran, so a send
  // carrying a file printed nothing, checked no duplicate, and rewrote nothing. One
  // agent posted an identical draft twice, seven seconds apart, and deleted the copy
  // by hand.
  //
  // On Slack, the upload posts the message, since the text travels as the file's
  // comment, so it returns a response in the shape `post` answers and shares
  // everything after it. On the local backend, the upload records the file and the
  // post below carries it.
  const uploaded =
    attachPaths.length > 0
      ? await uploadAsMessage(attachPaths, channel, text, flags, io, backend, nameFor(flags, io), thread)
      : undefined;
  if (uploaded !== undefined && !uploaded.ok) {
    io.writeErr(`post failed: ${uploaded.error}`);
    return 1;
  }
  if (uploaded !== undefined && uploaded.ok && uploaded.files !== undefined) files = uploaded.files;
  if (backend === "slack") {
    const from = nameFor(flags, io);
    const s = slackBackend(io);
    if (s.error !== undefined || s.backend === undefined) {
      io.writeErr(s.error ?? "slack backend unavailable");
      return 1;
    }
    // An attachment follows the same path. The `--attach` flag used to upload
    // from the command verb and return before this function ran, so sending a file
    // skipped the duplicate guard, the rewriter, and every line this function prints.
    // An agent posted one draft twice, seven seconds apart, with no output either
    // time, and deleted the copy by hand. The upload posts the message, so it stands
    // where the post call stands, and everything after it is shared.
    const r = uploaded !== undefined ? uploaded : await s.backend.post(channel, text, from, thread);
    if (!r.ok) {
      io.writeErr(`post failed: ${r.error}`);
      return 1;
    }
    // The CLI always states first that Slack received the message, along with the
    // timestamp `ts`, because everything printed after this point is a note about
    // the message, and an agent that reads a note as a failure sends the message
    // again.
    //
    // During measurements taken in the same hour, one agent posted a reply twice
    // after the CLI printed only the unread-messages warning, and another agent
    // posted the same progress report FIVE times because a stale read-back
    // convinced it that nothing had gone out (ts 1787715115 / 1787715130 and
    // 1787715280 through 1787715629). Neither output ever included the word posted.
    io.writeErr(
      `posted: ${channel} at ts ${r.ts ?? "unknown"}${r.thread === undefined ? "" : ` in thread ${r.thread}`}. ` +
        `Slack has it. Anything below is a note about the message, and NONE of it means resend.`,
    );
    // The system marks a post as REPORTED when it arrives at an unintended destination.
    // A clean exit provides no information about where the post went.
    if (r.problem !== undefined) io.writeErr(`slack: ${r.problem}`);
    // The `--verify` flag reads the message back from the channel. A send's exit code
    // indicates that Slack accepted a payload, but it does not report what the channel
    // holds. The rewriter, mention conversion, and Slack's own formatting modify the
    // text between submission and storage. Three agents wrote their own read-back
    // wrappers to verify delivery.
    //
    // When the text differs, the command prints the stored text in full. A line diff
    // fails when the rewriter rephrases throughout, because every line reports as
    // changed. Verification runs by default when rewriting is active. A rewritten send
    // posts text that the author never saw, so the channel contents must be verified
    // for every send, which led three agents to write their own read-back wrappers. An
    // opt-in flag remains effective only until operators are busy, which is why the
    // send command enforces the language rules directly.
    //
    // The `--no-verify` flag skips verification, and `--verify` enables it when the
    // rewriter is disabled.
    const verifying = flags.has("no-verify")
      ? false
      : flags.has("verify") || rewriteConfig(io.env).key !== undefined;
    // Before comparing them, the system puts both sides into a single format: it
    // renders the broadcast entity as a reader sees it, undoes Slack's escapes, and
    // trims the edges.
    const readerForm = (t: string): string => unescapeSlack(readerBroadcasts(t)).trim();
    if (verifying) {
      if (r.ts === undefined) {
        io.writeErr(`verify: slack returned no ts for this message, so nothing can be read back.`);
      } else {
        // Slack hoists a `thread_ts` that names a reply into that reply's root
        // message, and the read-back must query the root that holds the message.
        const stored = await s.backend.storedMessage(channel, r.ts, from, r.thread ?? thread);
        if (!stored.ok) {
          io.writeErr(`verify: could not read the message back: ${stored.error}`);
          // The system compares text in the reader's format on both sides. The
          // read-back
          // renders `<!channel>` as `@channel` and undoes Slack's `&lt;`, so a draft
          // written
          // in either form read back as a difference, and this line printed DIFFERS
          // twice
          // over messages Slack held exactly. Agents learn to skip a verification check
          // that raises false alarms.
        } else if (readerForm(stored.text) === readerForm(text)) {
          // A mention is live when Slack makes an entity of it. A name that fails to
          // convert
          // remains in the text and notifies nobody, so a count taken from the text
          // would
          // have called it live.
          const silent = mentionsIn(text).filter((m) => !stored.mentions.includes(m.slice(1)));
          io.writeErr(
            `verify: ${channel} holds exactly what was sent, ${stored.mentions.length} mention(s) live` +
              (silent.length > 0 ? `, and ${silent.join(", ")} notified NOBODY.` : `.`),
          );
        } else {
          // Both sides compare prose. A raw `includes` finds a mention inside a
          // backtick
          // span, where it notifies nobody. The rewrite guard was built an hour earlier
          // for
          // this exact defect, which was reintroduced here.
          const storedProse = mentionsIn(stored.text);
          const lostHere = mentionsIn(text).filter((m) => !storedProse.includes(m));
          io.writeErr(
            (
              `verify: ${channel} holds text that DIFFERS from what was sent.\n` +
                // The output names the line directly. The previous version printed the
                // full
                // stored text and left the reader to find the difference. A
                // hand-written diff
                // showed that Slack had auto-linked a bare `users.info` into a link
                // entity, and
                // nobody should have to re-derive that.
                differenceLine(readerForm(text), readerForm(stored.text)) +
                `What Slack stored:\n${stored.text}\n` +
                (lostHere.length > 0
                  ? `Mentions that stopped notifying: ${lostHere.join(", ")}\n`
                  : `Every mention survived: ${storedProse.join(", ") || "none"}\n`)
            ),
          );
        }
      }
      // The system reports citations that point to missing records while the sender
      // remains present. An agent cited `1787656658.009669` for a line Slack holds at
      // `1787656658.009699` after hand-copying the value from a notification preview,
      // and the reader spent a search finding what was meant. Four investigations in
      // one day turned on an exact timestamp.
      //
      // The system issues an advisory note and allows the message: the message is
      // already in the channel, and a timestamp from another channel is a legitimate
      // citation this tool cannot check. The detector checks the whole second, which no
      // correct citation trips.
      const cites = citedTimestamps(text).filter((c) => c !== r.ts);
      // The cap reports what it dropped. An unprinted limit appears to provide full
      // coverage, which is how running `tail -1` on a smoke diagnostic hid a failure in
      // this workspace.
      if (cites.length > CITED_TS_CAP) {
        io.writeErr(`cite: checked the first ${CITED_TS_CAP} of ${cites.length} cited ts, and left ${cites.slice(CITED_TS_CAP).join(", ")} unchecked.`);
      }
      for (const cited of cites.slice(0, CITED_TS_CAP)) {
        const look = await s.backend.citedMessage(channel, cited, from);
        if (look.error !== undefined) continue;
        // Verify who wrote the cited message. An operator attributed an incident to the
        // wrong agent while referencing its timestamp, and the named agent corrected
        // the
        // attribution. The same call that checks the timestamp digits reads the author.
        if (look.exact) {
          if (look.author !== undefined) io.writeErr(`cite: ${cited} in ${channel} was written by ${look.author}.`);
          continue;
        }
        if (look.near === undefined) continue;
        io.writeErr(
          `cite: ${channel} holds no message at ${cited}, and it holds ${look.near} in that same second` +
            `${look.author === undefined ? "" : `, written by ${look.author}`}. ` +
            `Check the digits, and read a ts from the delivered line instead of a preview.`,
        );
      }
    }
    await settleSend(io, channel, from, r.ts, thread, {
      hash: digest,
      channel,
      at: new Date().toISOString(),
      // The system retains the words the draft was about, so the next send can see a
      // rewording of it. The digest alone catches a byte-identical resend and nothing
      // else.
      words: allWords(draft),
      ...(closest === undefined
        ? {}
        : {
            near: {
              score: Number(closest.overlap.toFixed(3)),
              ts: closest.row.ts,
              // The override serves as the label. A message sent under `--again` above
              // the
              // threshold is a refusal that the author overruled, which is the only
              // field
              // evidence that the number is too low.
              ...(flags.has("again") ? { again: true } : {}),
            },
          }),
    });
    if (status !== undefined) await settleStatus(replyStatus(status, channel, from));
    // Finally, a pipe cuts from the end. Three agents independently ran this output
    // through `tail -4`, `tail -3` and `tail -2`, each losing the `posted:` line, and
    // two of them sent the message again. The same timestamp, printed at both ends,
    // survives a truncation from either side.
    io.writeErr(`sent: ${channel} at ts ${r.ts ?? "unknown"}. Slack has it. Nothing above asks you to send it again.`);
    return 0;
  }
  const code = await postLocalCore(channel, text, flags, io, files, thread);
  if (code === 0 && status !== undefined)
    await settleStatus(replyStatus(status, channel, nameFor(flags, io)));
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

/**
 *  The client opens every stream at the shared cursor, reads concurrently, and
 *  reports a clean stop.
 */
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
  const addressedOnly = flags.has("addressed");
  // A listener is the longest-lived process an agent runs, so starting the listener
  // records the agent's runtime, directory, and session.
  recordSelf(io, name);
  const drift = watchForNewerInstall(io);
  // ARMING THE LISTENER ARMS THE SWEEP. See `sweepInsideListener`.
  const sweep = sweepInsideListener(io, sweepOnce.bind(null, flags, io, "local"));
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
          emitDelivery(io, name, m as unknown as Record<string, unknown>, addressedOnly);
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
    drift.stop();
    sweep.stop();
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
  await settleStatus(status?.clearExpired());
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
          /**
           *  The system tears down the stream only.
           */
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
        if (status !== undefined) await settleStatus(deliverStatus(status, found.line, name));
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

/**
 *  The local backend reads one JSON line per message from the channel catch-up.
 */
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

/**
 *  The command reads a channel's history under whichever backend the run selects.
 *  The mirrored verb (`message read --target <channel>`) and the alias
 *  (`history <channel>`) share `--since`/`--after` as the same cursor and both
 *  dispatch here, so the backend switch stays below the verb parsing.
 */
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
    // The caller in `src/cli.ts` builds both the status manager (which reads the
    // ledger) and the Slack backend, so it reads the living-status timestamp here and
    // passes it in, which keeps the backend isolated from the ledger location.
    const r = await s.backend.history(channel, since > 0 ? String(since) : undefined, nameFor(flags, io));
    for (const p of r.problems) io.writeErr(`slack: ${p}`);
    if (r.code !== 0) {
      // The request specified one channel by name here, so its refusal is the answer.
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

/**
 *  To join a channel as the current agent, the command scaffolds `.scramble/`,
 *  reads the persona, and registers the agent name, persona, and channel with
 *  the daemon. Both the `join <channel>` alias and the
 *  `channel join --target <channel>` command share this routine.
 */
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
  // A successful join should direct the joining agent to the join procedure and the
  // conversational rules without requiring a search. The system writes this
  // information to stderr, because the CLI contract keeps stdout JSON-only.
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

/**
 *  The system determines the Slack configuration path by checking
 *  `SCRAMBLE_SLACK_CONFIG` first, then `~/.config/scramble/slack.json`, and finally
 *  the workspace copy. The configuration holds bot tokens, so the default path is
 *  deliberately outside the repository: this repository is public-bound, and a
 *  credential in a commit is readable in every clone.
 */
export function slackConfigPath(io: Io): string {
  const explicit = io.env("SCRAMBLE_SLACK_CONFIG");
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const home = io.env("HOME");
  if (home !== undefined && home.length > 0) return join(home, ".config", "scramble", "slack.json");
  return join(io.cwd(), ".scramble", "slack.json");
}

/**
 *  This function loads the Slack backend configuration. The configuration governs
 *  which channels map to which Slack channels, specifies each agent's identity,
 *  and provides the app-level and bot tokens. The function returns null when the
 *  file is absent or malformed, and the caller reports the failure, naming the
 *  path it tried.
 */
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
      // The system carries the register override through. When the loader drops a key,
      // the configuration claims to have that key and the code never sees it.
      ...(typeof j.tiers === "object" && j.tiers !== null && !Array.isArray(j.tiers)
        ? { tiers: j.tiers as Record<string, string> }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 *  This directory receives downloaded Slack attachments and houses the local
 *  ledger. Setting `filesDir` in the config overrides the default location. The
 *  default keeps files outside the public-bound repository, mirroring how the
 *  config keeps tokens out of the tree.
 */
function slackFilesDir(io: Io): string {
  const cfg = loadSlackConfig(io);
  if (cfg !== null && cfg.filesDir !== "") return cfg.filesDir;
  const home = io.env("HOME");
  return home ? join(home, ".config", "scramble", "files") : join(io.cwd(), ".scramble", "files");
}

/**
 *  The builder constructs the Slack backend with the I/O seams. The system reads
 *  configuration from the Slack configuration path, and routes every outbound call
 *  and socket through `io.fetch` and `io.createSocket`, so tests need no token,
 *  network, or socket. The builder returns an error string when the configuration
 *  or seams are missing.
 */
// A single location defines what a scramble agent application must declare. The
// onboarding script generates the manifest from this location, and doctor checks
// a live application against it. A second manual copy previously existed here
// beneath a comment asserting that doctor compared the two versions. Doctor never
// compared them, and the copies had diverged.

/**
 *  This function returns the single line that an agent with a stale configuration
 *  must see. It returns this message for the caller to print, so the caller
 *  decides the output stream. The function returns an empty string when nothing is
 *  wrong.
 */
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


/**
 *  TELL THE AGENT ITS OWN LISTENER HAS GONE STALE.
 *
 *  One launcher serves every agent sharing a HOME, which is the arrangement this
 *  workspace wants so that one version runs per machine and everyone picks up the
 *  same update. The cost is that an install by any agent leaves every running
 *  listener behind, and the affected agent receives no signal. An agent was left
 *  behind twice in one day and learned it only by running doctor.
 *
 *  The install prints the affected agents for the installer to read. The stale
 *  agent reads its own half directly: its listener announces the change on the
 *  stream that the agent already watches, once per change.
 *
 *  The notice rides the delivery stream as a JSON line for the same reason a
 *  delivery does. When written to stderr, this notice reached an agent only when its
 *  launcher merged the streams. One agent's launch line sent stderr to a second file
 *  that its monitor never read, so 58 notices reached nobody, and merging the
 *  streams would have put prose into a file whose reader parses JSON (reported). A
 *  signal whose arrival depends on shell wiring at each host arrives only at some
 *  hosts. Stdout is where the listener already writes the lines the agent reads,
 *  and a JSON envelope survives a parsing reader.
 *
 *  The listener sends this notice every 30 seconds, which is far below the cost of
 *  a message and far above the rate anyone installs.
 */
export function watchForNewerInstall(io: Io): { stop: () => void; tick: () => void } {
  const mine = (io.moduleDir ? readCommitFile(io.moduleDir()) : "") || installedCommit(io);
  let told = "";
  // This implementation uses a real timer. Tests stub `io.sleep` to return
  // instantaneously, so a `while (!stopped) await io.sleep(...)` loop spins at
  // full speed and reads a file on every iteration, which stalled the suite the
  // first time this shipped that way. An interval fires on the clock and nothing
  // else, and unref allows the process to exit while it is pending.
  const tick = (): void => {
    const now = installedCommit(io);
    if (now !== "" && mine !== "" && now !== mine && now !== told) {
      told = now;
      io.write(
        JSON.stringify({
          scramble: "stale-listener",
          running: mine,
          installed: now,
          text:
            `scramble: this listener runs ${mine} and ${now} is installed now, so a change somebody ` +
            `made has NOT reached you. Restart the listener to pick it up.` +
            changeBlock(mine, installedChanges(io)),
        }),
      );
    }
  };
  const timer = setInterval(tick, 30_000);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer), tick };
}

/**
 *  The file records the commit subjects from the last install beside the
 *  installed copy's COMMIT, together with the commit that the install replaced.
 *
 *  The installer is the one agent who does not need this file. One launcher
 *  serves every agent on a HOME, so an install by any agent moves the rest, and
 *  their only notice is a drift advisory carrying two SHAs. An agent read three
 *  `git log` ranges by hand in one day to decide whether a listener of theirs was
 *  running code that mattered, and an installed copy has no checkout to read.
 *
 *  The file covers the most recent install only. A reader further behind than that
 *  hop is told so by the caller, which compares `from` against its own commit.
 */
export function installedChanges(io: Io): { from: string; lines: string[] } | undefined {
  const home = io.env("HOME");
  const root = io.env("SCRAMBLE_HOME") ?? (home === undefined ? "" : join(home, ".local", "share", "scramble"));
  if (root === "") return undefined;
  let raw = "";
  try {
    raw = readFileSync(join(root, "current", "src", "CHANGES"), "utf8");
  } catch {
    return undefined;
  }
  const rows = raw.split("\n").filter((l) => l.trim() !== "");
  const head = rows[0] ?? "";
  if (!head.startsWith("from ")) return undefined;
  return { from: head.slice(5).trim(), lines: rows.slice(1) };
}

/**
 *  The output provides what changed as a printable block for a reader running
 *  `mine`, or returns an empty string when the installed copy records nothing.
 */
export function changeBlock(mine: string, changes: { from: string; lines: string[] } | undefined): string {
  if (changes === undefined || changes.lines.length === 0) return "";
  const partial =
    changes.from === mine
      ? ""
      : ` The list covers the most recent install, which started at ${changes.from}, and you run ${mine}, so there may be more.`;
  // Do not append a period after the list. Each entry here is a complete sentence
  // that ends with a period, and the live advisory read `...installed copy..` on its
  // first run.
  return ` ${changes.lines.length} commit(s) came with it, oldest first: ${changes.lines.join("; ")}${partial}`;
}

/**
 *  The entry stores the commit written beside a copy's source, and remains empty
 *  when there is none.
 */
function readCommitFile(dir: string): string {
  try {
    return readFileSync(join(dir, "COMMIT"), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 *  This value indicates where this process runs, or remains undefined when the
 *  host cannot be read.
 *
 *  An undefined value means this build publishes no origin, which is what an I/O
 *  environment without a hostname interface knows. A guessed host would be worse
 *  than no host, because a peer reading it would believe it.
 */
export function agentOrigin(io: Io, agent?: string): Origin | undefined {
  const host = io.hostname === undefined ? "" : io.hostname();
  if (host === "") return undefined;
  return originOf(host, io.cwd(), installedCommit(io), runtimeOf(io.env), agent);
}

/**
 *  The agent writes its own row so a crash leaves it on disk.
 *
 *  Scramble should store the agent runtime, working directory, and session IDs for
 *  each agent in case of a system restart or crash. Every row in this file came
 *  from a message a peer sent, so the one agent whose runtime and session this
 *  process knows for certain was the one agent missing from it. A host that crashed
 *  took its own record with it, and the agents that recovered the file found
 *  everyone except themselves.
 *
 *  The agent calls this operation on the delivery verbs and on the send, which is
 *  every path an agent runs. The operation is best-effort and reported, so a record
 *  that cannot be written must not fail the work it describes.
 */
export function recordSelf(io: Io, agent: string): void {
  const mine = agentOrigin(io, agent);
  if (mine === undefined || agent === "") return;
  try {
    // The row claims the agent's Slack handle, which the config already holds.
    // Without this claim, a row keyed on the handle waits for the agent to send
    // before it retires, and an agent that upgrades and stays quiet retains two
    // rows. These two identities share one host, one directory, and one session,
    // which appears as two agents to anyone restoring the fleet.
    const handle = loadSlackConfig(io)?.agents[agent]?.handle;
    recordPeer(
      peersPath(slackConfigPath(io)),
      agent,
      handle === undefined || handle === "" ? agent : handle,
      mine,
      new Date().toISOString(),
    );
  } catch (e) {
    io.writeErr(`own origin not recorded: ${String(e)}`);
  }
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
      ...(agentOrigin(io) === undefined ? {} : { origin: agentOrigin(io) }),
    },
    { fetch: io.fetch, createSocket: io.createSocket, sleep: io.sleep },
  );
  return { backend };
}

/**
 *  The status tracker uses a real clock defined as a named function so coverage
 *  tracks it. The manager invokes the clock on every status lifecycle operation.
 */
function statusNow(): number {
  return Date.now();
}

/**
 *  The system builds a status tracker for a run, or returns undefined when the
 *  operator disables tracking with `SCRAMBLE_STATUS=off`. The Slack tracker uses
 *  the token and channel mapping from the Slack configuration. Any other backend
 *  records the status locally so a reader or a test sees it. A missing or broken
 *  Slack configuration yields a local record, because a status can never fail the
 *  operation it brackets.
 */
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
      // The system uses the acting agent's own token. The status is posted into the
      // agent's own channel, and the default app is a different app that is usually not
      // in that channel. Slack returns `channel_not_found`, and a failed status never
      // fails the work it brackets, which means the whole feature is silently dead for
      // every non-default agent. This behavior is what caused assistant statuses to not
      // work at all.
      token = (agent !== undefined ? cfg.agents[agent]?.token : undefined) ?? cfg.token;
    }
  }
  // The system performs live resolution for a channel that the map does not hold.
  // The map is a manually maintained copy of what Slack holds, and this is the
  // fourth place in this repository where that copy went missing or stale. A channel
  // an agent was invited into without a configuration edit resolved to nothing here,
  // while `message send` to the same name worked, since the post path asks Slack.
  // The system builds this lazily so a configuration with no Slack backend pays
  // nothing.
  const resolve =
    mode === "slack" && agent !== undefined
      ? async (channel: string): Promise<string | undefined> => {
          const s = slackBackend(io);
          return s.backend === undefined ? undefined : s.backend.channelIdFor(agent, channel);
        }
      : undefined;
  return new StatusManager({
    ...(resolve === undefined ? {} : { resolve }),
    ...(agent === undefined ? {} : { agent }),
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

/**
 *  A delivery turns status on for its channel if and only if the message is
 *  addressed to this agent. A message on a channel that will stay silent must
 *  not show the agent busy, so an unaddressed line sets nothing. A short-lived
 *  verb potentially awaits the status, which would otherwise exit with the ledger
 *  write in flight. The awaiting caller swallows any failure. Callers guard with
 *  a non-null status.
 */
function deliverStatus(
  status: StatusManager,
  m: { channel?: unknown; mentioned?: unknown; thread?: unknown; ts?: unknown; id?: unknown },
  agent: string,
): Promise<void> {
  if (m.mentioned !== true) return Promise.resolve();
  if (typeof m.channel !== "string") return Promise.resolve();
  // Slack displays status on a thread, so the agent shows its working status on the
  // thread that contains the message. The agent shows this status on the thread root
  // when the message is a reply, and on the message itself when the message is
  // top-level, since answering it starts that thread.
  const thread =
    typeof m.thread === "string" ? m.thread : typeof m.ts === "string" ? m.ts : undefined;
  return status.setOn(m.channel, agent, thread);
}

/**
 *  The agent clears the channel's active status within the same call as its reply.
 *  The call returns so a short-lived verb can await the ledger write before its
 *  process exits, sending the delete operation before `status.json` drops the
 *  record.
 */
function replyStatus(status: StatusManager, channel: string, agent: string): Promise<void> {
  return status.clearOn(channel, agent);
}

/**
 *  Await status calls so that short-lived operations finish the ledger writes
 *  they started, such as setting delivery, clearing replies, or sweeping expiry,
 *  before the process exits.
 *
 *  The manager guarantees that status calls never fail the underlying work. It
 *  reports Slack failures and ledger-write failures on stderr and returns. A
 *  catch handler previously wrapped that promise. Once the manager handled its
 *  own promise, that outer catch became unreachable, creating two guards for
 *  one failure where the outer guard masked regressions in the inner one. A
 *  rejection now terminates the command with an error, which identifies the
 *  component that failed.
 */
async function settleStatus(p: Promise<unknown> | undefined): Promise<void> {
  if (p === undefined) return;
  await p;
}

/**
 *  The caller (`src/cli.ts`) builds both the status manager and the Slack
 *  backend. It reads the status message timestamp for a run from the status ledger
 *  and passes it into a read or delivery operation, so the backend filters a status
 *  line without knowing where the ledger lives. If no status is present, no line is
 *  hidden.
 */

/**
 *  The Slack backend `message check` cursor is a per-channel map of channel names
 *  to their newest Slack timestamps. The system stores this map under a namespaced
 *  key in the same `cursor.json` file so it never collides with the local backend's
 *  agent-keyed integer cursor. Slack has no global sequence, so the resume point it
 *  can support is a conversation timestamp per channel, kept client-side like the
 *  local cursor.
 */
const SLACK_CURSOR_PREFIX = "slack:";
/**
 *  The same file stores the cursor beside the channels that this agent was outside
 *  of during the last sweep, and the same reader reads them.
 */
const SLACK_SKIPPED_PREFIX = "slack-skipped:";

function readSlackState(io: Io, name: string): { cursor: Record<string, string>; skipped: string[] } {
  try {
    const j = JSON.parse(readFileSync(cursorPath(io, name), "utf8")) as Record<string, unknown>;
    const v = j[`${SLACK_CURSOR_PREFIX}${name}`];
    const sk = j[`${SLACK_SKIPPED_PREFIX}${name}`];
    return {
      cursor: typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, string>) : {},
      skipped: Array.isArray(sk) ? sk.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    /**
     *  If the cursor is absent or corrupt, the system creates a fresh per-channel
     *  ledger and drains from the start.
     */
  }
  return { cursor: {}, skipped: [] };
}

function readSlackCursor(io: Io, name: string): Record<string, string> {
  return readSlackState(io, name).cursor;
}

function writeSlackCursor(io: Io, name: string, perChannel: Record<string, string>, skipped?: string[]): void {
  const p = cursorPath(io, name, true);
  let j: Record<string, unknown> = {};
  try {
    // Values are taken from where they are. See the note in `writeCursor`.
    j = JSON.parse(readFileSync(cursorPath(io, name), "utf8")) as Record<string, unknown>;
  } catch {
    /**
     *  An absent cursor file is a fresh ledger.
     */
  }
  j[`${SLACK_CURSOR_PREFIX}${name}`] = perChannel;
  if (skipped !== undefined) j[`${SLACK_SKIPPED_PREFIX}${name}`] = skipped;
  // The system used the directory of the file being written. This made the current
  // working directory `.scramble` whatever path `p` resolved to, so on a host where
  // the cursor lives beside the config, the write would fail for a directory that
  // does not exist yet.
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(j));
}

/**
 *  The parser converts a Slack ts (`seconds.microseconds`) into a comparable
 *  number, and returns -1 when it does not parse so it can never win a "newest"
 *  comparison.
 */
function slackTs(ts: string): number {
  const n = Number.parseFloat(ts);
  return Number.isFinite(n) ? n : -1;
}

/**
 *  The comparison selects the newer of two timestamp (`ts`) values. An undefined
 *  cursor counts as the oldest timestamp.
 */
function newerTs(a: string | undefined, b: string): string {
  if (a === undefined || slackTs(b) > slackTs(a)) return b;
  return a;
}

async function slackCmdNext(argv: string[], io: Io): Promise<number> {
  // A stale configuration announces itself on the path it breaks. An agent
  // onboarded before a fix keeps running and silently lacks it, so the delivery
  // commands that a mention travels through print the one line that names the
  // repair. This check costs nothing because it reads the configuration already
  // being loaded.
  {
    const w = staleConfigWarning(loadSlackConfig(io), nameFor(parseArgs(argv).flags, io));
    if (w !== "") io.writeErr(w);
  }

  const { flags, positionals } = parseArgs(argv);
  const name = nameFor(flags, io);
  const timeoutSec = intFlag(flags, "timeout", 300);
  const status = statusTracker(io, "slack", name);
  await settleStatus(status?.clearExpired());
  const s = slackBackend(io);
  if (s.error !== undefined || s.backend === undefined) {
    io.writeErr(s.error ?? "slack unavailable");
    return 1;
  }
  const r = await s.backend.next(positionals, name, timeoutSec, (p) => io.writeErr(`slack: ${p}`));
  if (r.code === 64) return 64;
  // Exit code 1 means scramble could not look because the socket open was refused.
  // The refusal was already reported on stderr, so scramble surfaces a nonzero exit
  // code that a harness never mistakes for a quiet channel.
  if (r.code === 1) return 1;
  if (r.line !== undefined) {
    if (status !== undefined) await settleStatus(deliverStatus(status, r.line, name));
    emitDelivery(io, name, r.line as unknown as Record<string, unknown>);
  }
  return 0;
}

async function slackCmdListen(argv: string[], io: Io): Promise<number> {
  // A stale configuration announces itself on the path it breaks. An agent
  // onboarded before a fix keeps running and silently lacks it, so the delivery
  // commands that a mention travels through print the one line that names the
  // repair. This check costs nothing because it reads the configuration already
  // being loaded.
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
  recordSelf(io, name);
  const drift = watchForNewerInstall(io);
  // ARMING THE LISTENER ARMS THE SWEEP. See `sweepInsideListener`.
  // `bind` and not a wrapper arrow: an arrow here is a function the tests would have
  // to reach through a 15-minute timer to run.
  const sweep = sweepInsideListener(io, sweepOnce.bind(null, flags, io, "slack"));
  try {
    return await s.backend.listen(
      positionals,
      name,
      (d) => {
        if (status !== undefined) void deliverStatus(status, d, name);
        emitDelivery(io, name, d as unknown as Record<string, unknown>, flags.has("addressed"));
      },
      (p) => io.writeErr(`slack: ${p}`),
    );
  } finally {
    stopTicker?.();
    drift.stop();
    sweep.stop();
  }
}

/**
 *  The local-backend `message check` command drains the agent's pending messages
 *  and advances the client-side cursor. The command is slightly non-blocking: it
 *  fetches the pending list, prints one JSON line per message, records the highest
 *  seq in `.scramble/cursor.json`, and exits 0. If nothing is pending, the command
 *  prints nothing and exits 0.
 */
async function messageCheckLocal(flags: Map<string, string>, io: Io): Promise<number> {
  const name = nameFor(flags, io);
  const status = statusTracker(io, "local");
  await settleStatus(status?.clearExpired());
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
    if (status !== undefined) await settleStatus(deliverStatus(status, d, name));
    emitDelivery(io, name, d as unknown as Record<string, unknown>);
  }
  if (deliveries.length) {
    const highest = Math.max(...deliveries.map((d) => d.seq));
    writeCursor(io, name, highest);
  }
  return 0;
}

/**
 *  The Slack backend for `message check` drains every configured channel starting
 *  from the agent's per-channel Slack cursor, matching how the local path drains a
 *  pending list, which makes this command the direct mirror of `messageCheckLocal`.
 *  Because Slack has no server-held per-agent inbox and no global sequence, the
 *  cursor is the conversation `ts` timestamp per channel, stored client-side in
 *  `.scramble/cursor.json` under a namespaced key. The command prints one JSON line
 *  for each drained message in the format that `listen` prints, includes a
 *  `mentioned` flag for this agent, sets the working status for addressed lines
 *  exactly as the local path does, advances the cursor to the newest line seen per
 *  channel, and exits 0. The command reports a broken or missing configuration.
 */
async function messageCheckSlack(flags: Map<string, string>, io: Io): Promise<number> {
  // A stale configuration announces itself on the path it breaks. An agent
  // onboarded before a fix keeps running and silently lacks it, so the delivery
  // commands that a mention travels through print the one line that names the
  // repair. This check costs nothing because it reads the configuration already
  // being loaded.
  {
    const w = staleConfigWarning(loadSlackConfig(io), nameFor(flags, io));
    if (w !== "") io.writeErr(w);
  }

  const name = nameFor(flags, io);
  const status = statusTracker(io, "slack", name);
  await settleStatus(status?.clearExpired());
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
  const startedState = readSlackState(io, name);
  const started = startedState.cursor;
  const startedSkipped = startedState.skipped;
  const next = { ...started };
  const ids = s.backend.identities(name);
  let unreachable = 0;
  let drained = 0;
  // The drain reports line counts. The metric `drained` counts channels, and nothing
  // here stated how many lines went out, so the operator read the highest `seq` in
  // the output as a count and published 211 for a tick that delivered 165. The `seq`
  // value is per-drain and skips the lines the drain passes over, including this
  // agent's own sends.
  let delivered = 0;
  // Today's rules reject earlier statements.
  const selfHits: string[] = [];
  // The sweep inspects the union of the channels this agent is in and the channels
  // named in the configuration. The sweep previously walked only `cfg.channels`,
  // a manually maintained map in a configuration that several agents share. When a
  // peer removed two entries while testing resolution, this sweep stopped covering
  // the channel that the operator uses to talk to the agent. The sweep reported
  // "none of the 3 configured channels are readable" while the listener continued
  // delivering messages, so nothing looked broken. The configuration still
  // contributes channels, because a name mapped there may be a direct message or a
  // conversation that the channel listing does not return.
  const mine = await s.backend.myChannels(name);
  if (mine.problem !== undefined) io.writeErr(`slack: ${mine.problem}`);
  // An agent missing from a channel is not a fault, although the system previously
  // reported it as one. Because every agent on a host shares the configuration, each
  // sweep walked channels belonging to other agents and printed
  // `slack: <name>: channel_not_found` for each channel on every run. An agent
  // reported two such lines on every check for channels it had never joined.
  //
  // The loop now classifies channels using the membership listing it already
  // fetched, and reports once at the end of the run. When that listing fails, the
  // loop has nothing to classify with, so every channel stays loud: a filter that
  // cannot tell the two apart must not choose the quiet answer.
  const memberOf = new Set(mine.names);
  const canClassify = mine.problem === undefined;
  const notMine: string[] = [];
  for (const channel of [...new Set([...Object.keys(cfg.channels), ...mine.names])].sort()) {
    let newestOwn: string | undefined;
    const cursor = started[channel];
    // Slack treats `oldest` as inclusive, so re-filter for strictly newer lines. The
    // cursor line itself must not re-drain on a repeat `message check`.
    const r = await s.backend.history(channel, cursor === undefined ? undefined : cursor, name, true);
    for (const p of r.problems) io.writeErr(`slack: ${p}`);
    if (r.code !== 0) {
      // An unreachable channel must not silence the remaining channels. This loop walks
      // every configured channel. Every agent on the host shares the configuration, and
      // each agent is invited to different channels, so a channel this agent is not in
      // is the normal case with no fault behind it. Failing the entire drain there
      // meant
      // an agent with one uninvited channel drained nothing and reported `read failed`,
      // which a sweeping agent cannot tell from a quiet channel.
      const notAMember =
        canClassify && !memberOf.has(channel) && /channel_not_found|not_in_channel/.test(r.error ?? "");
      if (notAMember) {
        notMine.push(channel);
      } else {
        io.writeErr(`slack: ${channel}: ${r.error}`);
      }
      unreachable += 1;
      continue;
    }
    const fresh =
      cursor === undefined ? r.messages : r.messages.filter((m) => slackTs(m.ts) > slackTs(cursor));
    let newest: string | undefined = cursor;
    for (const m of fresh) {
      // The cursor advances past every new line, including any skipped line, so a
      // repeated sweep never re-reads its own message forever.
      newest = newerTs(newest, m.ts);
      // The system uses the same identity set that the backend delivers. A mention of
      // this agent's Slack handle addresses the agent. Computing mention status locally
      // from the name alone caused a real mention to arrive with mentioned:false. The
      // backend determines this state for a drain, including thread membership that a
      // local name match cannot see. The system provides no local fallback, because a
      // second way to compute `mentioned` produces an answer that disagrees with the
      // first.
      const mentioned = (m as { mentioned?: boolean }).mentioned === true;
      const line = { ...m, mentioned };
      // The `message check` command delivers messages that have arrived for an agent.
      // Because an agent's own post has not arrived for anybody, the command skips the
      // line whose resolved sender is the draining agent. It applies the same name
      // comparison that `listen` and `next` use, so an agent sweeping does not read its
      // own last message as new traffic. The `message read` command provides a
      // transcript
      // and keeps every line. The delivery drain is the only path that filters. The
      // `from` field contains the resolved sender, which is an app's handle, so
      // comparing against the scramble name alone let an agent drain its own messages
      // back.
      if (ids.includes(m.from)) {
        // The sweep reads these lines back against current rules during its pass. Every
        // rule in this file was added after a message carrying what it bans had already
        // gone out, so previously sent messages provide the evidence for whether the
        // newest rule was needed.
        //
        // Three consecutive occurrences require the message check to guard this general
        // pattern. A rule that guards only the next message leaves every earlier
        // message
        // standing in the channel, unmarked, as though it were fine. The newest line
        // here
        // answers all older messages. A reply is a reply whether or not it went through
        // this CLI while the ledger existed.
        newestOwn = newerTs(newestOwn, m.ts);
        const late = lintLanguage(m.text ?? "");
        if (late.length > 0) {
          selfHits.push(
            `${channel} ${m.ts}: ${late.map((h) => `[${h.label}] ${JSON.stringify(h.match)}`).join(" ")}`,
          );
        }
        continue;
      }
      if (status !== undefined) await settleStatus(deliverStatus(status, line, name));
      emitDelivery(io, name, line as unknown as Record<string, unknown>);
      delivered += 1;
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
  // The same call writes the skipped set with the cursor, so the next sweep can
  // tell a moved set from a standing one.
  writeSlackCursor(io, name, next, [...notMine].sort());
  // The output appears on every sweep, including sweeps with a count of zero. A tick
  // that delivered nothing is the state an agent wants confirmed, and an unprinted
  // count gets inferred from the records.
  //
  // `drained` counts channels read, and a channel with nothing new is one of them,
  // so the line states that channels were read and omits delivery phrasing. The
  // first wording reported "from 1 channel" for a sweep that carried nothing.
  io.writeErr(`check: ${delivered} line(s) delivered, ${drained} channel(s) read.`);
  if (selfHits.length > 0) {
    io.writeErr(
      `${selfHits.length} message(s) you already sent would be refused by today's rules:\n` +
        `${selfHits.map((h) => `  ${h}`).join("\n")}\n` +
        `Each rule here was added after a message went out carrying what it bans. ` +
        `Correct them in the channel where they are still standing.`,
    );
  }
  // The process emits a single line for the full set, and only when the set changes.
  // This line previously printed on every sweep, so a monitor guarding on
  // `if [ -n "$out" ]` fired on every tick: 123 of 187 ticks carried this line and
  // nothing else. A line that repeats identically every fifteen minutes teaches its
  // reader to skip the entire stream, which obscures real reports.
  //
  // The set is a standing fact about a shared configuration, so `doctor` prints it
  // on every run, and the sweep reports when the set changes: a channel this agent
  // expected to be in stays findable, and the quiet ticks stay quiet.
  const skippedNow = [...notMine].sort();
  const setMoved = skippedNow.join("\u0000") !== startedSkipped.join("\u0000");
  if (notMine.length > 0 && setMoved) {
    io.writeErr(
      `slack: skipped ${notMine.length} channel(s) ${name} is not a member of: ${notMine.join(", ")}. ` +
        `The config is shared by the agents on this host, so these belong to another one. ` +
        // The document provides the command line already filled in for a human to
        // paste.
        // An agent read this list, learned a channel existed that it wanted, and had to
        // ask which command to request. An application cannot add itself to a Slack
        // conversation, so a person must type this line, and making them compose it
        // creates an unnecessary round trip.
        `If one of them is yours, ask a member of it to run:  /invite @${ids[1] ?? ids[0] ?? name}`,
    );
  }
  // The agent emits a REPORT whenever every configured channel is refused. It never
  // exits silently with code 0, because an agent invited to none of the channels
  // must not read as a quiet workspace.
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
  // The sweep operates as the active caller. It runs on a timer in every agent's
  // harness, so this section reports the drift between a running listener and the
  // installed copy, and the listener monitors that drift as well. An agent whose
  // listener fell six hours behind discovered the gap by running `doctor` for an
  // unrelated reason, demonstrating that the advisory requires an active caller.
  //
  // The drain and the owed report are `sweepOnce`, which the listener runs on its own
  // timer: one body, so a hand-run check and a listener's sweep cannot drift apart.
  const code = await sweepOnce(flags, io, backend);
  // This step runs after the drain, so the drain's own report is what a reader sees
  // first and these lines never sit ahead of a failure it names.
  //
  // The sweep reads each listener's own commit. An earlier version compared this
  // process against the install. A sweep launched from the shared launcher is
  // the install, so the line never fired, which means the added caller was inert
  // on every host that runs the launcher.
  //
  // `listenersBehind` is the comparison `doctor` already makes, and it reads each
  // listener's own command line, which carries the commit directory it was
  // started from.
  const procRoot = io.env("SCRAMBLE_PROC") ?? "/proc";
  const agentName = nameFor(flags, io);
  if (processesReadable(procRoot)) {
    const procs = readProcesses(procRoot);
    const installed = installedCommit(io);
    const behind = listenersBehind(procs, agentName, installed);
    if (behind.length > 0) {
      io.writeErr(
        `scramble: ${behind.length} listener(s) for ${agentName} run a different commit than the ` +
          `installed ${installed}: ${behind.map((b) => `pid ${b.pid} on ${b.commit}`).join(", ")}. They hold ` +
          `the code they started with, so a change somebody made has NOT reached you. Restart the listener.` +
          changeBlock(behind[0]!.commit, installedChanges(io)),
      );
    }
    // Verify whether anything is armed at all. A count of zero marks the loud case: a
    // listener on an older commit still delivers, and having no listeners armed means
    // every mention waits for the next sweep.
    if (liveListeners(procs, agentName).length === 0) {
      io.writeErr(
        `scramble: NO listener is running for ${agentName}, so nothing wakes this agent between ` +
          `sweeps and every mention waits for the next one. Arm it: scramble listen --addressed --as ` +
          `${agentName}`,
      );
    }
  }
  return code;
}

/** One sweep: drain what arrived since this agent's cursor and report what is owed.
 *
 *  THE LISTENER RUNS THIS ON A TIMER, which is why it is a function and not the body
 *  of `message check`. Arming used to be two commands, and agents arrived with one of
 *  them: the timed sweep is the one they missed, so ordinary traffic and the lines
 *  they owed never surfaced. Both callers run the same drain, so the sweep an agent
 *  gets from a listener is the sweep `message check` performs.
 *
 *  THE OWED REPORT BELONGS TO THE SWEEP, because the sweep runs regardless of what the
 *  agent is doing, and a closing hook would be per client while the same agent runs
 *  under more than one. It prints after the drain, so the count includes the lines
 *  just delivered, and on stderr, so the stdout contract stays one JSON line per
 *  message. */
async function sweepOnce(flags: Map<string, string>, io: Io, backend: "local" | "slack"): Promise<number> {
  const code = backend === "slack" ? await messageCheckSlack(flags, io) : await messageCheckLocal(flags, io);
  const owed = pendingInbox(inboxPath(slackConfigPath(io), nameFor(flags, io)));
  if (owed.length > 0) io.writeErr(pendingReport(owed, nameFor(flags, io)));
  return code;
}

/** The sweep interval a listener keeps, in milliseconds.
 *
 *  The documented sweep timer was 15 minutes when every agent armed its own, and a
 *  listener that sweeps on the same period delivers what that timer delivered. The
 *  staleness mark in `monitorReport` is 30 minutes, so two consecutive sweeps have to
 *  miss before an agent reads that its sweep died. */
export const SWEEP_INTERVAL_MS = 15 * 60_000;

/** Run the sweep inside a listener, on the clock, forever.
 *
 *  ONE ARMING ARMS BOTH MONITORS. The two are separate jobs inside one process: the
 *  socket delivers a mention in seconds and the sweep catches everything the
 *  socket did not, including whatever arrived while the socket was broken. A broken
 *  socket does not stop this timer, so the case the sweep exists for stays covered
 *  from inside the same process.
 *
 *  A dead listener now takes the sweep with it, and the record that says so is read
 *  on every send: `monitorReport` reads the process list for the listener and the
 *  cursor's mtime for the sweep, from each monitor's own record.
 *
 *  A SWEEP THAT OVERRUNS ITS INTERVAL DOES NOT STACK. A slow drain across many
 *  channels can outlast the period, and two drains at once advance one cursor
 *  underneath each other. The in-flight flag drops the tick that would overlap. */
export function sweepInsideListener(
  io: Io,
  run: () => Promise<unknown>,
  intervalMs = SWEEP_INTERVAL_MS,
): { stop: () => void; tick: () => Promise<void> } {
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await run();
    } catch (e) {
      // THE SWEEP'S FAILURE IS THE AGENT'S FAILURE TO HEAR ANYTHING, so it prints
      // what it saw. A throw inside a timer callback with no catch takes the whole
      // listener down, which would turn one failed drain into a dead inbox.
      io.writeErr(`scramble: the sweep inside this listener failed and messages may be waiting: ${String(e)}`);
    } finally {
      inFlight = false;
    }
  };
  // A real timer, for the reason `watchForNewerInstall` gives: a sleep loop under a
  // stubbed clock spins at full speed. `unref` allows the process to exit while the
  // timer is pending.
  const timer = setInterval(tick, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  // ONE SWEEP AT STARTUP, because a restart otherwise resets the whole interval and
  // the restart is exactly when the gap exists: the process was down, and every
  // install tells every agent on the host to restart, so a run of installs can push
  // the first sweep back indefinitely. This drain covers the time the process was
  // gone, which is what the sweep is for.
  void tick();
  return { stop: () => clearInterval(timer), tick };
}

/**
 *  The mirrored `message` family consists of `send`, `check`, and `read`. Each
 *  command dispatches to the selected backend below verb parsing and reports an
 *  unknown verb.
 */
/**
 *  The parser collects every value passed for a repeatable flag
 *  (`--attach a --attach b`) and supports both `--flag value` and `--flag=value`
 *  spellings.
 */
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
  /**
   *  `permalink` is Slack's link to the stored file and is absent on the local
   *  backend. The SEND path places `permalink` in the message text, which makes Slack
   *  attach the file to that message. Without it, the bytes sit in Slack's storage
   *  attached to nothing.
   */
  { ok: true; id: string; permalink?: string; ts?: string } | { ok: false; error: string };

/**
 *  Upload one local file to the selected backend and return the file id assigned
 *  by that backend (a Slack file id or a local ledger id). The `path` carries
 *  through so a session can read the bytes.
 */
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
    // Requests pass through the backend, which resolves channels and converts
    // mentions. This function used to read cfg.channels itself and hand raw text to
    // Slack, so an attach failed on a channel a plain send reached, and a name in the
    // text notified nobody.
    const s = slackBackend(io);
    if (s.error !== undefined || s.backend === undefined) {
      return { ok: false, error: s.error ?? "slack backend unavailable" };
    }
    const r = await s.backend.upload(targetChannel, path, as ?? "", mimeOverride, initialComment, threadTs);
    return r.ok ? { ok: true, id: r.id, permalink: r.permalink, ts: r.ts } : { ok: false, error: r.error };
  }
  const r = recordLocalUpload(slackFilesDir(io), path, mimeOverride);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, id: r.record.id };
}

/**
 *  To resolve an attachment id to a local path for `attachment view`, the local
 *  backend finds the entry in the filesDir ledger. The Slack backend locates the
 *  file recorded there, where inbound downloads arrive in filesDir under their file
 *  id.
 */
async function attachmentView(
  id: string,
  out: string | undefined,
  io: Io,
  backend: "local" | "slack",
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const dir = slackFilesDir(io);
  const rec = findLocalRecord(dir, id);
  if (rec) {
    const finalPath = out !== undefined ? out : rec.path;
    if (out !== undefined) copyFileSync(rec.path, out);
    return { ok: true, path: finalPath };
  }
  // Fetch file contents on demand when data is not on disk. Delivery no longer
  // downloads the bytes of every file that passes through a channel, because three
  // agents in one room each downloaded the same 41MB archive addressed to one of
  // them, inside the delivery path, on a filesystem at 99%. The metadata always
  // arrives, so the id on the line is sufficient to fetch the bytes when they are
  // wanted.
  if (backend !== "slack") return { ok: false, error: `no recorded attachment ${id}` };
  const cfg = loadSlackConfig(io);
  if (cfg === null) return { ok: false, error: `${slackConfigPath(io)} is missing or malformed` };
  const token = cfg.token;
  const info = await io.fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const j = (await info.json()) as {
    ok?: boolean;
    error?: string;
    file?: { url_private_download?: string; name?: string };
  };
  if (j.ok !== true) {
    return { ok: false, error: `attachment ${id} is not on disk and Slack answered ${String(j.error)}` };
  }
  const url = j.file?.url_private_download;
  if (url === undefined || url === "") {
    return { ok: false, error: `attachment ${id} is not on disk and Slack gave no download url for it` };
  }
  const got = await downloadFile(io.fetch, url, token, dir, id, j.file?.name ?? id);
  if (!got.ok) return { ok: false, error: got.error };
  const finalPath = out !== undefined ? out : got.path;
  if (out !== undefined) copyFileSync(got.path, out);
  return { ok: true, path: finalPath };
}

/**
 *  The mirrored `attachment` verbs, `upload` and `view`, mirror raft's grammar.
 *  `upload` prints the file id as one JSON line, and `view` prints the path
 *  written.
 */
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

/**
 *  The `scramble version` command reports which commit this CLI is, reading the
 *  value from the COMMIT file the installer writes beside the source.
 *
 *  An agent could not answer this question before. `bun link` points the command
 *  name on PATH at the maintainer's checkout, so `scramble` ran whatever that tree
 *  held at the moment of the call, including a half-saved edit. The output now
 *  states which copy is running and where that copy lives, and prints RUNNING FROM
 *  A CHECKOUT when no COMMIT file exists, because the version is a moving target
 *  in that case.
 */
function cmdVersion(io: Io): number {
  const dir = io.moduleDir ? io.moduleDir() : "";
  let commit = "";
  try {
    commit = readFileSync(join(dir, "COMMIT"), "utf8").trim();
  } catch {
    /**
     *  This directory contains no COMMIT file because this is a checkout, which the
     *  output below reports as such.
     */
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

/**
 *  The `scramble lint <file>...` command checks files or standard input against the
 *  same rules that `message send` enforces.
 *
 *  The command can run independently to check other documents, such as Lark docs or
 *  Markdown files. Because a document going to the same audience requires the same
 *  reading, the command reuses the rule list from `message send` and maintains no
 *  copy of its own.
 *
 *  The command prints `file:line: [label] "match"` and exits with code 1 when any
 *  rule matches.
 */
/**
 *  The source file blanks all content except its comment lines and preserves
 *  every newline, so an offset still names its own line.
 */
/**
 *  A multi-line diagnostic repeats its own key on every line after the first.
 *
 *  The emitter manages this repetition. Call sites declare a key on the first line
 *  and stop there. When the read-back block was keyed by hand and three more
 *  remained bare, an agent running the commands found two of them within the hour:
 *  `inbox pending` and `rewrites --near`. Every line the tool writes now carries
 *  the key declared on its first line, which covers every block written from this
 *  point forward.
 *
 *  A first line with no `key:` prefix passes through untouched, and shows up in
 *  the output as a block a filter can still halve.
 */
export function autoKey(text: string): string {
  const first = text.split("\n", 1)[0] ?? "";
  const key = /^([a-z][a-z0-9-]*:)(?: |$)/.exec(first)?.[1];
  if (key === undefined || !text.includes("\n")) return text;
  const [head, ...rest] = text.split("\n");
  return [head, ...rest.map((line) => `${key} ${line}`)].join("\n");
}

/**
 *  The guard outputs the first printable line where two texts diverge, or an
 *  empty string when they differ only in trailing lines that nobody wrote.
 *
 *  A guard prints what it saw. Displaying "DIFFERS" with the whole stored text
 *  under it provides a summary. The reader still has to find the divergence. Slack
 *  transforms what it stores (a bare `users.info` came back as an auto-link), and
 *  telling that apart from a dropped mention is the whole point of reading the
 *  line.
 */
export function differenceLine(sent: string, stored: string): string {
  const a = sent.split("\n");
  const b = stored.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? "") === (b[i] ?? "")) continue;
    return `First line that differs (${i + 1}):\n  sent:   ${a[i] ?? "(no such line)"}\n  stored: ${b[i] ?? "(no such line)"}\n`;
  }
  return "";
}

/**
 *  A calibration row records 16 hexadecimal characters of the SHA-256 hash for
 *  each of its two messages.
 */
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 *  This check verifies whether a re-read pair produces the hash recorded in the
 *  row.
 *
 *  A hash discrepancy represents an expected formatting change. The recorded hash
 *  captures the payload delivered to a listener, while this check reads the message
 *  back through `storedMessage`, which renders mentions and undoes Slack's escape
 *  sequences. Measurements on the live table confirm that both messages in one
 *  row match, one message in another row matches, and its neighbour differs while
 *  scoring exactly what it always did. Therefore, the system reports the verdict
 *  and never counts it as a failure.
 */
export function hashVerdict(
  recorded: [string, string] | undefined,
  read: string[],
): "matches" | "differs" | undefined {
  return recorded === undefined ? undefined : recorded[0] === read[0] && recorded[1] === read[1] ? "matches" : "differs";
}

export function maskToComments(text: string, style: "slash" | "hash" = "slash"): string {
  // The `hash` style processes shell scripts. Running that mask over TypeScript
  // would read a private class field as prose, so the caller selects the style by
  // file extension.
  const opener = style === "hash" ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
  return text
    .split("\n")
    .map((l) => (opener.test(l) && !l.startsWith("#!") ? l : l.replace(/[^\n]/g, " ")))
    .join("\n");
}

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
        // The system treats an unreadable file as a failure and refuses to pass
        // silently,
        // because a linter that skips files it cannot open reports clean on a typo.
        io.writeErr(`lint: cannot read ${p}: ${String(e)}`);
        return 1;
      }
    }
  }
  // The `--comments` flag lints the comment text of a source file. Clean the
  // comments because every rule here was written for prose a person reads, and a
  // comment is prose a person reads.
  //
  // The tool blanks non-comment lines in place, so the offsets still name the real
  // line, and code that happens to contain a banned word (the rule table's own
  // patterns) is out of scope.
  const commentsOnly = argv.includes("--comments");
  let total = 0;
  for (const src of sources) {
    const hash = /\.(sh|bash|py|toml|yml|yaml)$/.test(src.name);
    const text = commentsOnly ? maskToComments(src.text, hash ? "hash" : "slash") : src.text;
    // The repository applies its own rules to its own text. The linter checks files on
    // disk with CODE_RULES, which add the ban on dated logs. Text piped in on stdin is
    // a message, and a message may carry a date as evidence.
    //
    // The `--dates` flag restricts the check to the dated-log rule. The suite uses
    // this option to verify the tests and the scripts, because the ban applies to
    // every file the repository ships. The prose rules had never run over those
    // directories, where they find 121 older hits that remain separate work.
    const rules = argv.includes("--dates") ? DATE_RULES : src.name === "(stdin)" ? undefined : CODE_RULES;
    for (const h of lintLanguage(text, rules)) {
      io.writeErr(`${src.name}:${lineOf(text, h.index)}: [${h.label}] ${JSON.stringify(h.match)}`);
      total += 1;
    }
  }
  io.write(JSON.stringify({ lint: total === 0 ? "clean" : "hits", files: sources.length, hits: total }));
  return total === 0 ? 0 : 1;
}

/**
 *  The `scramble peers [--same-dir]` command reports which other agents run,
 *  which host each agent runs on, and which directory each agent uses.
 *
 *  Each agent records its hostname and working directory on `scramble`, so an agent
 *  may know its peers in the same directory.
 *
 *  The `--same-dir` flag matches the host and the directory together. The path
 *  alone does not establish identity: two agents measured the same absolute path on
 *  two machines backed by different filesystems, and neither could see the other's
 *  files. Grouping by path would have told them they shared a directory when they
 *  shared a string.
 */
/**
 *  `scramble rewrite [<file>]` previews what the rewriter produces from the text.
 *
 *  The command cannot send messages, so an author can inspect the model's answer,
 *  and the tool can run any file in the repository through the rules it enforces
 *  for others, including the instruction prompt itself.
 *
 *  This command writes no row to the ledger. The ledger counts sends that met the
 *  rewriter, while a preview produces text without sending.
 */
/**
 *  The process rewrites a repository document for an outside reader, sends one
 *  section per model call, and prints the assembled document.
 *
 *  If safety guards refuse a section, that section keeps its original text, and the
 *  system prints the refusal to stderr with the heading name. Silently dropping a
 *  section that the model cannot rewrite would produce an incomplete document that
 *  appears finished.
 */
async function cmdRewriteDocument(text: string, name: string, io: Io, noGuards = false): Promise<number> {
  const dir = io.moduleDir ? io.moduleDir() : "src";
  const template = readDocumentTemplate(dir);
  if (!template.ok) {
    io.writeErr(`document: ${template.why}`);
    return 1;
  }
  // Use a single instruction file without a channel register. The first version
  // appended the external register block, which describes a Slack channel's audience
  // as people who do not read this repository, including cross-functional
  // stakeholders. The model wrote that description into the document, the
  // instruction-echo guard detected it, and every section of the first run was
  // refused. The rules an outside reader needs live in prompts/document.md.
  const cfg = rewriteConfig(io.env);
  if (cfg.key === undefined) {
    io.writeErr(`document: no model is configured; set SCRAMBLE_REWRITE_KEY to turn it on.`);
    return 1;
  }
  const sections = splitSections(text);
  const out: string[] = [];
  let refused = 0;
  for (const [i, section] of sections.entries()) {
    const heading = (section.split("\n", 1)[0] ?? "").slice(0, 70);
    const said = await rewriteWith(io.fetch, cfg, composePrompt(template.text, section));
    if (noGuards) {
      if (said.ok) { out.push(said.text.trim()); } else { refused += 1; out.push(section); }
      io.writeErr(`document: section ${i + 1} of ${sections.length} ${said.ok ? "rewritten" : "kept as written"}: ${heading}`);
      continue;
    }
    let chosen = chooseText(section, said, instructionOf(template.text), { document: true });
    // This request includes what the guard observed. Every guard triggers on an action
    // the model took, so the model can fix it. The message path has made two requests
    // since two agents observed the rewriter reinsert a banned form and lost the
    // transmission because of it.
    if ("refuse" in chosen && chosen.retry !== undefined) {
      const again = await rewriteWith(io.fetch, cfg, `${composePrompt(template.text, section)}\n\n${chosen.retry}`);
      chosen = chooseText(section, again, instructionOf(template.text), { document: true });
    }
    if ("refuse" in chosen) {
      refused += 1;
      io.writeErr(`document: section ${i + 1} of ${sections.length} kept its original text (${chosen.why}): ${heading}`);
      out.push(section);
      continue;
    }
    io.writeErr(`document: section ${i + 1} of ${sections.length} rewritten: ${heading}`);
    out.push(chosen.send.trim());
  }
  io.write(out.join("\n\n"));
  io.writeErr(
    `document: ${name}, ${sections.length} section(s), ${sections.length - refused} rewritten, ${refused} kept as written.`,
  );
  return 0;
}

/**
 *  A comment rewrite must leave untouched the lines of a file with every comment
 *  run removed.
 */
function codeLines(text: string, style: "slash" | "hash"): string[] {
  const lines = text.split("\n");
  const drop = new Set<number>();
  for (const run of commentRuns(text, style)) {
    for (let i = run.start; i <= run.end; i += 1) drop.add(i);
  }
  return lines.filter((_l, i) => !drop.has(i));
}

/**
 *  The program rewrites every comment in a source file and prints the file.
 *
 *  The program compares the code before it prints anything. A rewrite that
 *  reflowed a line of code would be a silent edit to a program, so the program
 *  compares the lines outside the comments byte for byte and refuses the whole
 *  file on any difference.
 *
 *  ONE BYTE DOES CHANGE. The writer ends every line it prints with a newline, so a
 *  file that arrived without one leaves with one, and git shows that as
 *  `No newline at end of file` on the old side. An agent auditing this rewrite found
 *  exactly that as the only difference in a delivery-path file, with the hash of the
 *  non-comment line sequence identical on both sides.
 */
async function cmdRewriteComments(text: string, name: string, io: Io, noGuards = false): Promise<number> {
  const dir = io.moduleDir ? io.moduleDir() : "src";
  const template = readDocumentTemplate(dir);
  if (!template.ok) {
    io.writeErr(`comments: ${template.why}`);
    return 1;
  }
  const cfg = rewriteConfig(io.env);
  if (cfg.key === undefined) {
    io.writeErr(`comments: no model is configured; set SCRAMBLE_REWRITE_KEY to turn it on.`);
    return 1;
  }
  const style: "slash" | "hash" = /\.(sh|bash|py|toml|yml|yaml)$/.test(name) ? "hash" : "slash";
  const runs = commentRuns(text, style);
  const lines = text.split("\n");
  let done = 0;
  let kept = 0;
  for (const run of [...runs].reverse()) {
    const said = await rewriteWith(io.fetch, cfg, composePrompt(template.text, run.prose));
    let chosen: RewriteChoice = noGuards
      ? said.ok
        ? { send: said.text, note: "" }
        : { refuse: said.why, why: said.why }
      : chooseText(run.prose, said, instructionOf(template.text), { document: true });
    if (!noGuards && "refuse" in chosen && chosen.retry !== undefined) {
      const again = await rewriteWith(io.fetch, cfg, `${composePrompt(template.text, run.prose)}\n\n${chosen.retry}`);
      chosen = chooseText(run.prose, again, instructionOf(template.text), { document: true });
    }
    if ("refuse" in chosen) {
      kept += 1;
      io.writeErr(`comments: lines ${run.start + 1}-${run.end + 1} kept as written (${chosen.why})`);
      continue;
    }
    done += 1;
    lines.splice(run.start, run.end - run.start + 1, ...renderComment(run, chosen.send.trim()));
  }
  const out = lines.join("\n");
  const before = codeLines(text, style);
  const after = codeLines(out, style);
  if (before.length !== after.length || before.some((l, i) => l !== after[i])) {
    const at = before.findIndex((l, i) => l !== after[i]);
    io.writeErr(
      `comments REFUSED for ${name}: the code outside the comments changed, first at code line ${at + 1}:\n` +
        `  before: ${before[at] ?? "(no such line)"}\n  after:  ${after[at] ?? "(no such line)"}`,
    );
    return 1;
  }
  io.write(out);
  io.writeErr(`comments: ${name}, ${runs.length} comment(s), ${done} rewritten, ${kept} kept as written.`);
  return 0;
}

async function cmdRewrite(argv: string[], io: Io): Promise<number> {
  // The parser tracks which flags take a value. A custom implementation that
  // inspected the first argument without dashes read `--tier external` as the file
  // name and tried to open a file called external.
  const parsed = parseArgs(argv);
  const file = parsed.positionals[0];
  let text: string;
  try {
    text =
      file === undefined ? await (io.readStdin ? io.readStdin() : Promise.resolve("")) : readFileSync(file, "utf8");
  } catch (e) {
    io.writeErr(`rewrite: cannot read ${file ?? "stdin"}: ${String(e)}`);
    return 1;
  }
  if (text.trim() === "") {
    io.writeErr(`rewrite: ${file ?? "stdin"} is empty, so there is nothing to rewrite.`);
    return 1;
  }
  // The `--why` flag requests the diagnosis. When this tool prints a refusal,
  // gemini 3.7 finds why the communication is wrong. A rewrite returns a better
  // version and leaves the author guessing which habit produced the worse one.
  if (argv.includes("--why")) {
    const cfg = rewriteConfig(io.env);
    if (cfg.key === undefined) {
      io.writeErr(`rewrite: no model is configured; set SCRAMBLE_REWRITE_KEY to turn it on.`);
      return 1;
    }
    const said = await rewriteWith(io.fetch, cfg, critiquePrompt(text));
    if (!said.ok) {
      io.writeErr(`rewrite: the model did not answer (${said.why}).`);
      return 1;
    }
    io.write(said.text.endsWith("\n") ? said.text : `${said.text}\n`);
    return 0;
  }
  // The `--document` flag rewrites a repository document section by section.
  // Because the message instruction limits prose to 300 words and requests a Slack
  // message, running it against a design document would delete most of the
  // document. This path reads prompts/document.md, adds the register block, and
  // transmits one section per call.
  if (argv.includes("--document")) {
    return cmdRewriteDocument(text, file ?? "stdin", io, argv.includes("--once"));
  }
  // The `--comments` flag rewrites the prose of every comment and leaves every line
  // of code byte for byte. A comment is prose that a person reads.
  if (argv.includes("--comments")) {
    return cmdRewriteComments(text, file ?? "stdin", io, argv.includes("--once"));
  }
  const { chosen, retried, configured } = await attemptRewrite(text, io);
  if (!configured) {
    io.writeErr(`rewrite: no model is configured; set SCRAMBLE_REWRITE_KEY to turn it on.`);
    return 1;
  }
  // Do not include send framing here. The `chosen.refuse` output ends with
  // "Rewrite your message and send again", which misstates the behavior of a verb
  // that never sends. The guard's name and the model's answer come out of the same
  // refusal, so the two readings cannot disagree about what happened.
  if ("refuse" in chosen) {
    if (chosen.attempt !== undefined) io.write(chosen.attempt);
    io.writeErr(`rewrite: the guards would stop this from going out: ${chosen.why}. Nothing was sent.`);
    return 1;
  }
  io.write(chosen.send.endsWith("\n") ? chosen.send : `${chosen.send}\n`);
  io.writeErr(
    chosen.note === ""
      ? `rewrite: the model returned what you wrote, unchanged.`
      : `rewrite: ${chosen.note}${retried ? " (on the second attempt)" : ""}`,
  );
  return 0;
}

/**
 *  `scramble rewrites` reports what the rewriter has done on this host.
 *
 *  Every claim about whether the rewriter helps has relied on a single case
 *  someone remembered. This command counts the outcomes and identifies which guard
 *  fires most often.
 */
/** Replay the drafts whose guard fired, under the rewriter as it stands now.
 *
 *  WHAT THIS ANSWERS. An instruction change is aimed at a class of refusals, and
 *  the only reading of whether it worked is what those same drafts do now. The
 *  guard verdicts before and after sit side by side, so a row that still fails, a
 *  row that passes now, and a row that fails for a NEW reason are three different
 *  outcomes and are counted apart.
 *
 *  EVERY REPLAYED ROW COSTS A MODEL CALL, so the count is bounded and the bound is
 *  printed with what it left out. A silent cap reads as full coverage.
 *
 *  This sends nothing to any channel: `attemptRewrite` is the send path's own
 *  rewriter, called here without the send. */
async function replayRewrites(flags: Map<string, string>, io: Io): Promise<number> {
  const who = flags.get("as") ?? nameFor(flags, io);
  const limit = intFlag(flags, "limit", 25);
  const pattern = flags.get("why") ?? "";
  const rows = readRewrites(rewritesPath(slackConfigPath(io))).filter(
    (r) => r.agent === who && typeof r.draft === "string" && r.draft !== "" && (pattern === "" || (r.why ?? "").includes(pattern)),
  );
  if (rows.length === 0) {
    io.writeErr(
      `replay: no row for ${who} carries a draft${pattern === "" ? "" : ` whose verdict contains ${pattern}`}. ` +
        `A draft is kept on a refused or retried row from this version onward, so the rows behind you hold ` +
        `verdicts alone and cannot be replayed.`,
    );
    return 1;
  }
  const take = rows.slice(-limit);
  if (take.length < rows.length) {
    io.writeErr(`replay: ${rows.length} row(s) match and this run takes the newest ${take.length}. Raise it with --limit.`);
  }
  let fixed = 0;
  let same = 0;
  let moved = 0;
  for (const row of take) {
    const { chosen } = await attemptRewrite(row.draft!, io);
    const now = "refuse" in chosen ? guardName(chosen.why) : "";
    const before = row.why ?? "";
    if (now === "") fixed++;
    else if (now === before) same++;
    else moved++;
    io.write(JSON.stringify({ replay: row.at, was: before, now: now === "" ? "clean" : now, words: row.words[0] }));
  }
  io.writeErr(
    `replay: ${take.length} draft(s) for ${who} under this build: ${fixed} clean now, ${same} refused for the ` +
      `same reason, ${moved} refused for a different one.`,
  );
  return 0;
}

async function cmdRewrites(argv: string[], io: Io): Promise<number> {
  // The `--as` flag selects rows for one named agent. Without `--as`, the command
  // counts every agent on the host and places their names on the first line, because
  // the file is shared and an unnamed count reads as the reader's own.
  const { flags } = parseArgs(argv);
  // The `--near` flag reads the duplicate scores that message sends measured. The
  // threshold in use rests on manual corpus runs that three agents performed, and
  // an agent who writes English by the operator's rule cannot produce Chinese
  // samples on request. The tool can gather these samples, so every send records
  // what it measured, and `--near` reads the accumulated records back.
  //
  // The `--replay` flag sends the stored drafts through the rewriter as it stands
  // now and prints each row's old verdict beside its new one. A change to the
  // instruction is measured on the drafts it was written for, and nothing else
  // measures it: three agents asked to measure one such change replayed whatever
  // drafts they still held, every one of those was clean under both builds, and the
  // comparison came back empty on all three hosts.
  if (flags.has("replay")) return replayRewrites(flags, io);
  // The `--calibrate` flag re-measures every recorded row from Slack. When two
  // readers execute the same function on one table, the operation measures the
  // readers. The table held the agent's synthetic pair labeled as the founding
  // incident for an hour, and any number of agreeing readers would have reproduced
  // that label. The system can fetch and score any row that names its two messages
  // again, which provides the only reading that does not originate from this agent.
  if (flags.has("calibrate")) {
    const who = flags.get("as") ?? nameFor(flags, io);
    const s = slackBackend(io);
    if (s.error !== undefined || s.backend === undefined) {
      io.writeErr(s.error ?? "slack unavailable");
      return 1;
    }
    // Each row specifies its own channel, so this verb takes no target. The
    // `--target` flag served as the fallback while rows carried only timestamps,
    // and a test requires every measured row to carry a channel, which left the
    // fallback and its refusal unreachable. A timestamp is unique inside one
    // conversation, so the channel belongs to the row.
    let drifted = 0;
    let differing = 0;
    for (const row of CALIBRATION) {
      if (row.source !== "measured" || row.ts === undefined) continue;
      // A row remains valid when its messages are gone. The first message of the 0.968
      // pair was deleted after the duplicate report that named it, so the row stands on
      // the reading taken while both messages existed, and a run that marked that
      // change as drift would raise false alarms on every future run.
      if (row.gone === true) {
        io.write(JSON.stringify({ calibrate: "gone", score: row.score, ts: row.ts, what: row.what }));
        continue;
      }
      const channel = row.channel!;
      const [a, b] = row.ts;
      // The row includes the thread root, since `conversations.history` omits replies
      // and a reply read without its root answers "no such message".
      const first = await s.backend.storedMessage(channel, a, who, row.threads?.[0]);
      const second = await s.backend.storedMessage(channel, b, who, row.threads?.[1]);
      if (!first.ok || !second.ok) {
        io.write(
          JSON.stringify({
            calibrate: "unreadable",
            score: row.score,
            ts: row.ts,
            channel,
            why: first.ok ? (second as { error: string }).error : first.error,
          }),
        );
        continue;
      }
      const again = pairScore(allWords(first.text), allWords(second.text));
      const moved = Math.abs(again.overlap - row.score) > 0.005 || (row.scale !== undefined && again.scale !== row.scale);
      if (moved) drifted += 1;
      // The system verifies the hash at this step, and this line identifies the text
      // the hash represents. One agent recorded these hashes from its wake files, and
      // another agent read two of them directly from Slack, which left the question
      // unresolved in prose. A score cannot answer it, because an edit that swaps two
      // words for two others moves no number that the guard reads.
      const read = [first.text, second.text].map(textHash);
      const hashes = hashVerdict(row.sha, read);
      if (hashes === "differs") differing += 1;
      io.write(
        JSON.stringify({
          calibrate: moved ? "drifted" : "holds",
          recorded: { score: row.score, scale: row.scale },
          measured: { score: Number(again.overlap.toFixed(3)), scale: again.scale },
          // The command outputs both hashes on every run, whether they match or differ,
          // so
          // a reader compares them against their own copy without running this again.
          hashes,
          sha: { recorded: row.sha, read },
          ts: row.ts,
          what: row.what,
        }),
      );
    }
    // Record one reading per pair, regardless of how many agents run the task. A
    // second agent's ceiling provides no independent support for a row when that
    // ceiling scores the same two messages with the same function. Three runs of one
    // algorithm on one pair produce three faithful executions. The rule establishes
    // this, so agreement across runs does not count as evidence.
    io.writeErr(
      drifted === 0
        ? "calibrate: every readable row scores what the table records. This is ONE reading of each pair: " +
          "another agent running this gets the same number from the same function, which is a check on the " +
          "run and not a second measurement."
        : `calibrate: ${drifted} row(s) score something else now. The table is wrong, the code changed, or both.`,
    );
    // A mismatched hash does not indicate drift. The system generates the recorded
    // hash from the payload delivered to a listener. Because this read operation
    // renders mentions and reverses Slack escape sequences, a row containing either
    // element produces a different hash here while retaining its original score. The
    // count reports how many rows changed, and each row's output identifies which rows
    // they are.
    if (differing > 0) {
      io.writeErr(
        `calibrate: ${differing} row(s) read back to a different hash. Compare the recorded hash against a wake ` +
          `file, which holds the text the hash was taken from.`,
      );
    }
    return drifted === 0 ? 0 : 1;
  }
  if (flags.has("near")) {
    const who = flags.get("as") ?? nameFor(flags, io);
    io.write(nearReport(readSentRows(sentPath(slackConfigPath(io), who)), NEAR_DUPLICATE_OVERLAP.content));
    return 0;
  }
  io.write(rewritesReport(readRewrites(rewritesPath(slackConfigPath(io))), flags.get("as")));
  return 0;
}

async function cmdPeers(argv: string[], io: Io): Promise<number> {
  const { flags } = parseArgs(argv);
  const rows = readPeerFile(peersPath(slackConfigPath(io)));
  // The `--json` output supports a watcher and requires no token and no network.
  // This field was added to `doctor` first, and the agent watching for a damaged
  // line refused it for a valid reason: `doctor` reads the app manifest, the stored
  // token on their host expired, so a watcher shelling out to `doctor` every ten
  // minutes depends on a command that already fails there. A question about a local
  // file must be answerable from the local file.
  if (flags.has("json")) {
    io.write(
      JSON.stringify({
        peers: currentPeers(rows.rows),
        damaged: rows.damaged,
        ...(agentOrigin(io) === undefined ? {} : { self: agentOrigin(io) }),
      }),
    );
    return 0;
  }
  io.write(peersReport(rows.rows, agentOrigin(io), flags.has("same-dir"), rows.damaged));
  return 0;
}

/**
 *  `scramble inbox pending --as <name>` prints every line addressed to this agent
 *  that nothing has answered, outputting one JSON object per line, and exits with
 *  status 1 while any message remains open.
 *
 *  A closing gate reads this exit code to refuse a turn that leaves someone
 *  waiting, so the delivery path counts the obligation per item independently of
 *  the author writing the turn. If the inbox is empty, the command prints nothing
 *  and exits with status 0.
 */
async function cmdInbox(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const sub = positionals[0] ?? "pending";
  const name = nameFor(flags, io);
  if (sub === "close") {
    // The command accepts more than one ID because a thread of other people's work
    // hands the operator a batch. An operator closed eight items one command at a
    // time in ten minutes, which is the pattern that teaches an agent to stop reading
    // its own list.
    //
    // The bulk case where the agent speaks is already covered elsewhere: a reply in a
    // channel closes everything older there. This command serves the case where the
    // agent says nothing, and the reason then covers every ID in the call.
    const ids = positionals.slice(1);
    const why = flags.get("why");
    if (ids.length === 0 || why === undefined || why.trim() === "") {
      io.writeErr(
        "inbox close needs at least one id and a reason: inbox close <ts> [<ts>...] --why <text>. " +
          "The reason is stored on every row it closes, because closing with no reply is the agent " +
          "deciding an obligation is settled and that decision belongs on the record.",
      );
      return 1;
    }
    let failed = 0;
    for (const id of ids) {
      const r = closeItemById(inboxPath(slackConfigPath(io), name), id, why.trim());
      if (r.ok) {
        io.writeErr(`closed ${id} with no reply: ${why.trim()}`);
        continue;
      }
      failed += 1;
      // The system reports every ID, and one failure never hides the rest. A batch that
      // stopped at the first bad ID would leave the others silently untouched.
      io.writeErr(
        r.why === "answered"
          ? `${id} was already answered by ${String(r.answeredBy)}, so there was nothing to close.`
          : `${id} is not an open item for ${name}. \`inbox pending\` lists what is open, and ` +
            `\`inbox trace ${id}\` says whether it ever reached this agent.`,
      );
    }
    return failed === 0 ? 0 : 1;
  }
  if (sub === "trace") {
    const id = positionals[1];
    if (id === undefined || id === "") {
      io.writeErr("inbox trace needs the message id: inbox trace <ts> [--as <name>]");
      return 1;
    }
    const path = inboxPath(slackConfigPath(io), name);
    const app = loadSlackConfig(io)?.agents[name]?.appId;
    io.write(traceReport(readInbox(path), id, name, path, app));
    return 0;
  }
  if (sub !== "pending") {
    io.writeErr(
      `unknown inbox verb: ${sub}. The verbs are: inbox pending, inbox trace <ts>, ` +
        `inbox close <ts> --why <text>`,
    );
    return 1;
  }
  const items = pendingInbox(inboxPath(slackConfigPath(io), name));
  for (const item of items) io.write(JSON.stringify(item));
  if (items.length === 0) return 0;
  io.writeErr(pendingReport(items, name));
  return 1;
}

/**
 *  This path writes a delivered line to stdout and records it. Every delivery
 *  reaches stdout only through this path, so the system cannot hand a line to an
 *  agent without the ledger knowing an answer is owed. The `read` command does not
 *  go through here, because a transcript is distinct from an inbox.
 *
 *  Recording is best-effort and never blocks delivery. An unwritable ledger must
 *  not stop a message from reaching the agent, since the message is the purpose
 *  and the ledger is the accounting. The system reports the write, so an inbox that
 *  quietly counts nothing does not read as an inbox with nothing in it.
 */
function emitDelivery(io: Io, agent: string, line: Record<string, unknown>, addressedOnly = false): void {
  // This agent uses two identities: its scramble name and the Slack handle that a
  // mention resolves to, which differ (`scramble-dev` is mentioned as
  // `scramble_dev`). Comparing against the scramble name alone once caused a real
  // mention to arrive with mentioned:false.
  const conf = loadSlackConfig(io)?.agents[agent];
  const handle = conf?.handle;
  const names = handle === undefined || handle === "" ? [agent] : [agent, handle];
  // The system records every delivered line, whether addressed or unaddressed. Only
  // addressed lines require a reply. The remaining lines provide the record that
  // lets `inbox trace` distinguish "never reached me" from "reached me and woke
  // nothing". Without that second row, the ledger's silence about a message carries
  // two meanings with no way to choose between them, which caused four agents to
  // grep a text log for a timestamp.
  //
  // The system records where the sender runs from the sender's own stamp. The
  // system learns this location passively from any message, whether addressed or
  // unaddressed, since knowing where a peer is does not depend on it talking to
  // you.
  const from = typeof line.from === "string" ? line.from : "";
  const org = line.origin;
  if (from !== "" && from !== agent && typeof org === "object" && org !== null) {
    const o = org as Origin;
    if (typeof o.host === "string" && typeof o.dir === "string") {
      try {
        // This agent writes the row, and the row records `from`. Naming the file after
        // the subject placed every agent on a host into one peer's file.
        recordPeer(peersPath(slackConfigPath(io)), agent, from, o, new Date().toISOString());
      } catch (e) {
        io.writeErr(`peer record not written for ${from}: ${String(e)}`);
      }
    }
  }
  const addressed = isAddressed(line, names, readSent(sentPath(slackConfigPath(io), agent)));
  // The system applies the filter where it computes `addressed`, and downstream
  // grep commands must never perform this check. The script `scripts/inbox.sh`
  // matched the literal `"mentioned":true` against the serialised line. That match
  // works only while the serialiser emits no space after the colon and the field
  // keeps that name. If the serialiser adds a space, reorders fields, or renames the
  // field, the grep stops matching with no error and no exit, so an inbox goes
  // quiet and looks calm. Every agent following JOIN.md inherited this pattern.
  if (!addressedOnly || addressed) io.write(JSON.stringify(line));
  try {
    recordInboxItem(inboxPath(slackConfigPath(io), agent), {
      id: String(line.id ?? line.ts ?? line.seq ?? ""),
      channel: String(line.channel ?? ""),
      from: String(line.from ?? ""),
      ...(typeof line.thread === "string" ? { thread: line.thread } : {}),
      // The line records the names it carried, so `inbox trace` can say why this row
      // belongs to this agent. A verdict without its evidence caused two agents to
      // guess which mention opened six items.
      ...(Array.isArray(line.mentions)
        ? { mentions: line.mentions.filter((m): m is string => typeof m === "string") }
        : {}),
      text: String(line.text ?? "").slice(0, 120),
      at: new Date().toISOString(),
      addressed,
      ...(conf?.appId === undefined || conf.appId === "" ? {} : { app: conf.appId }),
    });
  } catch (e) {
    io.writeErr(`inbox ledger not written for ${String(line.id ?? "")}: ${String(e)}`);
  }
}

/**
 *  EVERYTHING A SEND DOES ONCE SLACK HAS ACCEPTED IT, in one place.
 *
 *  A send performs three actions after Slack accepts the message: it reports what
 *  this send raced with, closes the item it answers, and records its own `ts` so
 *  the system recognizes replies as owed to this agent. Each of these actions was
 *  previously written only on the post path.
 *
 *  This consolidation exists because a send carrying a file takes a different
 *  route: the upload posts the message, which skips the post path and all three
 *  actions. The ledger exposed this behavior when it retained two questions
 *  answered with attachments.
 *
 *  These actions are best-effort and reported, because none of them may turn a
 *  delivered message into a failure. When Slack reports no share for an upload,
 *  `ts` is absent; the close operation still runs against a wall-clock marker
 *  while the system skips the sent record, since an id nobody can look up is worse
 *  than no id.
 */
async function settleSend(
  io: Io,
  channel: string,
  from: string,
  ts: string | undefined,
  thread: string | undefined,
  draft?: {
    hash: string;
    channel: string;
    at: string;
    words?: string[];
    near?: { score: number; ts: string; again?: boolean };
  },
): Promise<void> {
  const s = slackBackend(io);
  // Every agent also runs the send path. An agent that speaks without ever
  // starting a listener would be absent from the record it publishes to every peer.
  recordSelf(io, from);
  try {
    if (s.backend !== undefined) await reportCrossings(io, s.backend, channel, from, ts);
    // BOTH MONITORS, ON EVERY SEND. Arming expires, and the listener check used to
    // sit inside the sweep, where a dead sweep hid its own absence.
    for (const line of monitorReport(io, from)) io.writeErr(line);
    closeInboxItems(inboxPath(slackConfigPath(io), from), channel, ts ?? new Date().toISOString(), thread);
    // The draft carries the timestamp, so the next send of the same words can see
    // this draft and refuse.
    if (ts !== undefined) recordSent(sentPath(slackConfigPath(io), from), ts, draft);
  } catch (e) {
    io.writeErr(`inbox ledger not updated after posting to ${channel}: ${String(e)}`);
  }
}

/**
 *  The guard's name remains short enough for a ledger row. The model's attempt
 *  belongs on the screen and never in a counter.
 */
function guardName(why: string): string {
  return why.slice(0, 120);
}

/**
 *  The command reports what arrived in this channel between the last line this
 *  agent saw and the line it just sent.
 *
 *  The command reports after the send, and that is the only place it can work. Both
 *  collisions were under a minute, 20 and 40 seconds apart as measured by one of
 *  the two agents, because each was already writing when the other posted. Reading
 *  the channel first catches neither. The moment an agent speaks is the first
 *  moment the race is decidable.
 *
 *  The delivery cursor bounds the output, so the command reports what this agent
 *  has not read. It repeats until a `message check` moves that cursor, which
 *  matches the state: those messages are still unread, and a sender about to write
 *  a second message on the same subject wants to know a second time.
 *
 *  Lookup failures are reported and are never fatal. A failed lookup here must not
 *  turn a delivered message into an error, so the system reports what it could not
 *  do and stops.
 */
/**
 *  The send operation limits the number of crossed messages it prints. It counts
 *  the remaining messages and includes the timestamp of the oldest one, since an
 *  unprinted cap reads as full coverage.
 */
const CROSSINGS_CAP = 15;

async function reportCrossings(
  io: Io,
  backend: SlackBackend,
  channel: string,
  from: string,
  ownTs: string | undefined,
): Promise<void> {
  if (ownTs === undefined) return;
  const cursor = readSlackCursor(io, from)[channel];
  const r = await backend.history(channel, cursor, from, false);
  if (r.code !== 0) {
    io.writeErr(`crossings unread for ${channel}: ${r.error ?? "history failed"}`);
    return;
  }
  // Lines produced by this agent are not crossings. Matching solely on the scramble
  // name returned one of the agent's own lines, because history records the Slack
  // handle, and `scramble-dev` posts as `scramble_dev`. This same mismatch
  // previously marked a real mention as unaddressed. The first live run of this
  // report caught the issue.
  const me = backend.identities(from);
  const crossed = r.messages.filter(
    (m) =>
      !me.includes(m.from) &&
      slackTs(m.ts) < slackTs(ownTs) &&
      (cursor === undefined || slackTs(m.ts) > slackTs(cursor)),
  );
  if (crossed.length === 0) return;
  // Order messages newest first, cap the output, and name the remainder. The read
  // cursor advances during a `message check` sweep. An agent that reads through a
  // listener never runs this sweep, so the block printed 165 lines on every send
  // from this agent. Output of that size causes agents to filter the text, which is
  // a defect. The block answers whether someone just made the point, and the newest
  // lines provide that answer.
  const newest = [...crossed].sort((a, b) => slackTs(b.ts) - slackTs(a.ts));
  const shown = newest.slice(0, CROSSINGS_CAP);
  const lines = shown.map((m) => `  ${m.from}: ${(m.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
  if (newest.length > shown.length) {
    const rest = newest.slice(shown.length);
    lines.push(
      `  ${rest.length} older message(s) not listed, back to ${rest[rest.length - 1]!.ts}. ` +
        `\`scramble history ${channel}\` reads them.`,
    );
  }
  // This block uses the same key structure as the read-back block. An agent
  // filtering on `sent:|verify:|REFUSED` saw the count line and none of the
  // messages below it, which make up the block's entire content, and reported this
  // after running overnight.
  io.writeErr(
    `crossed: ${crossed.length} message(s) arrived in ${channel} before yours and you have not read them:\n` +
      `${lines.join("\n")}\n` +
      `If one of them already made your point, or already claimed the work, say nothing further.`,
  );
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
      // The system checks language rules here, where the message leaves, so the sender
      // does not have to track a multi-step chain. The documented chain created a draft
      // file, ran the linter, and sent the message. When the sender piped text straight
      // in all day, the linter ran on nothing. The operator observed a long dash and
      // reported that linting had failed. The linter had not failed; the linter had not
      // run.
      const refusal = languageRefusal(lintLanguage(text));
      if (refusal !== "") {
        io.writeErr(refusal);
        return 1;
      }
      // The system checks length here as well, for the same reason it checks the
      // language rules: a limit the sender has to remember is a limit that holds until
      // the sender is busy. The system needs a message length limit in words, which
      // may be 200 words.
      const tooLong = lengthRefusal(text);
      if (tooLong !== "") {
        io.writeErr(tooLong);
        return 1;
      }
      // By default, an inbox reply posts within the thread that it answers, and a
      // dedicated flag handles posting directly to the channel.
      //
      // The ledger tracks which item in this channel remains unanswered, so the system
      // reads the target thread from the ledger. When an open item exists and the
      // command
      // receives no `--thread` flag, the reply threads under the newest open item that
      // carries the active conversation. When multiple items remain open across
      // threads,
      // the reply closes all of them, since answering in the room resolves the entire
      // room. When nothing is open, the command finds nothing to answer, so it posts at
      // the channel level.
      //
      // The `--top-level` flag provides channel-level posting, and the system reports
      // the chosen thread, because routing a message silently to an unexpected
      // destination already produced a defect today.
      if (flags.get("thread") === undefined && !flags.has("top-level")) {
        const open = pendingInbox(inboxPath(slackConfigPath(io), nameFor(flags, io))).filter(
          (r) => r.channel === req.channel,
        );
        // The system replies in a thread only when one message awaits an answer. When
        // several messages remain open, selecting the newest message is a guess, and an
        // incorrect guess places an answer inside another conversation. In one
        // instance a person asked a question, another agent posted 13 seconds later,
        // and the answer to the question went into that agent's thread. When several messages
        // remain open, the sender knows which message the answer addresses and the
        // ledger
        // does not, so the ledger states this condition and stays at the channel level,
        // where a reader can see what the message is about.
        if (open.length > 1) {
          io.writeErr(
            `posting at channel level: ${open.length} questions are open for you in ${req.channel}, ` +
              `so which thread this answers is yours to name. Pass --thread <ts> for one of them:\n` +
              open.map((r) => `  ${r.id} from ${r.from}: ${r.text.slice(0, 60)}`).join("\n"),
          );
        }
        const newest = open.length === 1 ? open[0] : undefined;
        if (newest !== undefined) {
          const root = newest.thread !== undefined && newest.thread !== "" ? newest.thread : newest.id;
          flags.set("thread", root);
          io.writeErr(
            `replying in thread ${root}, which is where ${newest.from} asked. ` +
              `Pass --top-level to post to the channel itself.`,
          );
        }
      }
      // The `--attach <path>` flag is repeatable. The upload runs inside the send path,
      // after the language check, the duplicate guard, and the rewriter. The process
      // previously returned before any of these stages executed: a send carrying a file
      // printed nothing, checked nothing, and rewrote nothing, so one agent posted an
      // identical draft twice, seven seconds apart, and deleted the copy.
      const attachPaths = collectValues(args, "--attach");
      return postText(req.channel, text, flags, io, backend, undefined, attachPaths);
    }
    case "react": {
      // The `message react --target <channel> --to <ts> --emoji <name>` command adds a
      // reaction, which is an acknowledgement that costs the channel no line.
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
    case "edit":
    case "delete": {
      // Agents can edit and delete messages. An agent edits a message by running
      // `message edit --target <ch> --to <ts>` with the new text on stdin, and deletes
      // a message by running `message delete --target <ch> --to <ts>`.
      //
      // An edit is a send. It passes the language rules and the rewriter the same way,
      // because the channel ends up holding its text either way, and a rule that a
      // second
      // verb walks around is not a rule.
      const req = requireTarget(flags, io);
      if (!req.ok) return 1;
      const to = flags.get("to");
      if (to === undefined) {
        io.writeErr(`message ${sub} requires --to <message-ts>`);
        return 1;
      }
      if (backend !== "slack") {
        io.writeErr(`message ${sub} needs the slack backend`);
        return 1;
      }
      const sb = slackBackend(io);
      if (sb.error !== undefined || sb.backend === undefined) {
        io.writeErr(sb.error ?? "slack backend unavailable");
        return 1;
      }
      const who = nameFor(flags, io);
      if (sub === "delete") {
        const d = await sb.backend.remove(req.channel, to, who);
        if (!d.ok) {
          io.writeErr(`delete failed: ${d.error}`);
          return 1;
        }
        io.writeErr(`deleted: ${req.channel} ts ${to} is gone from Slack.`);
        return 0;
      }
      const raw = await (io.readStdin ? io.readStdin() : Promise.resolve(""));
      if (raw.trim() === "") {
        io.writeErr(`message edit reads the new text on stdin, and stdin was empty.`);
        return 1;
      }
      const refused = languageRefusal(lintLanguage(raw));
      if (refused !== "") {
        io.writeErr(refused);
        return 1;
      }
      const { chosen } = await attemptRewrite(raw, io);
      if ("refuse" in chosen) {
        io.writeErr(chosen.refuse);
        return 1;
      }
      const u = await sb.backend.update(req.channel, to, chosen.send, who);
      if (!u.ok) {
        io.writeErr(`edit failed: ${u.error}`);
        return 1;
      }
      io.writeErr(`edited: ${req.channel} ts ${to} now holds the new text. Slack has it.`);
      if (chosen.note !== "") io.writeErr(`rewrite: ${chosen.note}`);
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

/**
 *  The mirrored `profile` command family provides workspace identity commands.
 *  The `show` command prints this agent's name and persona as one JSON line. The
 *  `update --description <text>` command writes `.scramble/persona.md` and
 *  registers it, acting as the `join --persona` alias, under any backend since
 *  profile is the workspace identity.
 */
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
      /**
       *  The system reports an empty persona if no persona has been written yet.
       */
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

/**
 *  The mirrored `channel` verb `channel join --target <channel>` behaves and reads
 *  exactly as the alias `join <channel>`.
 */
/**
 *  `scramble doctor --as <name>` checks whether an agent's Slack application
 *  satisfies the current requirements of scramble. An agent onboarded before a fix
 *  continues to work in the ways it always did and silently lacks that fix. This
 *  command exists for that failure, because no other mechanism notifies a RUNNING
 *  agent that its configuration went out of date. The command repairs local
 *  settings where possible, updating the handle from auth.test, and reports the
 *  command needed for changes that require a reinstall, such as an updated scope.
 */
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
  // The system reports an advisory and does not fail the verb, because it names
  // something that still works. A problem stops delivery.
  const advisories: string[] = [];
  const fixed: string[] = [];

  // One call answers both questions. auth.test returns the handle in its body and
  // the granted scopes in its x-oauth-scopes header.
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

  // THE SILENT INBOX. Slack accepts an organization installation of an app whose
  // manifest specifies org_deploy_enabled:false without warning. Every REST call
  // works, the socket opens and completes the handshake, and Slack delivers no
  // events, so `listen` runs forever and the agent appears to sit in a quiet
  // channel. The doctor check inspects this condition because doctor is where an
  // agent asks whether its own wake path is real, and because nothing else reports
  // it.
  //
  // AN UNSUBSCRIBED EVENT IS THE SAME SILENCE, reached a different way. Slack sends
  // nothing for an event the app does not request, so an app created before an
  // event was added to the manifest keeps a wake path that is dead for exactly one
  // event and healthy for every other. That is how an invite delivered nothing
  // while mentions kept arriving when the inbox did not fire. One manifest read
  // provides both answers.
  const declared = await declaredManifest(io, name);
  // This login cannot repair an application that it cannot read, so naming the
  // repair command would send the agent to a command that fails on its first call.
  // State who must act.
  const unreadable = declared !== undefined && declared.unreadable !== undefined;
  // The reason an app cannot be read determines who must take action. The tool
  // previously reported that another login owns the app for every failure. When run
  // against an app that the user owns, the command read `token_expired` and told the
  // user to ask the owner or discard the entry. It printed a cause that the evidence
  // never established as fact on an interface an agent trusts to explain failures.
  //
  // A stale CLI token is the ordinary case, and a new token repairs it. The
  // `not_authed` response and the access errors indicate ownership.
  const answer = String(declared === undefined ? "" : declared.unreadable);
  const staleToken = unreadable && /token_expired|invalid_auth|token_revoked/.test(answer);
  const selfExplained = unreadable && declared.selfExplained === true;
  // The system claims ownership only when Slack specifies it. Previously, the
  // `else` branch of an allowlist processed unlisted strings, so the listener
  // printed every string the list missed as an ownership verdict: `token_expired`,
  // then `invalid_refresh_token` from rotation code a day later. A guess in a
  // default branch fails with each new error string, so the default branch states
  // the answer and stops.
  const ownership = unreadable && /no_permission|not_authed|access_denied|app_not_found|invalid_app_id/.test(answer);
  const repair = !unreadable
    ? `Fix: bun scripts/onboard-agent.ts ${name}`
    : selfExplained
      ? ``
      : staleToken
      ? `The credential that expired is the FIRST entry in ~/.slack/credentials.json, which is ` +
        `where the Slack CLI keeps it, and NOT anything in the scramble config. Nothing about who ` +
        `owns the app follows from it. Someone with the Slack app login runs \`slack login\` on ` +
        `THIS host to write a fresh one; until then the scopes and events are simply unchecked.`
      : ownership
      ? `Slack named an access failure, so this login cannot change this app: ask its owner to ` +
        `add them, or drop this agent's entry from the config and let onboard-agent.ts create an ` +
        `app the agent owns.`
      : `Slack's answer above is the whole of what is known, and it names neither a credential ` +
        `nor an access problem, so the cause is UNDETERMINED here. Read that error before acting.`;
  if (unreadable) {
    problems.push(
      `this app's manifest cannot be read by this login (apps.manifest.export answered ` +
        `${declared.unreadable}), so its scopes and events cannot be checked or repaired from ` +
        `here. Whether delivery works at all is unknown, and a working read says nothing about ` +
        `it.${repair === "" ? "" : ` ${repair}`}`,
    );
  }
  if (declared !== undefined && declared.unreadable === undefined) {
    if (body.is_enterprise_install === true && !declared.orgDeploy) {
      problems.push(
        `this app is installed ORG-WIDE (auth.test: is_enterprise_install true) while its ` +
          `manifest declares org_deploy_enabled:false. Slack accepts that combination and ` +
          `delivers NO events for it, so your inbox monitor will sit silent forever while ` +
          `every read still works. ${repair}`,
      );
    }
    const unsubscribed = BOT_EVENT_NAMES.filter((e) => !declared.botEvents.includes(e));
    if (unsubscribed.length > 0) {
      problems.push(
        `this app does not subscribe to ${unsubscribed.join(", ")}. Slack delivers NOTHING ` +
          `for an unsubscribed event, so that news never reaches your inbox while everything ` +
          `else arrives normally. ${repair}`,
      );
    }
  }

  // A listener that is older than the current code runs a build that no longer
  // exists, which looks exactly like a defect that was already fixed.
  //
  // This status is an advisory. A listener on an older commit still delivers, while
  // zero listeners means nothing arrives at all, and this verb reported both
  // conditions with the same weight. An agent stopped restarting on every version
  // bump and created its own grading: an advisory for a commit mismatch, and an
  // alarm only for zero listeners. That grading belongs here, where every reader
  // receives it.
  const staleProblem = staleListenerProblem(staleListeners(io, name), name);
  if (staleProblem !== undefined) advisories.push(staleProblem);

  // An installed agent displays its commit directly on the process line. The
  // launcher executes the resolved commit directory, so a listener carries its
  // version in its own command line. Comparing that command line against the
  // installed version confirms whether the process runs the local code without
  // checking mtimes, which describe the wrong tree for an installed copy. Two agents
  // on one application split its events. Slack delivers a Socket Mode event to one
  // open connection per application, so two consumers on one token halve each
  // other's delivery, silently and at random. A fourth agent measured this exact
  // result: its listener and a second bolt application on the same adopted token
  // split mentions between a consumer that answers and a consumer that discards
  // them, and a human asked the same question twice inside that window.
  //
  // Slack exposes no method to query how many open connections an application has,
  // so this check catches the knowable half where another agent in this configuration
  // points at the same application. A consumer on another machine is invisible here,
  // and `doctor --wake` is the probe that would catch it.
  {
    const cfgNow = loadSlackConfig(io);
    const mine = cfgNow?.agents[name];
    const sharing = Object.entries(cfgNow?.agents ?? {})
      .filter(([other, a]) => other !== name && mine !== undefined && a.appId !== undefined && a.appId === mine.appId)
      .map(([other]) => other);
    if (sharing.length > 0) {
      problems.push(
        `${sharing.join(", ")} share this agent's Slack app (${String(mine?.appId)}). Slack gives each ` +
          `Socket Mode event to ONE connection per app, so listeners for these agents split the ` +
          `same events between them at random: a mention delivered to one is never delivered to ` +
          `the others. Give each agent its own app, or run one listener for all of them.`,
      );
    }
  }

  // A host reports when its process table cannot be read. Both listener checks read
  // /proc, which exists on Linux hosts and is absent on other systems, and both
  // return "nothing wrong" when they cannot inspect the directory. The `ok` status
  // would then mean "checked and fine" on a machine where nothing was checked.
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
    advisories.push(
      `${behind.length} listener(s) for ${name} run a different commit than the installed ${installedNow}: ` +
        `${behind.map((b) => `pid ${b.pid} on ${b.commit}`).join(", ")}. They hold the code they started ` +
        `with, so a fix you installed has not reached them. Stop them and arm the inbox again.`,
    );
  }

  // A host that receives no installations has nothing to disagree with. The
  // staleness notice compares a running listener to the commit installed beside it,
  // so a machine that stops updating stays quiet while it falls behind. One machine
  // fell behind by five commits, with every listener matching its install.
  //
  // A peer's own message carries the commit it ran, so the disagreement is readable
  // here with no git and no network. Determining which side is older requires
  // `git log`, since commit ids carry no order.
  const elsewhere = peersOnOtherCommits(
    readPeers(peersPath(slackConfigPath(io))),
    installedNow,
    agentOrigin(io),
  );
  if (elsewhere.length > 0) {
    const named = elsewhere.slice(0, 3).map((p) => `${p.agent} on ${p.host} ran ${p.commit} at ${p.at}`);
    advisories.push(
      `this host installs ${installedNow} and ${elsewhere.length} peer(s) LAST SPOKE on a different ` +
        `commit: ${named.join("; ")}. Each is the commit that peer ran when it wrote, so one that ` +
        `upgraded without speaking since still shows the old one, and the time beside it says how ` +
        `stale the reading is. Where the difference is real, \`git log\` says which side is behind. ` +
        `A machine nobody installs on never reports staleness, because its listeners match its own ` +
        `install.`,
    );
  }

  // The operator must classify channels. Classification belongs to the operator, so
  // the interface lists channels with no tier and displays the command that sets
  // one. An unclassified channel still sends in the careful register.
  const cfgTiers = loadSlackConfig(io);
  const waiting = unclassified(Object.keys(cfgTiers?.channels ?? {}), cfgTiers?.tiers);
  if (waiting.length > 0) {
    advisories.push(
      `${waiting.length} channel(s) have no register set: ${waiting.join(", ")}. Each one sends in the ` +
        `careful register until somebody runs \`scramble channel tier <channel> internal|external\`, and ` +
        `that call is the operator's to make.`,
    );
  }

  const missing = SCOPE_NAMES.filter((sc) => !granted.has(sc));
  if (missing.length > 0) {
    problems.push(
      `this app is missing ${missing.length} scope(s): ${missing.join(", ")}. ` +
        `A scope needs a reinstall. ${repair}`,
    );
  }

  // The `--wake <channel>` flag is opt-in because it posts a line into that channel.
  const wakeChannel = flags.get("wake");
  if (wakeChannel !== undefined && wakeChannel !== "") {
    // The test does not run when its result would be meaningless. Slack delivers each
    // Socket Mode event to one connection, so an armed listener consumes the probe,
    // causing the test to time out and report the wake path as dead. The test output
    // then instructs the operator to re-onboard, which rotates the bot token and
    // strands that listener. Refusing to run prevents an incorrect failure report on
    // this critical surface.
    const procRootForWake = io.env("SCRAMBLE_PROC") ?? "/proc";
    const holding = stillAlive(liveListeners(readProcesses(procRootForWake), name), procRootForWake);
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
  for (const a of advisories) io.writeErr(`doctor advisory: ${a}`);
  // BOTH MONITORS, IN THE PLACE AN ONBOARDING AGENT LOOKS. `doctor` proved the
  // listener and reported nothing about the sweep, so an agent that armed one of
  // the two read a clean answer.
  for (const line of monitorReport(io, name)) io.writeErr(line);
  // The command reports the rewrite state whether or not anything else is wrong.
  // The state previously sat in the clean line only, so on a host with an expired
  // CLI token, where every other answer is a problem, the system gave no answer to
  // the one question an operator asks while setting it up. Measured here, two doctor
  // runs printed nothing about it because this agent's manifest read fails.
  {
    const rc = rewriteConfig(io.env);
    io.writeErr(
      rc.key === undefined
        ? `doctor: the outgoing rewrite is OFF; set SCRAMBLE_REWRITE_KEY to turn it on.`
        : `doctor: the outgoing rewrite is ON: ${rc.provider} ${rc.model} at ${rc.url}, ${rc.timeoutMs}ms.`,
    );
  }
  if (problems.length === 0) {
    // The clean line must state what was inspected. Plain `doctor` prints `ok`
    // without a listener line on a host where a listener runs and where `--wake`
    // proves the tool sees it. An `ok` that names nothing is indistinguishable from
    // an `ok` that looked at nothing, which is the outcome this whole verb exists
    // to eliminate.
    const seen = stillAlive(liveListeners(readProcesses(procRoot), name), procRoot);
    io.write(
      JSON.stringify({
        doctor: "ok",
        agent: name,
        handle,
        // Inspectors need the exact scope names, because a count such as `scopes: 14`
        // answers no practical question. Pricing a change requires knowing which scopes
        // are granted. When only a count appears, an operator can assume that reading
        // reactions requires a scope change and a reinstall, even though
        // `reactions:read`
        // is already one of the 14 scopes in this repository's own `app-manifest.ts`.
        // The
        // same requirement applies to event names, because the subscribed events decide
        // what Slack delivers. The system also reports whether the rewrite is active
        // and
        // what target it runs against. Turning on the rewrite requires four environment
        // variables read by the sending process, so checking the state without sending
        // a
        // message distinguishes a configured system from a believed-configured system.
        // The report marks the key as present or absent and never prints it.
        rewrite: (() => {
          const rc = rewriteConfig(io.env);
          return rc.key === undefined
            ? { on: false }
            : { on: true, provider: rc.provider, model: rc.model, url: rc.url, timeoutMs: rc.timeoutMs };
        })(),
        scopes: [...granted].sort(),
        events: declared !== undefined && declared.unreadable === undefined ? [...declared.botEvents].sort() : null,
        listeners: seen.length,
        // THE SWEEP GETS A FIELD OF ITS OWN, because a payload that proves the
        // listener and says nothing about the timed sweep reads as both monitors
        // being fine. An agent onboarded, ran the listener alone, and found the gap
        // only when somebody told them. The number is the age in minutes of the
        // newest cursor entry, which only a completed sweep writes, and `null` means
        // no sweep has ever run for this agent.
        sweep_minutes_ago: sweepAgeMinutes(io, name) ?? null,
        installed: installedNow === "" ? null : installedNow,
        // The peer record provides its own health as a field a monitor can read. Six
        // agents append to that file on one host. One agent found a line no parser
        // could
        // read, and the agent that armed a watcher for it wrote its own parse loop. Two
        // definitions of `damaged` disagree the day the row shape changes, and a
        // monitor that greps the prose sentence breaks on a rewording, which is the
        // trap
        // this repository removed from its wake filter.
        peer_record: (() => {
          const read = readPeerFile(peersPath(slackConfigPath(io)));
          return { rows: read.rows.length, damaged: read.damaged };
        })(),
      }),
    );
    return 0;
  }
  return 1;
}

/**
 *  `doctor --wake` proves that the wake path delivers a message. Proving that the
 *  socket connects settles nothing, since a listener whose socket delivers nothing
 *  is indistinguishable from a quiet channel. An operator armed a monitor, watched
 *  the process stay alive, and reported the service working while it delivered
 *  nothing for hours (postmortem: akrust log/postmortems/
 *  `-armed-a-monitor-without-proving-it-receives.md`).
 *
 *  The command opens the socket, posts one probe line, and requires the frame for
 *  that exact timestamp to return. The probe uses the agent's own message by design:
 *  the check needs no second identity, and the socket carries an application's own
 *  posts even though `listen` filters them out of delivery, so this tests the
 *  transport without requiring another user to type.
 */
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
  // Buffer the frames. Checking each frame against the awaited timestamp loses the
  // race when Slack echoes the post back before `chat.postMessage` returns that
  // timestamp. A test caught this outcome: the frame arrives before the code knows
  // what to look for, and a live path reports itself dead.
  const frames: string[] = [];
  socket.onmessage = (data) => {
    frames.push(data);
  };
  // Wait for the socket to complete its handshake before posting the probe, or the
  // frame can be missed and a healthy path reported as dead.
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

/**
 *  When an agent's `listen` process starts before the newest source file, that
 *  process runs code that no longer exists. Twice this mismatch caused a visible
 *  defect that the code had already fixed: an agent delivered its own posts for
 *  minutes after the self-filter shipped, and continued posting `working` messages
 *  after the living message was deleted. A merged fix does not reach a running
 *  process, and no message stated this fact.
 *
 *  The check reads `/proc`, so it returns undefined where `/proc` is absent.
 */
export function staleListeners(io: Io, agent: string): Array<{ pid: string; ageBehind: number }> | undefined {
  const newest = newestSourceMs(io);
  if (newest === undefined) return undefined;
  return pickStale(readProcesses(io.env("SCRAMBLE_PROC") ?? "/proc"), agent, newest);
}

/**
 *  The workspace reports the newest modification time among its sources, or
 *  undefined when there is no `src` to compare against.
 */
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

/**
 *  This component returns every process running on the host as
 *  `(pid, cmdline, startedMs)`. It reads `/proc` and returns an empty list where
 *  `/proc` is absent, so the decision logic below stays pure and testable while the
 *  reading logic stays thin.
 */
/**
 *  Can this host's process table be read at all?
 *
 *  `readProcesses` returns an empty list both when no process matches and when
 *  /proc is missing. The doctor command cannot distinguish between those two
 *  cases: on a host without /proc, it printed `doctor: ok` having inspected no
 *  listener at all, so the agent reading that output was told its listeners are
 *  fine when nothing inspected them. Anything that is about to run on other machines
 *  needs these outcomes separated.
 */
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
      // When a process exits between the listing and the read, the process is gone.
    }
  }
  return out;
}

/**
 *  The doctor tool reports details about stale listeners, or returns undefined
 *  when there is nothing to say. The message is separated from the finding so the
 *  sentence an operator acts on has its own test.
 */
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

/**
 *  The launcher on PATH reads the commit that it would run now from the COMMIT
 *  file of the directory `current` resolves to. The value is empty when nothing is
 *  installed, which makes every comparison against it a no-op.
 */
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

/**
 *  This value records the commit a listener is running, taken directly from its
 *  own command line.
 *
 *  The installed launcher executes the resolved commit directory, so a long-lived
 *  process carries its version where anyone can read it. The value is empty for a
 *  listener started from a checkout, which has no commit to name and is the case
 *  worth reporting differently.
 *
 *  This supersedes estimation from file modification times for installed agents.
 *  Modification times compare a process against whatever `src` happens to sit in
 *  the current directory, which differs from the code that an installed agent
 *  loaded.
 */
export function listenerCommit(cmd: string): string {
  const m = /\/scramble\/([0-9a-f]{7,40})\/src\/bin\.ts/.exec(cmd);
  return m?.[1] ?? "";
}

/**
 *  This mapping reports listeners for this agent running a commit different from
 *  the one installed now, formatted as `pid → commit`. The mapping is empty when
 *  nothing is behind. It omits a listener with no commit in its command line
 *  because that listener is a checkout, which the stale mtime check already
 *  reports.
 */
export function listenersBehind(
  procs: Array<{ pid: string; cmd: string }>,
  agent: string,
  installed: string,
): Array<{ pid: string; commit: string }> {
  if (installed === "") return [];
  return procs
    .filter((p) => isListenerProc(p.cmd, agent))
    .map((p) => ({ pid: p.pid, commit: listenerCommit(p.cmd) }))
    .filter((p) => p.commit !== "" && p.commit !== installed);
}

/**
 *  This check finds every live listener for the agent regardless of its age.
 *  The implementation remains pure and separate from `pickStale` because each
 *  evaluates a different condition: `pickStale` identifies which listeners run
 *  outdated code, whereas this logic checks whether any process holds the socket
 *  at all.
 *
 *  `doctor --wake` requires this check. Slack delivers each Socket Mode event to
 *  one connection, so an armed listener consumes the probe frame, causing the
 *  socket opened by `doctor` to wait out its timeout and report that the wake path
 *  is dead. In testing, running `doctor --wake` with an armed inbox produced the
 *  output "The wake path is DEAD" and advised re-onboarding, which rotates the bot
 *  token. Running the same command with the inbox stopped and no other changes
 *  returned `"delivered":"1787365205.175139"`. Following that instruction would
 *  have rotated a working token and stranded the listener.
 */
/**
 *  The check verifies which of these process IDs still exist right now.
 *
 *  A listener count provides a snapshot, and the most sensitive command acts on
 *  it: `doctor --wake` refuses to probe while a listener holds the socket. An
 *  agent terminated its listener, ran doctor, and encountered a refusal citing
 *  the PID of a process that had already exited. A refusal that names a dead PID
 *  sends an operator searching for a process to stop, and the withheld probe
 *  would have worked.
 *
 *  This check does not close the race window, since nothing can: a process can
 *  exit one microsecond after the check. It shrinks the window from the full
 *  doctor run, which makes network calls, to the instant of the report.
 */
export function stillAlive(pids: string[], root = "/proc"): string[] {
  return pids.filter((pid) => {
    try {
      return statSync(`${root}/${pid}`).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 *  Determining whether a process is a scramble listener when command-line
 *  arguments contain matching words.
 *
 *  A substring match over `/proc` matches every process whose arguments contain the
 *  search terms. The commands most likely to carry these terms are inspection tools
 *  such as `grep`, `pgrep`, and shell one-liners. Debugging shells matched the scan
 *  during testing. Supplying an empty `/proc` passed the tests, which left the
 *  detector matching unrelated processes on other systems.
 *
 *  Inspecting `argv[0]` identifies the listener. A listener runs under `bun`. A
 *  shell or inspection tool that holds the same words has an `argv[0]` of `bash`,
 *  `sh`, `grep`, or `pgrep`.
 */
function isListenerProc(cmd: string, agent: string): boolean {
  if (!cmd.includes("bin.ts listen") || !cmd.includes(`--as ${agent}`)) return false;
  const argv0 = cmd.trim().split(/\s+/)[0] ?? "";
  const exe = argv0.split("/").pop() ?? "";
  return exe === "bun" || exe === "node";
}

/** How long ago this agent's timed sweep last ran, in minutes, or undefined when
 *  no sweep has ever written a cursor.
 *
 *  THE SWEEP'S OWN RECORD IS ITS CURSOR. Every `message check` writes the newest
 *  timestamp it read per channel, so the newest of those values is the last moment
 *  a sweep completed. A monitor that died leaves that value where it was, which is
 *  the difference between "armed" and "still running". */
export function sweepAgeMinutes(io: Io, agent: string, nowMs = Date.now()): number | undefined {
  // THE FILE'S MTIME IS WHEN THE SWEEP RAN. The timestamps INSIDE it are the newest
  // messages it read, which is a different fact: an agent measured a sweep that had
  // finished 42 seconds earlier while this field said 38 minutes, because their
  // channels had been quiet for half an hour. Reading the contents turns a quiet
  // channel into a dead monitor and trains everybody to ignore the line.
  //
  // Every run writes the cursor file, including a run that delivered nothing, so the
  // mtime moves whenever a sweep completes.
  try {
    // `Math.round` OF A TINY NEGATIVE IS -0, which fails a comparison against 0. A
    // file written microseconds ago, or a clock that stepped back, produces it.
    const minutes = Math.round((nowMs - statSync(cursorPath(io, agent)).mtimeMs) / 60000);
    return minutes === 0 ? 0 : minutes;
  } catch {
    return undefined;
  }
}

/** What the two monitors look like right now, one line each, from the primary
 *  record of each.
 *
 *  THIS RUNS ON THE SEND, because the listener check used to live inside the sweep:
 *  a dead sweep hid its own absence, and an agent learned nothing until somebody
 *  else noticed. Every agent sends messages, so the send is where both states
 *  reach the agent.
 *
 *  ARMING EXPIRES. An agent that completed onboarding hours ago can hold a dead
 *  monitor: one sweep exited with code 144 and no error text, and its own log ended
 *  with two ordinary drains. A completed step proves nothing about now. */
export function monitorReport(io: Io, agent: string, nowMs = Date.now(), staleAfterMinutes = 30): string[] {
  const out: string[] = [];
  const procRoot = io.env("SCRAMBLE_PROC") ?? "/proc";
  // ONE COMMAND IS THE REPAIR FOR EITHER MONITOR, since the listener sweeps on its
  // own timer. This line used to name a second command for the sweep, and agents
  // onboarded with one of the two.
  const arm = `Arm both: scramble listen --addressed --as ${agent}`;
  const listenerLive = processesReadable(procRoot) ? liveListeners(readProcesses(procRoot), agent).length > 0 : undefined;
  if (listenerLive === false) {
    out.push(`monitors: NO listener is running for ${agent}, so nothing wakes this agent and no sweep runs. ${arm}`);
  }
  const age = sweepAgeMinutes(io, agent, nowMs);
  const sweepMinutes = Math.round(SWEEP_INTERVAL_MS / 60_000);
  // A RUNNING LISTENER CHANGES WHAT A MISSING SWEEP MEANS. Told to arm something that
  // is already armed, an agent starts a second listener; the true reading is that the
  // sweep inside the running one is failing, and its errors are on that listener's
  // stderr. The other side of the branch names no process state, because an
  // unreadable process list is not a listener that is absent.
  if (age === undefined) {
    out.push(
      listenerLive === true
        ? `monitors: no sweep has ever completed for ${agent}, though a listener is running. Its first sweep lands ` +
            `within ${sweepMinutes} minutes; past that, the sweep inside it is failing and says why on its stderr.`
        : `monitors: no timed sweep has ever run for ${agent}, so ordinary traffic and the lines you owe never ` +
            `surface. ${arm}`,
    );
  } else if (age > staleAfterMinutes) {
    out.push(
      listenerLive === true
        ? `monitors: the last sweep for ${agent} finished ${age} minute(s) ago, past the ${staleAfterMinutes}-minute ` +
            `mark, while a listener runs, so the sweep inside it is not completing. Its stderr says why.`
        : `monitors: the last sweep for ${agent} finished ${age} minute(s) ago, past the ${staleAfterMinutes}-minute ` +
            `mark, so its monitor may have died. ${arm}`,
    );
  }
  return out;
}

export function liveListeners(
  procs: Array<{ pid: string; cmd: string; startedMs: number }>,
  agent: string,
): string[] {
  return procs.filter((p) => isListenerProc(p.cmd, agent)).map((p) => p.pid);
}

/**
 *  The check identifies which listeners for this agent predate the code. The logic
 *  is pure, so the harness tests the rule without spawning anything.
 */
export function pickStale(
  procs: Array<{ pid: string; cmd: string; startedMs: number }>,
  agent: string,
  newestSourceMs: number,
): Array<{ pid: string; ageBehind: number }> {
  // The `--as <agent>` flag matches the specific agent argument, which is narrower
  // than matching the name anywhere in the command line. A bare substring match
  // reported every listener as belonging to every agent whenever an agent name also
  // appeared in the checkout path. This occurs routinely: naming an agent after the
  // product makes every process running from the product directory match that
  // agent. In measured testing, doctor listed the same three process IDs under two
  // agents and directed the operator to restart foreign listeners. A detector that
  // emits false alarms is worth less than no detector, since the operator stops
  // reading it.
  return procs
    .filter((p) => isListenerProc(p.cmd, agent) && p.startedMs < newestSourceMs)
    .map((p) => ({ pid: p.pid, ageBehind: Math.round((newestSourceMs - p.startedMs) / 1000) }));
}

/**
 *  The agent checks what the app declares: whether the app deploys org-wide, and
 *  which events it subscribes to. The agent reads these values from the app's own
 *  manifest through the Slack CLI credential, which is the only token that can
 *  export it. The agent completes this in one call because both answers come from
 *  the same document. The call returns undefined when that credential is absent,
 *  so a host without it reports nothing.
 */
async function declaredManifest(
  io: Io,
  agent: string,
): Promise<
  | { orgDeploy: boolean; botEvents: string[]; unreadable?: undefined }
  | { unreadable: string; selfExplained?: boolean }
  | undefined
> {
  const home = io.env("HOME");
  if (home === undefined || home === "") return undefined;
  let appId = "";
  const path = credentialsPath(home);
  let fileText: string;
  try {
    fileText = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  // Rotating the app-config token saves an operator from manual intervention twice a
  // day. The token lasts twelve hours, neither host renewed it, and doctor failed the
  // manifest check every night as a result. The entry carries a `refresh_token`.
  //
  // A missing credential leaves the check undecided, exactly as it did before
  // rotation existed: an agent without the Slack CLI installed remains functional. A
  // credential that exists and cannot be used creates an error, which is how the
  // expired token surfaced initially.
  if (!firstCredential(fileText).ok) return undefined;
  const cred = await freshCliToken(
    fileText,
    path,
    (u, init) => io.fetch(u, init),
    Math.floor(Date.now() / 1000),
    new Date().toISOString(),
  );
  // The credential report already identifies the actor, so doctor must not append a
  // guess to it. The tool appended the ownership sentence to `invalid_refresh_token`
  // on the first live run of this code, which is the same incorrect cause that the
  // ownership branch printed for `token_expired` a day ago.
  if (!cred.ok) return { unreadable: cred.why, selfExplained: true };
  const cliToken = cred.token;
  if (cred.rotated) io.writeErr(`doctor: the Slack app-config token was expired and has been rotated in ${path}.`);
  const cfg = loadSlackConfig(io);
  if (cfg === null) return undefined;
  // Specify the agent being checked by name. The first version of this check used
  // the last appId in the configuration, so a healthy agent's manifest answered for
  // a broken agent and doctor cleared an application whose inbox was dead. Its own
  // control caught it.
  appId = cfg.agents[agent]?.appId ?? "";
  if (appId === "") return undefined;
  const r = await io.fetch("https://slack.com/api/apps.manifest.export", {
    method: "POST",
    headers: { authorization: `Bearer ${cliToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId }),
  });
  const j = (await r.json()) as {
    ok?: boolean;
    error?: string;
    manifest?: {
      settings?: { org_deploy_enabled?: boolean; event_subscriptions?: { bot_events?: string[] } };
    };
  };
  // An application that this login does not own returns `no_permission`, which
  // is distinct from "no credential here". When a fourth agent onboarded onto
  // an application owned by another account, `doctor` instructed it to run
  // `onboard-agent.ts`. That script fails on its first call because the repair line
  // assumes the agent owns the application.
  if (j.ok !== true) return { unreadable: String(j.error ?? "unknown") };
  const settings = j.manifest?.settings;
  return {
    orgDeploy: settings?.org_deploy_enabled === true,
    botEvents: settings?.event_subscriptions?.bot_events ?? [],
  };
}

async function cmdChannel(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const sub = positionals[0];
  // The `channel tier <channel> internal|external` command writes the
  // classification chosen by the operator. The operator classifies channels
  // manually because hand-editing the shared JSON introduces syntax errors like
  // stray commas at midnight.
  if (sub === "tier") return setChannelTier(positionals[1], positionals[2], io);
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

/**
 *  Write one channel's register into the configuration file that agents on this
 *  host share.
 *
 *  The command reads the file, changes the target key, and writes the contents
 *  back, so every other entry survives. Printing the complete map afterward serves
 *  as a read-back so the operator can inspect what the file records for every
 *  channel directly from the file.
 */
function setChannelTier(channel: string | undefined, tier: string | undefined, io: Io): number {
  if (channel === undefined || (tier !== "internal" && tier !== "external")) {
    io.writeErr(`usage: scramble channel tier <channel> internal|external`);
    return 1;
  }
  const path = slackConfigPath(io);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    io.writeErr(`channel tier: cannot read ${path}: ${String(e)}`);
    return 1;
  }
  const tiers =
    typeof raw.tiers === "object" && raw.tiers !== null && !Array.isArray(raw.tiers)
      ? { ...(raw.tiers as Record<string, string>) }
      : {};
  tiers[channel] = tier;
  raw.tiers = tiers;
  try {
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  } catch (e) {
    io.writeErr(`channel tier: cannot write ${path}: ${String(e)}`);
    return 1;
  }
  io.write(JSON.stringify({ channel, tier, tiers }));
  io.writeErr(`channel tier: ${channel} is ${tier} in ${path}, and every agent on this host reads it.`);
  return 0;
}

/**
 *  On the Slack backend, an app cannot join a channel on its own, because a member
 *  must invite it to a public or private channel. Therefore, `channel join` reports
 *  whether the invite has happened, and it prints the invite line when the invite
 *  has not occurred. It never writes to the local daemon, which is not running under
 *  this backend.
 */
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

/**
 *  The run selects its backend by precedence. The `--backend <name>` flag takes
 *  the highest precedence, followed by the `SCRAMBLE_BACKEND` environment
 *  variable. If neither is given, the run follows the configuration on disk: the
 *  presence of a Slack configuration selects Slack, and its absence selects the
 *  local daemon. When an unknown backend name is provided, the run reports an error
 *  to stderr that names the two existing backends and returns null.
 *
 *  The system previously defaulted to local regardless of what was configured.
 *  Because the local backend answers from a store that the listener fills, a Slack
 *  agent that omitted the environment variable received a transcript where an
 *  error belonged. Running `message read` on a channel it had just been invited to
 *  printed nothing and exited 0 while Slack held twenty messages in it, and the
 *  same read of a busy channel returned whatever the store happened to have cached.
 *  An empty answer that looks like a quiet channel must be impossible to construct,
 *  so the default now comes from the file that decides the rest of the Slack agent
 *  configuration.
 */
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

/**
 *  The tool prints each verb on its own line for `--help` and for an unknown verb,
 *  so a reader learns what exists from the tool itself.
 */
const USAGE = [
  "scramble <verb> [--as <agent>] [--target <channel>]",
  "",
  "  message send      --target <channel>            the message on stdin",
  "                    [--again]                     send a draft you already sent to that channel",
  "                    [--verify]                    read the message back and report what Slack stored",
  "  message read      --target <channel> [--after N]",
  "  message check                                   drain what arrived, and what you owe",
  "  message react     --target <channel> --to <ts> --emoji <name>",
  "  message edit      --target <channel> --to <ts>  the new text on stdin",
  "  message delete    --target <channel> --to <ts>  remove a message you posted",
  "  inbox pending                                   lines addressed to you with no reply",
  "  peers             [--same-dir]                 who else is running, on which host, in which dir",
  "  rewrite           [<file>] [--why]              what the rewriter makes of this text, or with",
  "                                                  --why, what is wrong with it; sends nothing",
  "  rewrites          [--as <agent>]                what the rewriter did on this host, by outcome",
  "  rewrites --replay [--limit N] [--why <text>]    the drafts a guard refused, run again under this",
  "                                                  build, each old verdict beside its new one",
  "  inbox trace <ts>                                did that message reach you, and wake you",
  "  inbox close <ts>… --why <text>                 settle items the sender said need no reply",
  "  lint <file>...    [--comments]                  the send's language rules, on any file;",
  "                                                  --comments reads only a source file's comments",
  "  listen            [--addressed]                 stream deliveries, one JSON line each",
  "  next              [--timeout N]                 one delivery, then exit",
  "  doctor            [--wake <channel>]            is this agent's wiring real",
  "  version                                         which copy is running",
  "  channel join      --target <channel>            has the invite landed",
  "  channel tier <channel> internal|external        which register agents use there",
  "  profile show | profile update --description <text>",
  "  attachment view   --id <file-id>",
  "  serve             [--bind <addr>]               the local daemon",
  "",
  "  --as <agent> names the agent. WITHOUT it, the name defaults to this",
  "  directory's basename, which is why `doctor --help` once answered",
  "  `no agent \"mbench3d\"`: --help was an unknown flag, and the fallback made a",
  "  working directory into an agent name (remote agent).",
].join("\n");

export async function main(argv: string[], raw: Io): Promise<number> {
  // The handler keys every diagnostic at the single point where all diagnostics
  // pass through. This includes both streams: `rewrites --near` writes its
  // histogram to stdout, and wrapping only stderr left that block unkeyed while
  // every other block went out keyed. A JSON line declares no key and passes
  // through byte for byte.
  const io: Io = {
    ...raw,
    write: (line: string) => raw.write(autoKey(line)),
    writeErr: (line: string) => raw.writeErr(autoKey(line)),
  };
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.write(USAGE);
    return 0;
  }
  // Every verb reports a misspelled override. An override that misses appears
  // exactly like a clean result, and an agent nearly filed a bug on that.
  {
    const note = io.envNames === undefined ? "" : unknownEnvNote(io.envNames());
    if (note !== "") io.writeErr(note);
  }
  const backend = selectBackend(argv, io);
  if (backend === null) return 1;
  // Every `scramble` invocation clears expired data before it performs its own
  // work, regardless of which verb it runs. The caller awaits this step so a
  // short-lived verb finishes writing the expiry sweep to the ledger before the
  // process exits. Setting `SCRAMBLE_STATUS=off` makes this operation a no-op.
  await settleStatus(statusTracker(io, backend, nameFor(parseArgs(argv.slice(1)).flags, io))?.clearExpired());
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
    case "peers":
      return cmdPeers(argv.slice(1), io);
    case "rewrite":
      return cmdRewrite(argv.slice(1), io);
    case "rewrites":
      return cmdRewrites(argv.slice(1), io);
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
