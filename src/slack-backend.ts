// src/slack-backend.ts — SLACK AS A THIRD BACKEND behind the same verbs as
// src/raft.ts. scramble talks to Slack over its REST + Socket Mode transports
// through INJECTED seams (a `fetch` function and a socket factory), so tests
// need no Slack token, no network and no socket. The real fetch and the real
// WebSocket live in src/bin.ts (which no test imports) so the coverage gate
// stays green.
//
// Slack is treated as the SOURCE OF TRUTH: every verb talks to Slack directly
// and never mirrors a local store. Slack has no global sequence number, so the
// message `ts` is the per-channel cursor (the honest mapping where Slack keeps
// no shared total order). The line shape we emit matches the local backend
// EXACTLY (channel, from, text, ts, mentions plus a `mentioned` flag for this
// agent) because the join skill and the hooks read it verbatim.
import type { Delivery, Message, Attachment } from "./types";
import { DM_PREFIX } from "./types";
import type { SlackSocket } from "./slack-transport";
import { downloadFile, type SlackFileMeta } from "./attachments";

// --- slack endpoint URLs ------------------------------------------------

const SOCKET_OPEN_URL = "https://slack.com/api/apps.connections.open";
const POST_URL = "https://slack.com/api/chat.postMessage";
const HISTORY_URL = "https://slack.com/api/conversations.history";
const REPLIES_URL = "https://slack.com/api/conversations.replies";
const USERS_INFO_URL = "https://slack.com/api/users.info";
const AUTH_TEST_URL = "https://slack.com/api/auth.test";

/** Cap on the number of threaded ROOTS expanded per history call — the fan-out
 *  is bounded: one extra conversations.replies request per expanded root, on
 *  the NEWEST roots only. Unbounded expansion on a busy channel is not
 *  acceptable; a root dropped by the cap is REPORTED, never silent. */
export const THREAD_EXPANSION_CAP = 5;

/** Backoff for RE-CONNECTING a Socket Mode stream after it dropped: the first
 *  reconnect waits RECONNECT_BACKOFF ms. A connection that once worked keeps
 *  retrying forever (bounded by MAX_RECONNECT_BACKOFF); one that never once
 *  opened is a FAILURE, not a retry. */
const RECONNECT_BACKOFF = 1000;
const MAX_RECONNECT_BACKOFF = 4000;

/** True for a top-level row that CARRIES a thread (Slack marks it with a
 *  reply_count above zero and a thread_ts equal to its own ts). Only such a
 *  row expands via conversations.replies; a reply-less row never triggers a
 *  request at all. A reply (thread_ts != ts) is not a root. */
export function isThreadRoot(m: SlackHistoryMessage): boolean {
  const rc = m.reply_count ?? 0;
  return rc > 0 && m.thread_ts !== undefined && m.thread_ts === m.ts;
}

/** One Slack message event arriving off the Socket Mode wires. Only the fields
 *  mapped to our line shape are read, deliberately. */
export interface SlackInboundEvent {
  type?: string;
  subtype?: string;
  text?: string;
  channel?: string;
  bot_id?: string;
  user?: string;
  username?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFileMeta[];
}

/** A Socket Mode envelope. Slack redelivers any envelope you do not ACK, so we
 *  reply with the envelope_id for every frame that has one. */
interface Frame {
  type?: string;
  envelope_id?: string;
  payload?: { event?: SlackInboundEvent };
}

/** The config the backend reads, a SUBSET of the bridge config (src/slack.ts):
 * tokens, the channel->Slack channel map, per-agent identities and the mention roster.
 * `postToChannel` is deliberately absent — the backend POSTS STRAIGHT TO SLACK, not
 * into a stitched local channel. There is NO self-filter list here: an agent's own
 * posts are suppressed by NAME on the delivery path only (a resolved sender name
 * equals the consuming agent), the same mechanism the local backend uses. */
