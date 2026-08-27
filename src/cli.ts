// src/cli.ts: the agent-facing CLI. Every command prints ONE JSON line per
// message to stdout and sends all diagnostics to stderr. All IO flows through
// the injected `io` seams so tests drive main() with a fake io and the
// in-process handler from src/server.ts as fetch, with no child process, no
// socket and no real delay. Process argv and the real daemon bind live in
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

/** How long a draft counts as already sent. Ten minutes covers the retry an
 *  agent makes after reading a warning as a failure, and it is short enough that
 *  saying the same thing again in a later conversation goes through. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/** How many cited timestamps one send checks. A message carrying an evidence
 *  table cites a handful; a cap keeps a long one from spending twenty API calls
 *  after the message has already gone out. What it skips is printed. */
const CITED_TS_CAP = 6;
import {
  chooseText,
  composePrompt,
  citedTimestamps,
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
  readSentRows,
  recordSent,
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
  /** stdout: carries JSON message lines ONLY (one line per call). */
  write(line: string): void;
  /** stderr: diagnostics only. Message lines go to stdout. */
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
  /** This machine's hostname, for the origin an agent publishes on its messages.
   *  A seam so a test is deterministic, and absent means this build publishes no
   *  origin at all. */
  hostname?(): string;
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

/** Flags that take NO value. Without this list the parser eats the next word as
 *  the flag's value, so `lint --comments a.ts b.ts` silently linted only b.ts:
 *  the file it was asked about first became the value of `--comments`. Any
 *  value-less flag followed by a positional has that shape. */
const BOOLEAN_FLAGS = new Set([
  "again",
  "comments",
  "dates",
  // `--why` is NOT here: `inbox close --why <text>` takes the reason it stores
  // on every row. `scramble rewrite --why` reads its own argv, so both work.
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
 * BESIDE THE CONFIG for the slack backend, because the cursor belongs to the
 * AGENT and not to whatever directory it was invoked from. Keyed by cwd, the
 * same agent sweeping from two places has two cursors and re-drains whole
 * channels: moving a sweep monitor onto the installed CLI changed its cwd, and
 * the next sweep re-delivered the entire history of two channels, hundreds of
 * lines, until the harness suppressed it for rate.
 *
 *  The local backend keeps its cwd-relative file, since a local daemon's store
 *  is per workspace. When the config-side file is absent and a cwd one exists,
 *  the cwd one is read, so an existing agent does not re-drain once on upgrade. */
function cursorPath(io: Io, agent: string, forWrite = false): string {
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
  // MIGRATION, and READ ONLY. The cwd copy is what this agent used before, so it
  // is read while no per-agent file exists yet; the WRITE goes to the per-agent
  // path regardless, which is what ends the coupling. Returning the cwd path for
  // writes too would keep every existing agent on a cwd-keyed cursor forever,
  // and the whole defect was that the cwd is not a property of the agent.
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
    // READ FROM WHERE THE VALUES ARE, which on a first write after migration is
    // still the old file: reading the new (absent) one would drop every cursor
    // this agent already had and re-drain everything exactly once.
    j = JSON.parse(readFileSync(cursorPath(io, name), "utf8")) as Record<string, number>;
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
/** The register a channel calls for, set by the operator.
 *
 * The operator: "Channel classification should be manually done by the
 * operator." I had built this from the membership, counting people against
 * agents, and the ruling came the same hour. A channel with no entry gets the
 * careful register and a line naming the command that sets one. */
function channelTier(channel: string, io: Io): { tier: Tier; why: string } {
  return tierFor(channel, loadSlackConfig(io)?.tiers);
}

/** The rewrite attempt, with its one retry: the model's answer put through the
 *  guards, and asked again with what it broke.
 *
 *  `postText` calls this on the way to Slack and `scramble rewrite` calls it
 *  with nowhere to send, so the preview an author reads is the same code path
 *  their message takes. A preview built from a second copy of these steps would
 *  drift away from the send and lie about it. */
async function attemptRewrite(
  text: string,
  io: Io,
  register?: string,
): Promise<{ chosen: RewriteChoice; retried: boolean; retriedWhy?: string; configured: boolean }> {
  const cfg = rewriteConfig(io.env);
  const template = cfg.key === undefined ? undefined : readPromptTemplate(io.moduleDir ? io.moduleDir() : "src");
  // A CALL THAT NEVER ANSWERED IS TRIED ONCE MORE. Measured on my own send: the
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
        ? chooseText(text, await ask(composePrompt(template.text, text, register)))
        : chooseText(text, { ok: false, why: template.why });
  // ONE MORE ATTEMPT, WITH WHAT IT BROKE. Every guard fires on something the
  // MODEL did, so the model is the party that can fix it, and the author is
  // left holding a refusal for a mistake somebody else made. Two agents wrote
  // prose that avoided a banned form on purpose, watched the rewriter put it
  // back, and sent nothing.
  if ("refuse" in chosen && chosen.retry !== undefined && template !== undefined && template.ok) {
    const why = guardName(chosen.why);
    io.writeErr(`rewrite: ${chosen.retry} Asking once more.`);
    return {
      chosen: chooseText(text, await ask(`${composePrompt(template.text, text, register)}\n\n${chosen.retry}`)),
      retried: true,
      retriedWhy: why,
      configured: true,
    };
  }
  return { chosen, retried: false, configured: template !== undefined };
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
  // WHAT THE AUTHOR TYPED, kept before the rewriter replaces it. The duplicate
  // check hashes this, since one draft rewrites differently every run.
  const draft = text;
  const postRefusal = languageRefusal(lintLanguage(text));
  if (postRefusal !== "") {
    io.writeErr(postRefusal);
    return 1;
  }
  // THE SAME DRAFT INTO THE SAME CHANNEL, TWICE, IS REFUSED, and this runs
  // BEFORE the rewriter. Measured after the `posted:` line shipped: two
  // byte-identical copies 27 seconds apart reached a third agent's inbox. An
  // agent asked for this shape in these words: "A retry after a genuine post
  // must be a no-op, for example by setting an idempotency key on the draft
  // hash".
  //
  // The DRAFT is hashed, since one draft rewrites differently every run, so a
  // digest of the posted text would let every duplicate through. `--again` sends
  // it anyway, for the case where saying the same thing twice is the intent.
  const sender = nameFor(flags, io);
  const digest = createHash("sha256").update(draft).digest("hex").slice(0, 16);
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
  }
  // A MODEL REWRITES WHAT GOES OUT, when one is configured. Asked for directly:
  // "For every sentence gone through scramble message, using Gemini 3.7 flash to
  // rewrite it to professional product and technical communication standards."
  //
  // My objection was that a rewriter can change what a claim SAYS. The answer
  // that settled it: an agent that already publishes wrong claims gets no new
  // failure mode from this, so the argument reduces to "rewriting does not fix
  // that".
  //
  // The message ALWAYS goes: a missing key, a timeout or a bad answer costs the
  // rewrite. Nothing changes silently: when a rewrite is sent, the sender's own
  // words are printed beside it. And the rewrite passes the same rules the
  // sender's words did, or it is dropped in favour of the words that passed.
  // THE CHANNEL DECIDES THE REGISTER, and the operator decides the channel:
  // "Channel classification should be manually done by the operator". The
  // matching block rides on the instruction the model already gets, and a
  // channel with no tier gets the careful one. SAID ONLY WHERE IT ACTS. With no
  // model configured there is no rewrite to carry a register, and the line
  // would sit ahead of whatever the send reports next, including a failure.
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
  // A REWRITE THAT CANNOT BE USED STOPS THE SEND. The author's own words used to
  // go out here, which published exactly the prose the rewrite exists to
  // replace.
  // ONE ROW PER SEND THAT MET THE REWRITER. Every claim about whether the
  // rewriter helps has been a single case somebody remembered, on a feature now
  // running on every send from two hosts.
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
    // SLACK HAS THE MESSAGE. Said first, said always, with the ts, because
    // everything printed after this point is a note about the message, and an
    // agent that reads a note as a failure sends again.
    //
    // MEASURED THE SAME HOUR: one agent posted a reply twice after the CLI
    // printed only the unread-messages warning, and another posted the same
    // progress report FIVE times because a stale read-back convinced them
    // nothing had gone out (ts 1787715115 / 1787715130 and 1787715280 through
    // 1787715629). Neither output ever said the word posted.
    io.writeErr(
      `posted: ${channel} at ts ${r.ts ?? "unknown"}${r.thread === undefined ? "" : ` in thread ${r.thread}`}. ` +
        `Slack has it. Anything below is a note about the message, and NONE of it means resend.`,
    );
    // A post that arrived somewhere other than where it was aimed is REPORTED.
    // A clean exit says nothing about where it went.
    if (r.problem !== undefined) io.writeErr(`slack: ${r.problem}`);
    // `--verify` READS THE MESSAGE BACK. A send's exit code says Slack accepted
    // something; it says nothing about what the channel holds. Between the two
    // sit the rewriter, mention conversion, and Slack's own formatting. Three
    // agents wrote their own read-back wrappers today, and one asked me to own
    // this one.
    //
    // On a difference it prints the STORED TEXT WHOLE, at that agent's request:
    // a line diff is useless when the rewriter rephrases throughout, since every
    // line reports as changed.
    // VERIFIED BY DEFAULT WHERE THE REWRITE IS ON. A rewritten send posts text
    // the author never saw, so the question "what does the channel hold" applies
    // to every one of them, and three agents wrote their own read-back wrapper
    // for exactly that. A flag people have to remember is a check that holds
    // until they are busy, which is the argument that put the language rules in
    // the send.
    //
    // `--no-verify` skips it, and `--verify` asks for it where the rewrite is
    // off.
    const verifying = flags.has("no-verify")
      ? false
      : flags.has("verify") || rewriteConfig(io.env).key !== undefined;
    // ONE FORM BOTH SIDES ARE PUT INTO before the comparison: the broadcast
    // entity rendered the way a reader sees it, Slack's escapes undone, and the
    // edges trimmed.
    const readerForm = (t: string): string => unescapeSlack(readerBroadcasts(t)).trim();
    if (verifying) {
      if (r.ts === undefined) {
        io.writeErr(`verify: slack returned no ts for this message, so nothing can be read back.`);
      } else {
        // THE ROOT SLACK CHOSE: a thread_ts naming a reply
        // is hoisted into that reply's root, and the read-back has to ask about
        // the root that holds the message.
        const stored = await s.backend.storedMessage(channel, r.ts, from, r.thread ?? thread);
        if (!stored.ok) {
          io.writeErr(`verify: could not read the message back: ${stored.error}`);
          // COMPARED IN THE READER'S FORM ON BOTH SIDES. The read-back renders
          // `<!channel>` as `@channel` and undoes Slack's `&lt;`, so a draft
          // written with either form read back as a difference and this line
          // printed DIFFERS twice over messages Slack held exactly. A verify that
          // cries wolf is a verify agents learn to skip.
        } else if (readerForm(stored.text) === readerForm(text)) {
          // A MENTION IS LIVE WHEN SLACK MADE AN ENTITY OF IT. A name that
          // failed to convert sits in the text and notifies nobody, so a count
          // taken from the text would have called it live.
          const silent = mentionsIn(text).filter((m) => !stored.mentions.includes(m.slice(1)));
          io.writeErr(
            `verify: ${channel} holds exactly what was sent, ${stored.mentions.length} mention(s) live` +
              (silent.length > 0 ? `, and ${silent.join(", ")} notified NOBODY.` : `.`),
          );
        } else {
          // COMPARED IN PROSE ON BOTH SIDES. A raw `includes` finds a mention
          // inside a backtick span, where it notifies nobody, which is the exact
          // defect the rewrite guard was built for an hour earlier and which I
          // wrote again here.
          const storedProse = mentionsIn(stored.text);
          const lostHere = mentionsIn(text).filter((m) => !storedProse.includes(m));
          io.writeErr(
            `verify: ${channel} holds text that DIFFERS from what was sent.\n` +
              `What Slack stored:\n${stored.text}\n` +
              (lostHere.length > 0
                ? `Mentions that stopped notifying: ${lostHere.join(", ")}\n`
                : `Every mention survived: ${storedProse.join(", ") || "none"}\n`),
          );
        }
      }
      // A CITATION THAT POINTS AT NOTHING, reported while the sender is still
      // here. An agent cited `1787656658.009669` for a line Slack holds at
      // `1787656658.009699`, hand-copied from a notification preview, and the
      // reader spent a search finding what was meant. Four investigations in one
      // day turned on an exact ts.
      //
      // A NOTE, never a refusal: the message is already in the channel, and a ts
      // from another channel is a legitimate citation this cannot check. The
      // detector is the whole second, which no correct citation trips.
      const cites = citedTimestamps(text).filter((c) => c !== r.ts);
      // THE CAP SAYS WHAT IT DROPPED. A bound nobody prints reads as full
      // coverage, which is how a `tail -1` on a smoke diagnostic hid a failure in
      // this workspace.
      if (cites.length > CITED_TS_CAP) {
        io.writeErr(`cite: checked the first ${CITED_TS_CAP} of ${cites.length} cited ts, and left ${cites.slice(CITED_TS_CAP).join(", ")} unchecked.`);
      }
      for (const cited of cites.slice(0, CITED_TS_CAP)) {
        const look = await s.backend.citedMessage(channel, cited, from);
        if (look.error !== undefined || look.exact || look.near === undefined) continue;
        io.writeErr(
          `cite: ${channel} holds no message at ${cited}, and it holds ${look.near} in that same second. ` +
            `Check the digits, and read a ts from the delivered line instead of a preview.`,
        );
      }
    }
    await settleSend(io, channel, from, r.ts, thread, {
      hash: digest,
      channel,
      at: new Date().toISOString(),
    });
    if (status !== undefined) await settleStatus(replyStatus(status, channel, from), io);
    // AND LAST, because a pipe cuts from the end. Three agents independently
    // ran this output through `tail -4`, `tail -3` and `tail -2`, each losing
    // the `posted:` line, and two of them sent the message again. The same ts,
    // printed at both ends, survives a truncation from either side.
    io.writeErr(`sent: ${channel} at ts ${r.ts ?? "unknown"}. Slack has it. Nothing above asks you to send it again.`);
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
  const addressedOnly = flags.has("addressed");
  // A LISTENER IS THE LONGEST-LIVED THING AN AGENT RUNS, so its start is where
  // this agent's own runtime, directory and session reach the record.
  recordSelf(io, name);
  const drift = watchForNewerInstall(io);
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
    // handed in, which keeps the backend out of where the ledger lives.
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
      // THE REGISTER OVERRIDE, carried through. A key the loader drops is a key
      // the config claims to have and the code never sees.
      ...(typeof j.tiers === "object" && j.tiers !== null && !Array.isArray(j.tiers)
        ? { tiers: j.tiers as Record<string, string> }
        : {}),
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
 *  error string in place of a backend when the config or seams are missing. */
// What a scramble agent's app must declare lives in one place, which the
// onboarding script builds the manifest from and doctor checks a live app
// against. It used to be a second hand-kept copy here, under a comment claiming
// doctor compared the two; doctor never did, and the copies had diverged.

/** The one line an agent whose config is stale must see. Returned for the
 *  caller to print, so the caller decides the stream, and empty when nothing is
 *  wrong. */
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


/** TELL THE AGENT ITS OWN LISTENER HAS GONE STALE.
 *
 *  One launcher serves every agent sharing a HOME, which is the arrangement this
 *  workspace wants: one version per machine, so everyone picks up the same
 *  update. The cost is that an install by ANY agent leaves every running
 *  listener behind, and the agent it happened to gets no signal. An agent was
 *  left behind twice in one day and learned it only by running doctor.
 *
 *  The install prints the affected agents, which the INSTALLER reads. This is the
 *  half the stale agent reads: its own listener says so, on the stream that
 *  agent already watches, once per change.
 *
 * IT RIDES THE DELIVERY STREAM, as a JSON line, for the same reason a delivery
 * does. Written to stderr, this notice reached an agent only when its launcher
 * merged the streams: one agent's launch line sent stderr to a second file its
 * monitor never read, so 58 notices reached nobody, and merging the streams
 * would have put prose into a file whose reader parses JSON (reported). A
 * signal whose arrival depends on shell wiring at each host arrives at some
 * hosts. Stdout is where the listener already writes the lines the agent reads,
 * and a JSON envelope survives a parsing reader.
 *
 *  Every 30 seconds, which is far below the cost of a message and far above the
 *  rate anyone installs. */
export function watchForNewerInstall(io: Io): { stop: () => void; tick: () => void } {
  const mine = (io.moduleDir ? readCommitFile(io.moduleDir()) : "") || installedCommit(io);
  let told = "";
  // A REAL TIMER. `io.sleep` is stubbed instantaneous in
  // tests, so a `while (!stopped) await io.sleep(...)` loop spins at full speed
  // reading a file every iteration, and the suite stalled the first time this
  // shipped that way. An interval fires on the clock and nothing else, and
  // unref lets the process exit while it is pending.
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
            `made has NOT reached you. Restart the listener to pick it up.`,
        }),
      );
    }
  };
  const timer = setInterval(tick, 30_000);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer), tick };
}

/** The commit written beside a copy's source, empty when there is none. */
function readCommitFile(dir: string): string {
  try {
    return readFileSync(join(dir, "COMMIT"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Where THIS process runs, or undefined when the host cannot be read.
 *
 *  Undefined means this build publishes NO origin, which is what an Io with no
 *  hostname seam knows. A guessed host would be worse than none: a peer
 *  reading it would believe it. */
export function agentOrigin(io: Io, agent?: string): Origin | undefined {
  const host = io.hostname === undefined ? "" : io.hostname();
  if (host === "") return undefined;
  return originOf(host, io.cwd(), installedCommit(io), runtimeOf(io.env), agent);
}

/** WRITE THIS AGENT'S OWN ROW, so a crash leaves it on disk.
 *
 *  The operator: "Scramble should store the agent runtime, work dir and session
 *  ids for each agent in case of a system restart or crash." Every row in this
 *  file came from a message a PEER sent, so the one agent whose runtime and
 *  session this process knows for certain was the one agent missing from it: a
 *  host that crashed took its own record with it, and the agents that recovered
 *  the file found everyone except themselves.
 *
 *  Called on the delivery verbs and on the send, which is every path an agent
 *  runs. Best-effort and reported: a record that cannot be written must not fail
 *  the work it describes. */
export function recordSelf(io: Io, agent: string): void {
  const mine = agentOrigin(io, agent);
  if (mine === undefined || agent === "") return;
  try {
    // THE ROW CLAIMS THIS AGENT'S SLACK HANDLE, which the config already holds.
    // Without it a row keyed on the handle waits for the agent to SEND before it
    // retires, and an agent that upgrades and stays quiet keeps its two rows: two
    // identities, one host, one directory, one session, which reads as two agents
    // to anybody restoring the fleet.
    const handle = loadSlackConfig(io)?.agents[agent]?.handle;
    recordPeer(
      peersPath(slackConfigPath(io)),
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
      // THE ACTING AGENT'S OWN token. The status is posted into the agent's OWN
      // channel, and the default app is a different app that is usually not in
      // it: Slack answers channel_not_found, a failed status never fails the
      // work it brackets, and the whole feature is silently dead for every
      // agent that is not the default. That is what "assistant statuses do not
      // work at all" was.
      token = (agent !== undefined ? cfg.agents[agent]?.token : undefined) ?? cfg.token;
    }
  }
  // LIVE RESOLUTION for a channel the map does not hold. The map is a hand-kept
  // copy of what Slack holds, and this is the fourth place in this repo where
  // that copy went missing or stale: a channel an agent was invited into without
  // a config edit resolved to nothing here while `message send` to the same name
  // worked, since the post path asks Slack. Built lazily so a config with no
  // Slack backend pays nothing.
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
 *  backend, and it is handed into a read or a delivery so the backend filters a
 *  status line without knowing where the ledger lives. No status means no line
 *  hidden. */

/** A slack-backend `message check` cursor is a PER-CHANNEL map (channel name ->
 *  newest Slack ts), stored under a namespaced key in the same cursor.json so it
 *  never collides with the local backend's agent-keyed integer cursor. Slack has
 *  no global sequence, so the resume point it can support is a conversation ts
 *  per channel, kept client-side like the local cursor. */
const SLACK_CURSOR_PREFIX = "slack:";
/** The channels this agent was outside of at the last sweep, kept beside the
 *  cursor in the same file and read by the same reader. */
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
    /* absent or corrupt cursor: a fresh per-channel ledger, drain from the start */
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
    // From where the values ARE; see the note in writeCursor.
    j = JSON.parse(readFileSync(cursorPath(io, name), "utf8")) as Record<string, unknown>;
  } catch {
    /* absent cursor file is a fresh ledger */
  }
  j[`${SLACK_CURSOR_PREFIX}${name}`] = perChannel;
  if (skipped !== undefined) j[`${SLACK_SKIPPED_PREFIX}${name}`] = skipped;
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
  recordSelf(io, name);
  const drift = watchForNewerInstall(io);
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
 * agent's per-channel Slack cursor, exactly as the local path drains a pending
 * list, which makes this the direct mirror of `messageCheckLocal`. Slack has no
 * server-held per-agent inbox and no global sequence, so the cursor is the
 * conversation ts per channel, kept client-side in `.scramble/cursor.json`
 * under a namespaced key. Print one JSON line per drained message in the same
 * shape `listen` prints (with a `mentioned` flag for THIS agent), set the
 * working status for addressed lines exactly as the local path does, advance
 * the cursor to the newest line seen per channel, and exit 0. A broken or
 * missing config is REPORTED. */
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
  const startedState = readSlackState(io, name);
  const started = startedState.cursor;
  const startedSkipped = startedState.skipped;
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
  // A CHANNEL THIS AGENT IS NOT IN IS NOT A FAULT, and it was reported as one. The config is shared
  // by every agent on a host, so each sweep walked the other agents' channels and printed `slack:
  // <name>: channel_not_found` for each, every time. An agent reported two such lines on every
  // check, for channels it had never been in: "It reads like a fault every time".
  //
  // Classified with the membership listing this loop already fetched, and
  // reported ONCE at the end. When that listing FAILED there is nothing to
  // classify with, so every channel stays loud: a filter that cannot tell the
  // two apart must not choose the quiet answer.
  const memberOf = new Set(mine.names);
  const canClassify = mine.problem === undefined;
  const notMine: string[] = [];
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
      // the normal case, with no fault behind it. Failing the whole drain there meant
      // an agent with one uninvited channel drained NOTHING and said
      // `read failed`, which a sweeping agent cannot tell from a quiet channel.
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
      // its own last message as new traffic. `message read` is a transcript and
      // keeps every line. The DELIVERY drain is the only path that filters.
      // `from` is the RESOLVED sender, which for an app is its handle, so
      // comparing against the scramble name alone let an agent drain its own
      // messages back.
      if (ids.includes(m.from)) {
        // MY OWN LINES ARE READ BACK AGAINST TODAY'S RULES. The sweep walks them
        // anyway on its way past, and every rule in this file was added AFTER a
        // message had already gone out carrying what it bans, so the messages
        // already sent are the evidence for whether the newest rule was needed.
        //
        // The operator, having caught three of these in a row: "You need to
        // understand this general pattern and use the message check to guard
        // it." A rule that only guards the NEXT message leaves every earlier
        // one standing in the channel, unmarked, as though it were fine. MY
        // NEWEST LINE HERE ANSWERS EVERYTHING OLDER. A reply is a reply whether
        // or not it went through this CLI while the ledger existed.
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
  // THE SKIPPED SET RIDES WITH THE CURSOR, written by the same call, so the
  // next sweep can tell a moved set from a standing one.
  writeSlackCursor(io, name, next, [...notMine].sort());
  if (selfHits.length > 0) {
    io.writeErr(
      `${selfHits.length} message(s) you already sent would be refused by today's rules:\n` +
        `${selfHits.map((h) => `  ${h}`).join("\n")}\n` +
        `Each rule here was added after a message went out carrying what it bans. ` +
        `Correct them in the channel where they are still standing.`,
    );
  }
  // ONE LINE FOR ALL OF THEM, AND ONLY WHEN THE SET CHANGES. This printed on
  // every sweep, so a monitor guarding on `if [ -n "$out" ]` fired every tick:
  // 123 of 187 ticks carried this line and nothing else. A line that repeats
  // identically every fifteen minutes teaches its reader to skip the whole
  // stream, which is where a real report goes to die.
  //
  // The set is a standing fact about a shared config, so `doctor` prints it on
  // every run and the sweep speaks when it MOVES: a channel this agent expected
  // to be in stays findable, and the quiet ticks stay quiet.
  const skippedNow = [...notMine].sort();
  const setMoved = skippedNow.join("\u0000") !== startedSkipped.join("\u0000");
  if (notMine.length > 0 && setMoved) {
    io.writeErr(
      `slack: skipped ${notMine.length} channel(s) ${name} is not a member of: ${notMine.join(", ")}. ` +
        `The config is shared by the agents on this host, so these belong to another one. ` +
        // THE LINE A HUMAN PASTES, already filled in. An agent read this list,
        // learned a channel existed that it wanted, and had to ask which
        // command to ask for; an app cannot add itself to a Slack conversation,
        // so the only way in is a person typing this, and making them compose
        // it is a round trip for nothing.
        `If one of them is yours, ask a member of it to run:  /invite @${ids[1] ?? ids[0] ?? name}`,
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
  // THE SWEEP IS THE ACTIVE CALLER. It runs on a timer in every agent's
  // harness, so the drift between a running listener and the installed copy is
  // said here as well as watched by the listener. An agent whose listener fell
  // six hours behind found out by running `doctor` for an unrelated reason, and
  // their words for the gap: "the advisory needs an active caller more than it
  // needs revised wording."
  const code = backend === "slack" ? await messageCheckSlack(flags, io) : await messageCheckLocal(flags, io);
  // AFTER THE DRAIN, so the drain's own report is what a reader sees first and
  // these lines never sit ahead of a failure it names.
  //
  // THE SWEEP READS EACH LISTENER'S OWN COMMIT. My first version compared this
  // process against the install, and a sweep launched from the shared launcher
  // IS the install, so the line never fired: the caller I added was inert on
  // every host that runs the launcher.
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
          `the code they started with, so a change somebody made has NOT reached you. Restart the listener.`,
      );
    }
    // AND WHETHER ANYTHING IS ARMED AT ALL. Zero is the loud case: a listener on
    // an older commit still delivers, and none at all means every mention waits
    // for the next sweep.
    if (liveListeners(procs, agentName).length === 0) {
      io.writeErr(
        `scramble: NO listener is running for ${agentName}, so nothing wakes this agent between ` +
          `sweeps and every mention waits for the next one. Arm it: scramble listen --addressed --as ` +
          `${agentName}`,
      );
    }
  }
  // WHAT IS STILL OWED, on every sweep. The timed check is the one thing that
  // runs whatever the agent is doing, so the reminder about an unanswered
  // message belongs here: "Inbox pending check can be done in the 15 minute
  // message check monitor and prompt you any pending inbox item you have not
  // replied. This avoids having to implement custom hook scripts for Claude and
  // codex."
  //
  // It rides the drain, where a closing hook would be per client,
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
  { ok: true; id: string; permalink?: string; ts?: string } | { ok: false; error: string };

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
    return r.ok ? { ok: true, id: r.id, permalink: r.permalink, ts: r.ts } : { ok: false, error: r.error };
  }
  const r = recordLocalUpload(slackFilesDir(io), path, mimeOverride);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, id: r.record.id };
}

/** Resolve an attachment id to a local path, for `attachment view`: the local
 *  backend finds it in the filesDir ledger; the slack backend finds the file
 *  recorded there (inbound downloads arrive in filesDir under the file id). */
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
  // NOT ON DISK: FETCH IT. Delivery no longer pulls the bytes of every file that
  // passes through a channel, because three agents in one room each downloaded
  // the same 41MB archive addressed to one of them, inside the delivery path, on
  // a filesystem at 99%. The metadata always arrives, so the id on the line is
  // enough to get the bytes when they are wanted.
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
 * Operator: "the linter should be individually callable to check other
 * documents such as lark docs or markdown files." The rules belong to the send,
 * and a document going to the same people deserves the same reading, so the
 * verb reuses the rule list and owns no copy of it.
 *
 *  Prints `file:line: [label] "match"` and exits 1 when anything hit. */
/** A source file with everything except its comment lines blanked, keeping
 *  every newline so an offset still names its own line. */
export function maskToComments(text: string, style: "slash" | "hash" = "slash"): string {
  // `hash` covers the shell scripts. Running that mask over TypeScript would read
  // a private class field as prose, so the caller picks the style by extension.
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
        // A FILE THAT COULD NOT BE READ IS A FAILURE, never a silent pass: a
        // lint that skips what it cannot open reports clean on a typo.
        io.writeErr(`lint: cannot read ${p}: ${String(e)}`);
        return 1;
      }
    }
  }
  // `--comments` LINTS THE COMMENT TEXT OF A SOURCE FILE. The operator, having
  // read a banned form in a comment I had shipped an hour earlier: "Clean the
  // comments first." Every rule here was written for prose a person reads, and
  // a comment is prose a person reads.
  //
  // Non-comment lines are blanked in place, so the offsets still name the real
  // line, and code that happens to contain a banned word (the rule table's own
  // patterns) is out of scope.
  const commentsOnly = argv.includes("--comments");
  let total = 0;
  for (const src of sources) {
    const hash = /\.(sh|bash|py|toml|yml|yaml)$/.test(src.name);
    const text = commentsOnly ? maskToComments(src.text, hash ? "hash" : "slash") : src.text;
    // THE REPO'S OWN TEXT TAKES THE REPO'S RULES. A file on disk is linted with
    // CODE_RULES, which add the dated-log ban. Text piped in on stdin is a
    // message, and a message may carry a date as evidence.
    //
    // `--dates` narrows the check to the dated-log rule, which is how the tests
    // and the scripts are checked: the ban applies to every file the repo ships,
    // and the prose rules had never run over those directories, where they find
    // 121 older hits that are their own piece of work.
    const rules = argv.includes("--dates") ? DATE_RULES : src.name === "(stdin)" ? undefined : CODE_RULES;
    for (const h of lintLanguage(text, rules)) {
      io.writeErr(`${src.name}:${lineOf(text, h.index)}: [${h.label}] ${JSON.stringify(h.match)}`);
      total += 1;
    }
  }
  io.write(JSON.stringify({ lint: total === 0 ? "clean" : "hits", files: sources.length, hits: total }));
  return total === 0 ? 0 : 1;
}