export interface SlackBackendConfig {
  /** main bot token (xoxb-) used as the fallback for every post. */
  token: string;
  /** app-level token (xapp-) for apps.connections.open (Socket Mode). */
  appToken?: string;
  /** channel name -> Slack channel id. */
  channels: Record<string, string>;
  /** agent name -> { token?: per-agent bot token, appToken?: per-agent app-level token }. */
  agents: Record<string, { token?: string; appToken?: string; handle?: string }>;
  /** slack user id -> name, for <@U…> -> @name normalization. */
  roster: Record<string, string>;
  /** DM channel id -> agent whose bot that DM belongs to. */
  dmChannels: Record<string, string>;
  /** directory downloadable Slack attachments are written to. Default
   *  `~/.config/scramble/files` (resolved by the caller, which sees HOME). */
  filesDir: string;
}

/** The injected seams. Every outbound Slack call and every socket is built
 *  ONLY through these, so a test passes fakes and touches no network. */
export interface SlackBackendDeps {
  /** injected network seam for the REST calls. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** injected socket factory; the real one wires bun's WebSocket (src/bin.ts). */
  createSocket(url: string): SlackSocket;
  /** injectable wait so a next() deadline needs no real delay under test. */
  sleep(ms: number): Promise<void>;
  /** injectable clock for a next() deadline; defaults to Date.now(). */
  now?: () => number;
}

/** One atomic REST answer: `ok:false`+error text is a FAILURE carrying Slack's
 *  error, never a silent success. */
type OkResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/** Parse a Slack REST payload and decide ok/not by the `ok` field. A response
 *  that does not parse (or a fetch that throws) is surfaced as a FAILURE, never
 *  read as a success, because a caller that cannot tell what Slack said must
 *  not act as if it had. */