/** `scramble peers [--same-dir]`: who else is running, on which host, in which
 *  directory.
 *
 * The operator: "Does each agent record its hostname and working directory on
 * scramble and an agent may know its same directory peers?"
 *
 * `--same-dir` matches HOST AND directory together. The path alone is not an
 * identity: two agents measured the SAME absolute path on two machines, backed
 * by different filesystems, and neither could see the other's files. Grouping
 * by path would have told them they shared a directory when they shared a
 * string. */
/** `scramble rewrite [<file>]`: what the rewriter would make of this text.
 *
 *  Asked for by the operator about the instruction file itself: "Rewrite prompt
 *  itself again should go through rewriter." Nothing here can send, so an author
 *  can read the model's answer, and any file in the repo can be put through the
 *  rules it asks other people to follow.
 *
 *  This writes no row to the ledger. That file counts sends that met the
 *  rewriter, and a preview is not a send. */
async function cmdRewrite(argv: string[], io: Io): Promise<number> {
  const file = argv.find((a) => !a.startsWith("--"));
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
  // `--why` ASKS FOR THE DIAGNOSIS. The operator, about a refusal this tool
  // prints: "Use gemini 3.7 to find why the communication is wrong." A rewrite
  // hands back a better version and leaves the author guessing which habit
  // produced the worse one.
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
  const { chosen, retried, configured } = await attemptRewrite(text, io);
  if (!configured) {
    io.writeErr(`rewrite: no model is configured; set SCRAMBLE_REWRITE_KEY to turn it on.`);
    return 1;
  }
  // NO SEND FRAMING HERE. `chosen.refuse` ends with "Rewrite your message and
  // send again", which is a lie in a verb that never sends. The guard's name and
  // the model's answer come out of the same refusal, so the two readings cannot
  // disagree about what happened.
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

/** `scramble rewrites`: what the rewriter has done on this host.
 *
 *  Every claim about whether the rewriter helps has been a single case somebody
 *  remembered. This counts the outcomes and names which guard fires most. */
async function cmdRewrites(argv: string[], io: Io): Promise<number> {
  // `--as` NAMES ONE AGENT'S ROWS. Without it every agent on the host is
  // counted, with their names on the first line, because the file is shared and
  // an unnamed count reads as the reader's own.
  const { flags } = parseArgs(argv);
  io.write(rewritesReport(readRewrites(rewritesPath(slackConfigPath(io))), flags.get("as")));
  return 0;
}

async function cmdPeers(argv: string[], io: Io): Promise<number> {
  const { flags } = parseArgs(argv);
  const rows = readPeerFile(peersPath(slackConfigPath(io)));
  io.write(peersReport(rows.rows, agentOrigin(io), flags.has("same-dir"), rows.damaged));
  return 0;
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
  if (sub === "close") {
    // MORE THAN ONE ID, because a thread of other people's work hands you a
    // batch. I closed eight items one command at a time in ten minutes, which is
    // the shape that teaches an agent to stop reading its own list.
    //
    // The bulk case where the agent SPEAKS is already covered elsewhere: a reply
    // in a channel closes everything older there. This is for the case where it
    // says nothing, and the reason then covers every id in the call.
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
      // EVERY ID IS REPORTED, and one failure never hides the rest: a batch that
      // stopped at the first bad id would leave the others silently untouched.
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

/** WRITE A DELIVERED LINE, AND RECORD IT. The only way a delivery reaches
 *  stdout, so a line cannot be handed to an agent without the ledger knowing an
 *  answer is owed. `read` does not go through here: a transcript is not an
 *  inbox.
 *
 *  The recording is best-effort and never blocks the delivery: an unwritable
 *  ledger must not stop a message reaching the agent, since the message is the
 *  point and the ledger is the accounting. It is REPORTED, so an inbox that
 *  quietly counts nothing does not read as an inbox with nothing in it. */
function emitDelivery(io: Io, agent: string, line: Record<string, unknown>, addressedOnly = false): void {
  // THIS AGENT'S IDENTITIES: its scramble name and the Slack handle a mention
  // resolves to, which differ (`scramble-dev` is mentioned as `scramble_dev`).
  // Comparing against the name alone is what once made a real mention arrive
  // with mentioned:false.
  const conf = loadSlackConfig(io)?.agents[agent];
  const handle = conf?.handle;
  const names = handle === undefined || handle === "" ? [agent] : [agent, handle];
  // EVERY DELIVERED LINE IS RECORDED, addressed or not. Only the addressed ones
  // are items owing a reply; the rest are the record that lets `inbox trace`
  // tell "never reached me" apart from "reached me and woke nothing". Without
  // that second row, the ledger's silence about a message has two meanings and
  // no way to choose, which is what sent four agents grepping a
  // text log for a timestamp.
  // WHERE THE SENDER RUNS, recorded from its own stamp. Learned passively from
  // any message, addressed or not, since knowing where a peer is does not depend
  // on it talking to you.
  const from = typeof line.from === "string" ? line.from : "";
  const org = line.origin;
  if (from !== "" && from !== agent && typeof org === "object" && org !== null) {
    const o = org as Origin;
    if (typeof o.host === "string" && typeof o.dir === "string") {
      try {
        recordPeer(peersPath(slackConfigPath(io)), from, o, new Date().toISOString());
      } catch (e) {
        io.writeErr(`peer record not written for ${from}: ${String(e)}`);
      }
    }
  }
  const addressed = isAddressed(line, names, readSent(sentPath(slackConfigPath(io), agent)));
  // THE FILTER LIVES HERE, where `addressed` is computed, and never in a grep
  // downstream. `scripts/inbox.sh` matched the literal `"mentioned":true`
  // against the serialised line, which works only while the serialiser emits no
  // space after that colon and the field keeps that name: add a space, reorder,
  // rename, and the grep stops matching with no error and no exit, so an inbox
  // goes quiet and looks calm. Every agent following JOIN.md inherited it.
  if (!addressedOnly || addressed) io.write(JSON.stringify(line));
  try {
    recordInboxItem(inboxPath(slackConfigPath(io), agent), {
      id: String(line.id ?? line.ts ?? line.seq ?? ""),
      channel: String(line.channel ?? ""),
      from: String(line.from ?? ""),
      ...(typeof line.thread === "string" ? { thread: line.thread } : {}),
      // THE NAMES THE LINE CARRIED, so `inbox trace` can say why this row is
      // this agent's. The verdict without its evidence sent two agents guessing
      // which mention opened six items.
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

/** EVERYTHING A SEND DOES ONCE SLACK HAS ACCEPTED IT, in one place.
 *
 *  Three things, and each was written at the post path and reached nowhere else:
 *  report what this send raced with, close what it answers, and remember its own
 *  ts so a reply to it is recognised as owed to this agent.
 *
 *  It lives here because a send carrying a FILE takes a different route: the
 *  upload posts the message, so the post path is skipped, and with it all three.
 *  My own ledger caught that, holding two questions I had answered with
 *  attachments.
 *
 *  Best-effort and reported: none of this may turn a delivered message into a
 *  failure. `ts` is absent when Slack reports no share for an upload, and then
 *  the close still runs against a wall-clock marker while the sent record is
 *  skipped, since an id nobody can look up is worse than no id. */
async function settleSend(
  io: Io,
  channel: string,
  from: string,
  ts: string | undefined,
  thread: string | undefined,
  draft?: { hash: string; channel: string; at: string },
): Promise<void> {
  const s = slackBackend(io);
  // THE SEND IS THE OTHER PATH EVERY AGENT RUNS. An agent that speaks without
  // ever starting a listener would be absent from the record it publishes to
  // every peer.
  recordSelf(io, from);
  try {
    if (s.backend !== undefined) await reportCrossings(io, s.backend, channel, from, ts);
    closeInboxItems(inboxPath(slackConfigPath(io), from), channel, ts ?? new Date().toISOString(), thread);
    // THE DRAFT RIDES WITH THE ts, so the next send of the same words can see
    // this one and refuse.
    if (ts !== undefined) recordSent(sentPath(slackConfigPath(io), from), ts, draft);
  } catch (e) {
    io.writeErr(`inbox ledger not updated after posting to ${channel}: ${String(e)}`);
  }
}

/** The guard's name, short enough for a ledger row. The model's attempt belongs
 *  on the screen and never in a counter. */
function guardName(why: string): string {
  return why.slice(0, 120);
}

/** Say what arrived in this channel between the last line this agent saw and the
 *  line it just sent.
 *
 *  IT REPORTS AFTER THE SEND, and that is the only place it can work. Both of
 *  the day's collisions were sub-minute, 20 and 40 seconds apart, measured by one
 *  of the two agents: each was already writing when the other posted. Reading
 *  the channel first catches neither. The moment you speak is the first moment
 *  the race is decidable.
 *
 *  Bounded by the DELIVERY cursor, so it reports what this agent has not read.
 *  It repeats until a `message check` moves that cursor, which matches the
 *  state: those messages are still unread, and a sender about to write a
 *  second message on the same subject wants to know a second time.
 *
 *  Reported and never fatal: a failed lookup here must not turn a delivered
 *  message into an error, so it says what it could not do and stops. */
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
  // THIS AGENT'S OWN LINES ARE NOT CROSSINGS, and matching on the scramble name
  // alone listed one of mine back to me: history carries the SLACK HANDLE, and
  // `scramble-dev` posts as `scramble_dev`. Same mismatch that once marked a real
  // mention as unaddressed. Caught on the first live run of this report.
  const me = backend.identities(from);
  const crossed = r.messages.filter(
    (m) =>
      !me.includes(m.from) &&
      slackTs(m.ts) < slackTs(ownTs) &&
      (cursor === undefined || slackTs(m.ts) > slackTs(cursor)),
  );
  if (crossed.length === 0) return;
  const lines = crossed.map((m) => `  ${m.from}: ${(m.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
  io.writeErr(
    `${crossed.length} message(s) arrived in ${channel} before yours and you have not read them:\n` +
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
      // LENGTH IS CHECKED HERE TOO, for the same reason the language rules are:
      // a limit the sender has to remember is a limit that holds until the
      // sender is busy. Operator: "We need to impose a message length limit in
      // words. Maybe 200."
      const tooLong = lengthRefusal(text);
      if (tooLong !== "") {
        io.writeErr(tooLong);
        return 1;
      }
      // A REPLY GOES IN THE THREAD IT ANSWERS, by default: "shall we make inbox
      // reply default to within the thread? Posting to the channel directly can
      // be made a separate flag."
      //
      // The ledger already knows which item in this channel is unanswered, so
      // the thread is READ from it. With something open and no
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
        // ONLY WHEN THERE IS ONE THING TO ANSWER. With several open the newest
        // is a guess, and a wrong guess puts an answer inside someone else's
        // conversation: the operator asked a question, another agent posted 13
        // seconds later, and my answer to the operator went into that agent's
        // thread. Several open means the sender knows which one this answers
        // and the ledger does not, so it says so and stays at channel level,
        // where a reader can at least see what it is about.
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
      // `--attach <path>` is repeatable: upload each file to the TARGET before
      // sending, so the message and its files arrive together, then send the
      // text carrying the uploaded file metadata (the id + local path).
      const attachPaths = collectValues(args, "--attach");
      let sentTs: string | undefined;
      let files: Attachment[] | undefined;
      const links: string[] = [];
      if (attachPaths.length > 0) {
        for (const p of attachPaths) {
          // The FIRST attachment carries the message text, so the words and the
          // file arrive as one message; the rest are bare uploads.
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
          // The FIRST upload carries the text, so its message is this send's.
          if (sentTs === undefined) sentTs = up.ts;
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
      //
      // EVERYTHING A SEND DOES AFTER POSTING STILL HAS TO HAPPEN. This returned
      // here and skipped all of it, so a reply carrying a file closed nothing,
      // remembered nothing and reported nothing. Caught by my own ledger: two
      // questions I had answered with attachments sat open in `inbox pending`,
      // and a reply to either would not have been recognised as owed to me.
      if (backend === "slack" && attachPaths.length > 0) {
        await settleSend(io, req.channel, nameFor(flags, io), sentTs, flags.get("thread"));
        return 0;
      }
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
    case "edit":
    case "delete": {
      // `message edit --target <ch> --to <ts>` with the new text on stdin, and `message delete
      // --target <ch> --to <ts>`. Asked for by the operator: "Agents should be able to edit and
      // delete messages."
      //
      // AN EDIT IS A SEND. It passes the language rules and the rewriter the
      // same way, because the channel ends up holding its text either way, and a
      // rule that a second verb walks around is not a rule.
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
  // GRADED: an advisory is reported and does NOT fail the verb, because it names
  // something that still works. A problem stops delivery.
  const advisories: string[] = [];
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
  // before an event was added to the manifest keeps a wake path that is dead
  // for exactly one event and healthy for every other. That is how an invite
  // delivered nothing while mentions kept arriving (operator: "invited but
  // inbox does not fire"). Both answers come from ONE manifest read.
  const declared = await declaredManifest(io, name);
  // AN APP THIS LOGIN CANNOT READ cannot be repaired by this login either, so
  // naming the repair command would send the agent at something that dies on its
  // first call. Say who has to act instead.
  const unreadable = declared !== undefined && declared.unreadable !== undefined;
  // WHY IT COULD NOT BE READ DECIDES WHO HAS TO ACT, and this used to answer
  // "another login owns this app" for EVERY failure. Run against my own app,
  // which I own, it read `token_expired` and told me to ask the owner or throw
  // the entry away: a cause the evidence never established, printed as fact, on
  // the surface an agent trusts to tell it what is wrong.
  //
  // A stale CLI token is the ordinary case and its repair is a token. Ownership
  // is what `not_authed` and the access errors mean.
  const answer = String(declared === undefined ? "" : declared.unreadable);
  const staleToken = unreadable && /token_expired|invalid_auth|token_revoked/.test(answer);
  const selfExplained = unreadable && declared.selfExplained === true;
  // OWNERSHIP IS CLAIMED ONLY WHERE SLACK SAYS SO. This used to be the `else`
  // of a whitelist, so every string the list missed was printed as an ownership
  // verdict: `token_expired`, then `invalid_refresh_token` from my own rotation
  // code a day later. A guess in a default branch comes back with each new
  // error string, so the default states the answer and stops.
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

  // A LISTENER OLDER THAN THE CODE is running a build that no longer exists,
  // which looks exactly like a defect that was already fixed.
  //
  // AN ADVISORY. A listener on an older commit still DELIVERS, while zero
  // listeners means nothing arrives at all, and this verb reported the two with
  // the same weight. An agent stopped restarting on every bump and built its
  // own grading on top: "advisory for a commit mismatch, alarm only for zero
  // listeners". That grading belongs here, where every reader gets it.
  const staleProblem = staleListenerProblem(staleListeners(io, name), name);
  if (staleProblem !== undefined) advisories.push(staleProblem);

  // AND FOR AN INSTALLED AGENT, the commit is a fact on the process line. The
  // launcher execs the resolved commit directory, so a listener carries its
  // version in its own command line; comparing that against the installed one
  // answers "is this process running the code I have" without touching mtimes,
  // which for an installed copy describe the wrong tree entirely. TWO AGENTS ON
  // ONE APP SPLIT ITS EVENTS. Slack hands a Socket Mode event to ONE open
  // connection per app, so two consumers on one token halve each other's
  // delivery, silently and at random. A fourth agent measured exactly that: its
  // listener and a second bolt app on the same adopted token were splitting
  // mentions between "a consumer that answers and a consumer that discards
  // them", and a human asked the same question twice inside that window.
  //
  // Slack exposes no way to ask how many connections an app has open, so this
  // catches the half that IS knowable: another agent in this config pointed at
  // the same app. A consumer on another machine is invisible here, and
  // `doctor --wake` is the probe that would catch it.
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
    advisories.push(
      `${behind.length} listener(s) for ${name} run a different commit than the installed ${installedNow}: ` +
        `${behind.map((b) => `pid ${b.pid} on ${b.commit}`).join(", ")}. They hold the code they started ` +
        `with, so a fix you installed has not reached them. Stop them and arm the inbox again.`,
    );
  }

  // A HOST NOBODY INSTALLS ON HAS NOTHING TO DISAGREE WITH. The staleness
  // notice compares a running listener to the commit installed beside it, so a
  // machine that stops updating stays quiet while it falls behind. One did, by
  // five commits, with every listener matching its install.
  //
  // A peer's own message carries the commit it ran, so the disagreement is
  // readable here with no git and no network. Which side is older is left to
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

  // WHAT IS WAITING ON THE OPERATOR. Classification is theirs to make, so the
  // surface they read names the channels with no tier and the command that sets
  // one. An unclassified channel still sends, in the careful register.
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

  // `--wake <channel>` is opt-in because it POSTS a line into that channel.
  const wakeChannel = flags.get("wake");
  if (wakeChannel !== undefined && wakeChannel !== "") {
    // A TEST WHOSE ANSWER WOULD BE MEANINGLESS IS NOT RUN. Slack hands each
    // Socket Mode event to ONE connection, so an armed listener takes the probe
    // and this test times out and calls the wake path DEAD. Its own advice then
    // says to re-onboard, which rotates the bot token and strands that listener.
    // Refusing to run beats answering wrongly on the most alarming surface here.
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
  // THE REWRITE STATE IS REPORTED WHETHER OR NOT ANYTHING ELSE IS WRONG. It sat
  // in the clean line only, so on a host with an expired CLI token, where every
  // other answer is a problem, the one question an operator is asking while
  // setting it up had no answer at all. Measured here: two doctor runs printed
  // nothing about it because this agent's manifest read fails.
  {
    const rc = rewriteConfig(io.env);
    io.writeErr(
      rc.key === undefined
        ? `doctor: the outgoing rewrite is OFF; set SCRAMBLE_REWRITE_KEY to turn it on.`
        : `doctor: the outgoing rewrite is ON: ${rc.provider} ${rc.model} at ${rc.url}, ${rc.timeoutMs}ms.`,
    );
  }
  if (problems.length === 0) {
    // WHAT WAS INSPECTED, on the clean line. A remote agent read this and said
    // it best: "What the clean line does NOT say is that it inspected anything.
    // Plain doctor prints ok with no listener line at all, on a host where a
    // listener is running and where --wake proves it can see it." An `ok` that
    // names nothing is indistinguishable from an `ok` that looked at nothing,
    // which is the shape this whole verb exists to kill.
    const seen = stillAlive(liveListeners(readProcesses(procRoot), name), procRoot);
    io.write(
      JSON.stringify({
        doctor: "ok",
        agent: name,
        handle,
        // THE NAMES THEMSELVES. `scopes: 14` answers no question anyone asks.
        // Pricing a change asks WHICH scopes are granted, and with only a count
        // on the surface I told an agent that reading reactions would need a
        // scope change and a reinstall; `reactions:read` was already one of the
        // fourteen, in this repo's own app-manifest.ts. Same for the events:
        // what is subscribed decides what Slack will ever deliver. WHETHER THE
        // REWRITE IS ON, and against what. Turning it on is four environment
        // variables read by whichever process sends, so a way to ask without
        // sending a message is the difference between configured and
        // believed-configured. The key is reported as present or absent and
        // never printed.
        rewrite: (() => {
          const rc = rewriteConfig(io.env);
          return rc.key === undefined
            ? { on: false }
            : { on: true, provider: rc.provider, model: rc.model, url: rc.url, timeoutMs: rc.timeoutMs };
        })(),
        scopes: [...granted].sort(),
        events: declared !== undefined && declared.unreadable === undefined ? [...declared.botEvents].sort() : null,
        listeners: seen.length,
        installed: installedNow === "" ? null : installedNow,
        // THE PEER RECORD'S OWN HEALTH, as a field a monitor can read. Six
        // agents append to that file on one host, one of them found a line no
        // parser could read, and the agent that armed a watcher for it wrote its
        // own parse loop. Two definitions of `damaged` disagree the day the row
        // shape changes, and a monitor grepping the prose sentence breaks on a
        // rewording, which is the trap this repo took out of its wake filter.
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

/** `doctor --wake`: prove the wake path CARRIES A MESSAGE. Proving that it
 * connects settles nothing, since a listener whose socket delivers nothing is
 * indistinguishable from a quiet channel, so I armed a monitor, watched the
 * process stay alive, and reported it working while it delivered nothing for
 * hours (postmortem: akrust log/postmortems/
 * `-armed-a-monitor-without-proving-it-receives.md`).
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
 * is running code that no longer exists. Twice that produced a visible defect
 * the code had already fixed: an agent delivered its own posts for minutes
 * after the self-filter shipped, and kept posting `working` messages after the
 * living message was deleted. A merged fix does not reach a running process,
 * and nothing said so.
 *
 *  Reads /proc, so it answers undefined where that is absent. */
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
 *  say. Separated from the finding so the sentence an operator acts on has its
 *  own test. */
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
  return procs
    .filter((p) => isListenerProc(p.cmd, agent))
    .map((p) => ({ pid: p.pid, commit: listenerCommit(p.cmd) }))
    .filter((p) => p.commit !== "" && p.commit !== installed);
}

/** Every LIVE listener for this agent, whatever its age. Pure, and separate from
 *  pickStale because the question is different: pickStale asks which listeners
 *  are behind the code, and this asks whether anything is holding the socket at
 *  all.
 *
 * `doctor --wake` needs it. Slack delivers each Socket Mode event to ONE
 * connection, so an armed listener takes the probe frame and doctor's own
 * socket waits out its timeout and pronounces the wake path DEAD. Measured:
 * with the inbox armed, `doctor --wake` said "The wake path is DEAD" and told
 * me to re-onboard, which rotates the bot token; with the same inbox stopped
 * and nothing else changed, the same command answered
 * `"delivered":"1787365205.175139"`. The advice was worse than the verdict:
 * following it would have rotated a working token and stranded the listener. */
/** Which of these pids still exist, checked NOW.
 *
 * A listener count is a snapshot, and the most alarming surface here acts on
 * it: `doctor --wake` refuses to probe while a listener holds the socket. An
 * agent killed its listener, ran doctor, and was refused with the pid of a
 * process that had already gone. A refusal naming a dead pid sends someone
 * hunting for a process to stop, and the probe it withheld would have worked.
 *
 *  This does not close the window, since nothing can: a process can exit one
 *  microsecond after the check. It shrinks the window from the whole doctor run,
 *  which makes network calls, to the instant of the report. */
export function stillAlive(pids: string[], root = "/proc"): string[] {
  return pids.filter((pid) => {
    try {
      return statSync(`${root}/${pid}`).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Is this process a scramble listener, and not something whose command line
 *  merely CONTAINS one?
 *
 * A substring match over /proc counts any process whose arguments carry the
 * words, and the processes most likely to carry them are the ones people run
 * while looking into listeners: a grep, a pgrep, a shell one-liner. I hit this
 * on my own host, where my debugging shells matched the scan, and I fixed the
 * TESTS by feeding them an empty /proc, which left the detector able to do it
 * to anyone.
 *
 *  argv[0] settles it: a listener is executed by bun. A shell holding the same
 *  words has argv[0] of bash, sh, grep or pgrep. */
function isListenerProc(cmd: string, agent: string): boolean {
  if (!cmd.includes("bin.ts listen") || !cmd.includes(`--as ${agent}`)) return false;
  const argv0 = cmd.trim().split(/\s+/)[0] ?? "";
  const exe = argv0.split("/").pop() ?? "";
  return exe === "bun" || exe === "node";
}

export function liveListeners(
  procs: Array<{ pid: string; cmd: string; startedMs: number }>,
  agent: string,
): string[] {
  return procs.filter((p) => isListenerProc(p.cmd, agent)).map((p) => p.pid);
}

/** WHICH of those are listeners for this agent that predate the code. Pure, so
 *  the rule is tested without spawning anything. */
export function pickStale(
  procs: Array<{ pid: string; cmd: string; startedMs: number }>,
  agent: string,
  newestSourceMs: number,
): Array<{ pid: string; ageBehind: number }> {
  // `--as <agent>`, which is narrower than the name ANYWHERE in the command
  // line. A bare substring
  // match reported every listener as belonging to every agent whenever an
  // agent's name also appeared in the checkout path, which is ordinary: name an
  // agent after the product and every process running from the product's own
  // directory matches it. Measured here, doctor named the same three pids under
  // two agents and told me to restart listeners that were not mine. A detector
  // that cries wolf is worth less than no detector, since I stop reading it.
  return procs
    .filter((p) => isListenerProc(p.cmd, agent) && p.startedMs < newestSourceMs)
    .map((p) => ({ pid: p.pid, ageBehind: Math.round((newestSourceMs - p.startedMs) / 1000) }));
}

/** What this agent's app DECLARES: whether it deploys org-wide, and which events
 *  it subscribes to. Read from the app's own manifest through the Slack CLI
 *  credential, which is the only token that can export it, in ONE call because
 *  both answers come from the same document. Returns undefined when that
 *  credential is absent, so a host without it reports nothing. */
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
  // ROTATE THE APP-CONFIG TOKEN, WHICH SPARES A PERSON TWICE A DAY. It lives
  // twelve hours, nothing on either host renewed it, and doctor lost the
  // manifest check every night as a result. The entry carries a refresh_token.
  //
  // NO CREDENTIAL AT ALL LEAVES THE QUESTION OPEN, exactly as it did before a
  // rotation existed: an agent without the Slack CLI installed is not a broken
  // agent. A credential that EXISTS and cannot be made usable is a problem,
  // which is how the expired one surfaced in the first place.
  if (!firstCredential(fileText).ok) return undefined;
  const cred = await freshCliToken(
    fileText,
    path,
    (u, init) => io.fetch(u, init),
    Math.floor(Date.now() / 1000),
    new Date().toISOString(),
  );
  // THE CREDENTIAL'S OWN REPORT ALREADY NAMES WHO ACTS, so doctor must not
  // append a guess to it. It appended the ownership sentence to
  // `invalid_refresh_token` on the first live run of this code, which is the
  // same wrong cause the ownership branch printed for `token_expired` a day ago.
  if (!cred.ok) return { unreadable: cred.why, selfExplained: true };
  const cliToken = cred.token;
  if (cred.rotated) io.writeErr(`doctor: the Slack app-config token was expired and has been rotated in ${path}.`);
  const cfg = loadSlackConfig(io);
  if (cfg === null) return undefined;
  // THE AGENT BEING CHECKED, by name. The first
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
    error?: string;
    manifest?: {
      settings?: { org_deploy_enabled?: boolean; event_subscriptions?: { bot_events?: string[] } };
    };
  };
  // AN APP THIS LOGIN DOES NOT OWN answers no_permission, and that is a
  // different fact from "no credential here". A fourth agent onboarded onto
  // someone else's app and doctor told it to run onboard-agent.ts, which dies
  // on its first call for exactly that reason: "The repair line assumes the
  // agent owns the app".
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
  // `channel tier <channel> internal|external` writes the classification the
  // operator makes. Asked for in those terms: "Channel classification should be
  // manually done by the operator". Hand-editing the shared JSON is how a
  // config gets a stray comma at midnight.
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

/** Write one channel's register into the config the agents on this host share.
 *
 *  It reads the file, changes the one key, and writes it back, so every other
 *  entry survives. Printing the whole map afterwards is the read-back: the
 *  operator sees what the file now says about every channel, from the file. */
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
 *  IT USED TO DEFAULT TO LOCAL WHATEVER WAS CONFIGURED, which is a failure
 *  surface with a preference painted over it. The local backend answers from a
 *  store that
 *  the listener fills, so a Slack agent that forgot the environment variable got
 *  a TRANSCRIPT where an error belonged: `message read` on a channel it had just been
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

/** The verbs, one line each. Printed for `--help` and for an unknown verb, so a
 *  reader learns what exists from the tool itself. */
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

export async function main(argv: string[], io: Io): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.write(USAGE);
    return 0;
  }
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