async function readOk<T = Record<string, unknown>>(
  fetch: SlackBackendDeps["fetch"],
  input: string,
  init?: RequestInit,
): Promise<OkResponse<T>> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch {
    return { ok: false, error: `slack request failed: ${input}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: `slack answered non-JSON to ${input}` };
  }
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: `slack answered non-object to ${input}` };
  }
  const rec = body as Record<string, unknown>;
  if (rec.ok !== true) return { ok: false, error: (rec.error as string) ?? "slack call failed" };
  return { ok: true, data: rec as unknown as T };
}

/** A line (message) read from conversations.history. */
export interface SlackHistoryMessage {
  ts?: string;
  thread_ts?: string;
  /** Slack's count of replies under this message when it is a threaded root
   *  (reply_count above zero with thread_ts equal to its own ts marks the
   *  row as a root whose replies live under conversations.replies). */
  reply_count?: number;
  user?: string;
  username?: string;
  text?: string;
  bot_id?: string;
  files?: SlackFileMeta[];
}

/** The members a message addresses. A dm/ channel addresses its peers (everyone
 *  but the sender); a group channel addresses the @-tokens in the text. Pure so
 *  it is trivially unit-tested. */
export function computeMentions(channel: string, text: string, sender: string): string[] {
  const out = new Set<string>();
  if (channel.startsWith(DM_PREFIX)) {
    for (const seg of channel.split("/").slice(1)) {
      if (seg && seg !== sender) out.add(seg);
    }
  } else {
    for (const tok of text.split(/\s+/)) {
      if (!tok.startsWith("@")) continue;
      const name = tok.slice(1).replace(/^\W+/, "").replace(/\W+$/, "");
      if (name) out.add(name);
    }
  }
  return [...out];
}

/** The Slack backend: post / history / listen / next straight at Slack, the
 *  THIRD backend behind the same verbs the local and raft backends already
 *  are. */
export class SlackBackend {
  private readonly fetch: SlackBackendDeps["fetch"];
  private readonly createSocket: SlackBackendDeps["createSocket"];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly token: string;
  private readonly appToken?: string;
  private readonly dmChannels: Record<string, string>;
  private readonly channelById: Record<string, string>;
  private readonly channels: Record<string, string>;
  private readonly agents: Record<string, { token?: string; appToken?: string; handle?: string }>;
  private readonly roster: Record<string, string>;
  private readonly filesDir: string;
  /** Cache of users.info answers so a repeat unknown id never re-queries. The
   *  key is `<acting token>:<user id>` because each agent resolves names under
   *  ITS OWN credential: the same Slack user id can answer differently under one
   *  app than under another, so the two must never share a cache slot. */
  private readonly nameCache = new Map<string, string>();

  constructor(cfg: SlackBackendConfig, deps: SlackBackendDeps) {
    this.fetch = deps.fetch;
    this.createSocket = deps.createSocket;
    this.sleep = deps.sleep;
    this.now = deps.now ?? (() => Date.now());
    this.token = cfg.token;
    this.appToken = cfg.appToken;
    this.agents = cfg.agents;
    this.roster = cfg.roster;
    this.filesDir = cfg.filesDir;
    this.dmChannels = cfg.dmChannels;
    this.channelById = Object.fromEntries(Object.entries(cfg.channels).map(([r, c]) => [c, r]));
    this.channels = cfg.channels;
  }

  /** ONE helper that answers "which bot token does the acting agent use": the
   *  agent's OWN token when it has one, else the config default — the way `post`
   *  already resolves it. EVERY outbound Slack call site (the post, the history
   *  read, the threaded-reply expansion, the users.info name lookup and the
   *  inbound attachment download) resolves THROUGH this helper, so the acting
   *  identity is never lost on a read that was sent with a different agent's
   *  credential. When NEITHER the agent nor the default has a token the answer
   *  is a FAILURE naming the agent and the config key it lacks, never a silent
   *  empty token. */
  private agentToken(agent: string): { ok: true; token: string } | { ok: false; error: string } {
    const own = this.agents[agent]?.token;
    if (own !== undefined && own !== "") return { ok: true, token: own };
    const fallback = this.token;
    if (fallback !== undefined && fallback !== "") return { ok: true, token: fallback };
    return {
      ok: false,
      error: `agent "${agent}" has no per-agent token and the config has no default token (key "agents.${agent}.token" or "token" is required)`,
    };
  }

  /** The app-level token (xapp-) the acting agent's SOCKET connect uses: the
   *  agent's own per-agent appToken when present, otherwise the top-level
   *  default, so a single-app config keeps working unchanged. */
  /** Does this line address that agent? Slack resolves `<@U…>` to the app's
   *  HANDLE, which is a different string from the agent's scramble name: the
   *  handle for `scramble-dev` is `scramble_dev`, so a real mention arrived with
   *  `mentioned:false` and the tier-one wake path, which filters on
   *  `"mentioned":true`, slept through it. The handle recorded on the agent's
   *  config entry is an ALIAS for its name. */
  /** Every name this agent answers to: its scramble name and, when recorded,
   *  its Slack handle. PUBLIC because `message check` in the CLI does its own
   *  delivery filtering and needs the same answer; two copies of "who is this
   *  agent" is how the handle mismatch reached three places at once. */
  identities(agent: string): string[] {
    const handle = this.agents[agent]?.handle;
    return handle !== undefined && handle !== "" && handle !== agent ? [agent, handle] : [agent];
  }

  private addressesAgent(mentions: string[], agent: string): boolean {
    return this.identities(agent).some((id) => mentions.includes(id));
  }

  private appTokenFor(agent: string): string {
    return this.agents[agent]?.appToken ?? this.appToken ?? "";
  }

  /** Is this agent's app IN the conversation, and what is its handle? An app
   *  cannot add itself to a Slack conversation, public or private: a member
   *  invites it. So the useful answer to "join" is whether the invite has
   *  happened, and the handle to invite when it has not. A one-message read is
   *  the probe, because that is the access the agent actually needs. */
  async membership(
    channel: string,
    as: string,
  ): Promise<{ ok: true; joined: boolean; handle: string; detail: string } | { ok: false; error: string }> {
    const slackChannel = this.channels[channel];
    if (!slackChannel) return { ok: false, error: `no Slack channel for channel ${channel}` };
    const t = this.agentToken(as);
    if (!t.ok) return { ok: false, error: t.error };
    const who = await readOk<{ user?: string }>(this.fetch, AUTH_TEST_URL, {
      headers: { authorization: `Bearer ${t.token}` },
    });
    if (!who.ok) return { ok: false, error: who.error };
    const handle = who.data.user ?? as;
    const probe = await readOk<{ error?: string }>(
      this.fetch,
      `${HISTORY_URL}?channel=${encodeURIComponent(slackChannel)}&limit=1`,
      { headers: { authorization: `Bearer ${t.token}` } },
    );
    if (probe.ok) return { ok: true, joined: true, handle, detail: "a read of the conversation succeeded" };
    return { ok: true, joined: false, handle, detail: probe.error };
  }

  /** POST one post to the Slack channel a channel maps to, with the agent's own bot
   *  token when it has one, else the config token. A Slack failure (`ok:false`
   *  with error text) is surfaced as a FAILURE carrying that text, never read
   *  as a success. */
  async post(
    channel: string,
    text: string,
    as: string,
    thread?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const slackChannel = this.channels[channel];
    if (!slackChannel) return { ok: false, error: `no Slack channel for channel ${channel}` };
    const t = this.agentToken(as);
    if (!t.ok) return { ok: false, error: t.error };
    const token = t.token;
    const r = await readOk<{ error?: string }>(this.fetch, POST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        channel: slackChannel,
        text,
        ...(thread !== undefined ? { thread_ts: thread } : {}),
      }),
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true };
  }

  /** Resolve a Slack user id to a name: the roster wins, then users.info (the
   *  app holds users:read). An id ABSENT from the roster resolves through
   *  users.info rather than passing through raw — a raw id matches no agent
   *  name, so a <@U…> mention would land silently unmentioned. Cached per
   *  acting credential (the `token` argument), so one agent's lookup can never
   *  reuse another agent's answer. */
  private async resolveName(token: string, user: string): Promise<string> {
    const cacheKey = `${token}:${user}`;
    const cached = this.nameCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const roster = this.roster[user];
    if (roster !== undefined) {
      this.nameCache.set(cacheKey, roster);
      return roster;
    }
    let name = user;
    const info = await readOk<{ user?: { name?: string } }>(
      this.fetch,
      `${USERS_INFO_URL}?user=${encodeURIComponent(user)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (info.ok && typeof info.data.user?.name === "string") name = info.data.user.name;
    this.nameCache.set(cacheKey, name);
    return name;
  }

  /** Normalize `<@U…>` to `@name`: an id in the roster resolves immediately; an
   *  id ABSENT from the roster resolves through (cached) users.info instead of
   *  passing through raw, so a mention never lands silently unmentioned. Resolved
   *  under the acting agent's own credential (`token`). */
  private async normalize(token: string, text: string): Promise<string> {
    let out = text;
    for (const m of text.matchAll(/<@([A-Z0-9]+)>/g)) {
      const uid = m[1]!;
      const name = await this.resolveName(token, uid);
      out = out.replace(`<@${uid}>`, `@${name}`);
    }
    return out;
  }

  /** Download every file on an event into filesDir, mapping each to an
   *  Attachment on the line. All downloads ride the ACTING agent's bot token
   *  (`token`), because Slack file access follows the app. A download failure
   *  is REPORTED (pushed onto `problems`) and the message still carries the
   *  file's metadata with no `path`, so the agent learns a file exists and that
   *  fetching it failed. */
  private async downloadFiles(token: string, files: SlackFileMeta[] | undefined): Promise<{ files: Attachment[]; problems: string[] }> {
    const problems: string[] = [];
    const output: Attachment[] = [];
    if (!files) return { files: output, problems };
    for (const f of files) {
      const id = f.id ?? "";
      const name = f.name ?? id ?? "file";
      const fileId = id === "" ? `dl-${output.length}` : id;
      const entry: Attachment = {
        id: fileId,
        name,
        mime: f.mimetype ?? "application/octet-stream",
        ...(f.size !== undefined ? { size: f.size } : {}),
      };
      if (f.url_private) {
        const r = await downloadFile(this.fetch, f.url_private, token, this.filesDir, fileId, name);
        if (r.ok) entry.path = r.path;
        else problems.push(r.error);
      }
      output.push(entry);
    }
    return { files: output, problems };
  }

  /** Turn one inbound event into an outbound Delivery, or undefined when it
   *  should be dropped (no text, an uninteresting event, an unknown channel).
   *  PURE: no self-suppression here — every line is returned, and the DELIVERY
   *  path (next/listen) decides who to suppress by NAME. Also downloads any
   *  `files` the event carries (under the ACTING agent's `token`) and reports a
   *  download failure that still leaves the message deliverable. */
  private async toDelivery(
    ev: SlackInboundEvent,
    as: string,
    token: string,
  ): Promise<{ delivery: Delivery | undefined; problems: string[] }> {
    if (ev.type !== "message" || !ev.text || ev.text === "") return { delivery: undefined, problems: [] };
    const channel = ev.channel;
    if (channel === undefined) return { delivery: undefined, problems: [] };
    // Normalize <@U…> mentions to @name, resolving unseen ids via users.info
    // under the acting agent's credential.
    const text = await this.normalize(token, ev.text);
    const from = await this.resolveSender(token, ev);
    const dmAgent = this.dmChannels[channel];
    const channelName = dmAgent === undefined ? this.channelById[channel] : `${DM_PREFIX}${dmAgent}/${from}`;
    if (channelName === undefined) return { delivery: undefined, problems: [] };
    // Slack ts is the per-channel cursor (no global seq), used as both ts and the
    // dedup id for a line.
    const ts = ev.ts ?? new Date().toISOString();
    const mentions = computeMentions(channelName, text, from);
    const thread = ev.thread_ts !== undefined && ev.thread_ts !== ts ? ev.thread_ts : undefined;
    const dl = await this.downloadFiles(token, ev.files);
    const delivery: Delivery = {
      seq: 0,
      ts,
      channel: channelName,
      from,
      text,
      id: ts,
      mentions,
      mentioned: this.addressesAgent(mentions, as),
      ...(thread !== undefined ? { thread } : {}),
    };
    if (dl.files.length > 0) delivery.files = dl.files;
    return { delivery, problems: dl.problems };
  }

  /** Resolve the sender's name: a user token shaped like a Slack id is looked
   *  up (roster then users.info under the acting agent's `token`); a plain
   *  username passes through. */
  private resolveSender(token: string, ev: SlackInboundEvent): Promise<string> {
    const u = ev.user;
    if (u !== undefined && u !== "" && /^[UW][A-Z0-9]+$/.test(u)) return this.resolveName(token, u);
    return Promise.resolve(ev.username ?? "");
  }

/** The connect-refusal report: a refused Socket Mode connection (e.g.
   *  invalid_auth answered by apps.connections.open) means scramble could NOT
   *  look, not that the channel was quiet. So the message names Slack's error
   *  AND the config key (`appToken`, the app-level xapp- token) that supplies
   *  the credential: a wrong or missing app token must never read as silence. */
  private connectRefused(e: unknown): string {
    const detail = e instanceof Error ? e.message : String(e);
    return `apps.connections.open refused: ${detail} (config key: appToken)`;
  }

  /** Open one Socket Mode connection: apps.connections.open with the ACTING
   *  agent's app-level token (its own per-agent appToken when present, else the
   *  top-level default), then the injected socket factory. */
  private async connectSocket(agent: string): Promise<{ socket: SlackSocket; close: () => void }> {
    const r = await readOk<{ url?: string }>(this.fetch, SOCKET_OPEN_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.appTokenFor(agent)}` },
    });
    if (!r.ok) throw new Error(r.error ?? "slack socket open failed");
    if (typeof r.data.url !== "string") throw new Error("slack socket open returned no url");
    const socket = this.createSocket(r.data.url);
    return {
      socket,
      close: () => socket.close(1000, "done"),
    };
  }

  /** ACK an envelope and route its event, honoring a server disconnect frame. */
  private routeFrame(raw: string, socket: SlackSocket, onEvent: (ev: SlackInboundEvent) => void): void {
    let env: Frame;
    try {
      env = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (env.type === "disconnect") {
      socket.close(1000, "disconnect");
      return;
    }
    if (env.envelope_id !== undefined) socket.send(JSON.stringify({ envelope_id: env.envelope_id }));
    if (env.type === "events_api" && env.payload?.event) onEvent(env.payload.event);
  }

  /** Route an inbound event through the channel filter and deliver. A download
   *  problem is reported via onProblem BEFORE the line is delivered, so the
   *  agent learns a file failed but still gets the message. The DELIVERY-only
   *  self-filter lives HERE: an agent's own post (resolved sender name equals
   *  the consuming agent's name) is never delivered, so an agent does not
   *  answer itself — the same name mechanism the local backend applies to its
   *  stream. history never passes through here, so a transcript read keeps
   *  every line. */
  private deliver(
    ev: SlackInboundEvent,
    channels: string[],
    as: string,
    token: string,
    wantsAll: boolean,
    statusTts: ReadonlySet<string> | undefined,
    onLine: (d: Delivery) => void,
    onProblem: (p: string) => void,
  ): void {
    void this.toDelivery(ev, as, token).then(({ delivery, problems }) => {
      for (const p of problems) onProblem(p);
      if (delivery === undefined) return;
      // An agent never delivers its own posts (it would otherwise answer itself).
      if (delivery.from === as) return;
      // A message that IS a living status must reach no listener — status is
      // never a message. Decided by ts against the caller-passed set (the
      // ledger's authority), never by matching "working", so a human saying the
      // word is still delivered.
      if (statusTts !== undefined && delivery.ts !== undefined && statusTts.has(delivery.ts)) return;
      if (wantsAll || channels.includes(delivery.channel)) {
        onLine(delivery);
      }
    });
  }

  /** Build one Message from a Slack history/replies row through the SAME
   *  ingest path as a live event, so its thread/mentions/files come out
   *  byte-identical, and append it to `messages`. Returns the seq after the
   *  append (the prior seq when the row carries no text and is dropped). */
  private async appendLine(
    m: SlackHistoryMessage,
    slackChannel: string,
    channel: string,
    messages: Message[],
    problems: string[],
    seq: number,
    statusTts: ReadonlySet<string> | undefined,
    token: string,
  ): Promise<number> {
    const { delivery, problems: dlProblems } = await this.toDelivery(
      { type: "message", channel: slackChannel, user: m.user, username: m.user, ts: m.ts, thread_ts: m.thread_ts, text: m.text, bot_id: m.bot_id, files: m.files },
      "",
      token,
    );
    problems.push(...dlProblems);
    if (delivery === undefined) return seq;
    // A line that IS a living status is absent from history. The set of status
    // ts is passed in by the caller (which reads the ledger), so the backend
    // holds no notion of where the ledger lives, and the decision keys on the
    // ts, never on text ("working"), so a human's own words stay readable.
    if (statusTts !== undefined && delivery.ts !== undefined && statusTts.has(delivery.ts)) return seq;
    // history is channel-scoped: force the requested `channel` (a Slack id tells us
    // the Slack channel, the channel mapping is the caller's frame). Slack has no
    // global seq, so a synthetic per-history counter stands in where the
    // local line's `seq` lives; the message's ts is the real cursor.
    const { mentioned, ...rest } = delivery;
    void mentioned;
    messages.push({ ...rest, channel, seq: seq + 1 });
    return seq + 1;
  }

  /** history(channel, since): conversations.history mapped into the local line
   *  shape (a channel-scoped Message with mentions). `since` maps to Slack's
   *  `oldest` cursor, so a resume picks up where the last ts stopped.
   *
   *  THREADED REPLIES: conversations.history returns only TOP-LEVEL messages; a
   *  threaded reply lives under conversations.replies. A top-level row Slack
   *  marks as a threaded ROOT (reply_count above zero with thread_ts equal to
   *  its own ts) is expanded here with one conversations.replies call, so
   *  `message read` and `message history` see the replies an agent posted under
   *  that root. The root is never duplicated: conversations.replies returns the
   *  root as its first entry, so that entry (whose ts equals the root's) is
   *  dropped; a root that merely HAS replies is not itself a reply and carries
   *  no `thread`, while each reply's `thread` names the root by the ingest
   *  rule (thread_ts differs from its own ts). */
  async history(
    channel: string,
    since?: string,
    statusTts?: ReadonlySet<string>,
    as?: string,
  ): Promise<{ code: 0 | 1; error?: string; messages: Message[]; problems: string[] }> {
    const slackChannel = this.channels[channel];
    if (!slackChannel) return { code: 1, error: `no Slack channel for channel ${channel}`, messages: [], problems: [] };
    const t = this.agentToken(as ?? "");
    if (!t.ok) return { code: 1, error: t.error, messages: [], problems: [] };
    const token = t.token;
    const qs = since !== undefined ? `&oldest=${encodeURIComponent(since)}` : "";
    const r = await readOk<{ messages?: SlackHistoryMessage[] }>(
      this.fetch,
      `${HISTORY_URL}?channel=${encodeURIComponent(slackChannel)}${qs}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return { code: 1, error: r.error, messages: [], problems: [] };
    const messages: Message[] = [];
    const problems: string[] = [];
    let seq = 0;
    // ORDER — a caller keeps its cursor on ts: conversations.history returns
    // rows NEWEST-FIRST and we walk them in exactly that order (Slack's ts is
    // the per-channel cursor). A threaded root's replies land IN PLACE,
    // immediately UNDER the root (conversations.replies lists the root first,
    // then its replies), so a resume at a ts sees every line after it in the
    // same relative order it always used — a reply never reorders a line above
    // its own root, and the read is a single pass preserving Slack's newest-
    // first sequence overall.
    let expandedRoots = 0;
    let droppedRoots = 0;
    for (const m of r.data.messages ?? []) {
      seq = await this.appendLine(m, slackChannel, channel, messages, problems, seq, statusTts, token);
      if (!isThreadRoot(m)) continue;
      // FAN-OUT IS BOUND: one extra conversations.replies request per threaded
      // root, capped at THREAD_EXPANSION_CAP on the NEWEST roots (history walks
      // newest-first). Unbounded expansion on a busy channel is unacceptable.
      if (expandedRoots >= THREAD_EXPANSION_CAP) {
        droppedRoots += 1;
        continue;
      }
      expandedRoots += 1;
      const rootTs = m.ts ?? "";
      const rep = await readOk<{ messages?: SlackHistoryMessage[] }>(
        this.fetch,
        `${REPLIES_URL}?channel=${encodeURIComponent(slackChannel)}&ts=${encodeURIComponent(rootTs)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      // A replies request that fails must not fail the whole read: keep the
      // top-level messages, REPORT the problem, carry on.
      if (!rep.ok) {
        problems.push(`thread replies failed for root ${rootTs}: ${rep.error ?? "slack call failed"}`);
        continue;
      }
      for (const reply of rep.data.messages ?? []) {
        // conversations.replies returns the ROOT as its first entry; the root
        // already appeared exactly once above with no `thread`, so drop it.
        if (reply.ts !== undefined && reply.ts === m.ts) continue;
        seq = await this.appendLine(reply, slackChannel, channel, messages, problems, seq, statusTts, token);
      }
    }
    if (droppedRoots > 0) {
      // A dropped root must never look like an empty thread: the cap truncates
      // the read, so it is REPORTED through the same problems channel a partial
      // read already uses, naming how many roots went unexpanded.
      problems.push(`read capped: ${droppedRoots} threaded root(s) left unexpanded`);
    }
    return { code: 0, messages, problems };
  }

  /** next(channels, as, timeoutSecs, onProblem): block for ONE message then
   *  resolve 0; exit-64 semantics preserved by timing out with nothing
   *  delivered-and-nothing-printed. A connection that CANNOT be established
   *  (a refused apps.connections.open, e.g. invalid_auth) resolves with
   *  code 1 — scramble could not look — never the quiet-channel 64. */
  async next(
    channels: string[],
    as: string,
    timeoutSecs: number,
    onProblem: (p: string) => void,
    statusTts?: ReadonlySet<string>,
  ): Promise<{ code: 0; line: Delivery } | { code: 64 } | { code: 1; error: string }> {
    const deadline = this.now() + timeoutSecs * 1000;
    const wantsAll = channels.length === 0;
    const t = this.agentToken(as);
    if (!t.ok) {
      // An agent with no token and no default has nothing to act on: FAIL naming
      // the agent and the key, never a silent nothing.
      onProblem(t.error);
      return { code: 1, error: t.error };
    }
    const token = t.token;
    // Connect asynchronously; the caller-facing promise settles on the first
    // matching delivery OR the deadline OR a refused connection, whichever
    // comes first.
    return new Promise((resolve) => {
      let conn: { socket: SlackSocket; close: () => void } | undefined;
      let settled = false;
      const settle = (v: { code: 0; line: Delivery } | { code: 64 } | { code: 1; error: string }): void => {
        if (settled) return;
        settled = true;
        conn?.close();
        resolve(v);
      };
      void this.connectSocket(as).then(
        (c) => {
          if (settled) return;
          conn = c;
          c.socket.onmessage = (raw) =>
            this.routeFrame(raw, c.socket, (ev) => {
              this.deliver(ev, channels, as, token, wantsAll, statusTts, (d) => settle({ code: 0, line: d }), onProblem);
            });
          if (this.now() >= deadline) settle({ code: 64 });
        },
        (e) => {
          // A refused connection means scramble could not look. The caller must
          // tell a broken credential apart from a quiet channel, so we settle
          // with code 1 — THE CODE FOR "scramble could not look"; 64 is
          // reserved for "the channel was quiet" — and report a message naming
          // the Slack error and the appToken config key.
          const msg = this.connectRefused(e);
          onProblem(msg);
          settle({ code: 1, error: msg });
        },
      );
      void this.sleep(timeoutSecs * 1000).then(() => {
        if (this.now() >= deadline) settle({ code: 64 });
      });
    });
  }

  /** listen(channels, as, onLine, onProblem): the Socket Mode event stream, ONE
   *  JSON line per message as the local backend emits. A connection that ONCE
   *  worked keeps its backoff and RECONNECTS when it drops; a connection that
   *  NEVER once succeeded FAILS (returns 1) instead of retrying a refusal into
   *  silence — a broken app token must not scroll past an unattended watch.
   *  The healthy stream never resolves; the only terminating return is 1. */
  async listen(
    channels: string[],
    as: string,
    onLine: (d: Delivery) => void,
    onProblem: (p: string) => void,
    statusTts?: ReadonlySet<string>,
  ): Promise<number> {
    const wantsAll = channels.length === 0;
    const t = this.agentToken(as);
    if (!t.ok) {
      // An agent with no token and no default has nothing to act on: FAIL naming
      // the agent and the key, never a silent nothing.
      onProblem(t.error);
      return 1;
    }
    const token = t.token;
    let everConnected = false;
    let backoff = RECONNECT_BACKOFF;
    for (;;) {
      const opened = await this.listenOnce(channels, wantsAll, as, token, onLine, onProblem, statusTts);
      if (opened) everConnected = true;
      // The FIRST connection could not be established: scramble could not look,
      // so it fails rather than retrying the same refusal forever. 64 is the
      // quiet-channel code; 1 is "scramble could not look".
      if (!opened && !everConnected) return 1;
      // A connection that worked then dropped is reconnected with backoff.
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_RECONNECT_BACKOFF);
    }
  }

  /** Connect once, deliver events until the socket closes, and report whether
   *  the OPEN established. TRUE when the connection came up (even if it later
   *  dropped); FALSE when the open itself failed. A dropped connection keeps
   *  the loop alive with backoff. */
  private listenOnce(
    channels: string[],
    wantsAll: boolean,
    as: string,
    token: string,
    onLine: (d: Delivery) => void,
    onProblem: (p: string) => void,
    statusTts?: ReadonlySet<string>,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let established = false;
      void this.connectSocket(as).then(
        (c) => {
          established = true;
          c.socket.onmessage = (raw) =>
            this.routeFrame(raw, c.socket, (ev) => this.deliver(ev, channels, as, token, wantsAll, statusTts, onLine, onProblem));
          c.socket.onclose = () => resolve(established);
        },
        (e) => {
          onProblem(this.connectRefused(e));
          resolve(false);
        },
      );
    });
  }
}