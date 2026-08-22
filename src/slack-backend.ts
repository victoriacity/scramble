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
import { STATUS_METADATA_TYPE } from "./status";
import { originMetadata, readOrigin, type Origin } from "./origin";
import { downloadFile, uploadToSlack, type SlackFileMeta } from "./attachments";

// --- slack endpoint URLs ------------------------------------------------

const SOCKET_OPEN_URL = "https://slack.com/api/apps.connections.open";
const POST_URL = "https://slack.com/api/chat.postMessage";
const HISTORY_URL = "https://slack.com/api/conversations.history";
/** Slack omits message metadata from a read unless it is asked for, and the
 *  status marker lives there, so every read this backend makes asks for it. */
const WITH_METADATA = "include_all_metadata=true";
const REPLIES_URL = "https://slack.com/api/conversations.replies";
const USERS_INFO_URL = "https://slack.com/api/users.info";
/** Slack's broadcasts, which address everyone who can read the channel. Exported
 *  because the inbox ledger needs the same list: a broadcast names no single
 *  agent, and it is still addressed to each of them. */
export const BROADCAST_NAMES = ["channel", "here", "everyone"];

const AUTH_TEST_URL = "https://slack.com/api/auth.test";
const AUTH_TEAMS_LIST_URL = "https://slack.com/api/auth.teams.list";
const USERS_LIST_URL = "https://slack.com/api/users.list";
const REACT_URL = "https://slack.com/api/reactions.add";
const CONV_INFO_URL = "https://slack.com/api/conversations.info";
const USERS_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";

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
  /** `member_joined_channel` carries the id of the member who joined and, when
   *  someone added them, the inviter. */
  inviter?: string;
  /** Slack message metadata; a scramble status carries STATUS_METADATA_TYPE and
   *  an ordinary message carries its sender's ORIGIN_METADATA_TYPE. */
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
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
  agents: Record<string, { token?: string; appToken?: string; handle?: string; appId?: string }>;
  /** Slack user id of the human who authorized this machine's session. */
  humanUserId?: string;
  /** Where THIS process runs, stamped onto every message it posts so peers can
   *  learn it without anyone typing it into prose. */
  origin?: Origin;
  /** The Slack CLI's app-configuration token, when this host has one. It is the
   *  ONLY credential that can read another app's description
   *  (apps.manifest.export), since users.info returns an empty title for a bot
   *  and bots.info carries no description at all. Absent on a host without the
   *  CLI, where peer descriptions are simply unavailable. */
  cliToken?: string;
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
  /** Slack message metadata; a scramble status carries STATUS_METADATA_TYPE and
   *  an ordinary message carries its sender's ORIGIN_METADATA_TYPE. */
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
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

/** Is this line a scramble status rather than something someone said? Keyed on
 *  the metadata the status manager stamps, so ANY agent recognises ANY agent's
 *  status, and never on the text, because a human is allowed to say "working".
 *  The ts ledger cannot answer this: it only ever knew this agent's own. */
export function isStatusLine(m: { metadata?: { event_type?: string } }): boolean {
  return m.metadata?.event_type === STATUS_METADATA_TYPE;
}

/** Turn `@name` into Slack's `<@U…>` entity on the way OUT, the mirror of what
 *  `normalize` does on the way in. Without it a mention an agent writes is
 *  literal text: Slack renders it grey and a HUMAN gets no notification, while
 *  agents still wake because the receive path parses `@name` itself, so the
 *  defect is invisible from an agent's side (peer agent, 2026-08-21, confirmed
 *  in Slack's raw record).
 *
 *  `roster` is id -> name, so it is inverted here. A name nobody in the roster
 *  answers to stays LITERAL, since a made-up entity renders worse than plain
 *  text, and a fenced block is left alone, because an `@name` in a code sample is
 *  a code sample. Pure, so the fence and unknown-name rules are unit-tested. */
export function denormalize(text: string, roster: Record<string, string>): string {
  const idOf = new Map<string, string>();
  for (const [id, name] of Object.entries(roster)) idOf.set(name, id);
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    out.push(
      fenced || line.trimStart().startsWith("```")
        ? line
        : line.replace(/(^|\s)@([A-Za-z0-9._-]+)/g, (whole, lead: string, name: string) => {
            const id = idOf.get(name);
            return id === undefined ? whole : `${lead}<@${id}>`;
          }),
    );
  }
  return out.join("\n");
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
  private readonly agents: Record<string, { token?: string; appToken?: string; handle?: string; appId?: string }>;
  private readonly humanUserId?: string;
  private readonly cliToken?: string;
  /** Slack user id -> its published description, or "" when it has none. */
  private readonly describeCache = new Map<string, string>();
  /** `<channel>/<root>/<agent>` -> is that agent in that thread. */
  private readonly threadCache = new Map<string, boolean>();
  /** Slack channel id -> its scramble name, for channels absent from the config. */
  private readonly channelNameCache = new Map<string, string>();
  /** Channel name -> its Slack id, "" for a name this agent cannot reach. */
  private readonly channelIdCache = new Map<string, string>();
  private readonly teamIdCache = new Map<string, string>();
  /** Timestamps already delivered in this process, so one message arriving under
   *  two event types is one line. Bounded by the life of a listener, which is
   *  what it is scoped to. */
  private readonly deliveredTs = new Set<string>();
  /** users.list is paged at most once per process; a name Slack does not have is
   *  remembered as a miss so an unknown name costs one lookup, never one each. */
  private rosterLoaded = false;
  private readonly rosterMisses = new Set<string>();
  private readonly roster: Record<string, string>;
  private readonly origin: Origin | undefined;
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
    this.humanUserId = cfg.humanUserId;
    this.cliToken = cfg.cliToken;
    this.roster = cfg.roster;
    this.origin = cfg.origin;
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
  /** operator, teammate, or agent. A `bot_id` on the event is Slack telling us
   *  an app spoke; among humans the configured `humanUserId` is the one who
   *  authorized this session. Undefined when no humanUserId is configured,
   *  because guessing which human is the operator is worse than saying nothing. */
  private senderKind(ev: SlackInboundEvent): "operator" | "teammate" | "agent" | undefined {
    if (ev.bot_id !== undefined && ev.bot_id !== "") return "agent";
    if (this.humanUserId === undefined || this.humanUserId === "") return undefined;
    return ev.user === this.humanUserId ? "operator" : "teammate";
  }

  /** Every name this agent answers to: its scramble name and, when recorded,
   *  its Slack handle. PUBLIC because `message check` in the CLI does its own
   *  delivery filtering and needs the same answer; two copies of "who is this
   *  agent" is how the handle mismatch reached three places at once. */
  identities(agent: string): string[] {
    const handle = this.agents[agent]?.handle;
    return handle !== undefined && handle !== "" && handle !== agent ? [agent, handle] : [agent];
  }

  private addressesAgent(mentions: string[], agent: string): boolean {
    if (mentions.some((m) => BROADCAST_NAMES.includes(m))) return true;
    return this.identities(agent).some((id) => mentions.includes(id));
  }

  /** The sender's published description, or undefined when there is none to
   *  read. Two hops, cached per user: users.info gives the speaker's
   *  `api_app_id`, and apps.manifest.export under the CLI credential gives that
   *  app's description. A peer agent's remit read from its first line is worth
   *  the hops, since otherwise an agent learns what a peer is for only when the
   *  peer explains itself (peer agent, 2026-08-21). */
  private async describeSender(token: string, ev: SlackInboundEvent): Promise<string | undefined> {
    const user = ev.user;
    if (this.cliToken === undefined || this.cliToken === "" || user === undefined || user === "") return undefined;
    const cached = this.describeCache.get(user);
    if (cached !== undefined) return cached === "" ? undefined : cached;
    const who = await readOk<{ user?: { profile?: { api_app_id?: string } } }>(
      this.fetch,
      `${USERS_INFO_URL}?user=${encodeURIComponent(user)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const appId = who.ok ? who.data.user?.profile?.api_app_id : undefined;
    if (appId === undefined || appId === "") {
      this.describeCache.set(user, "");
      return undefined;
    }
    const m = await readOk<{ manifest?: { display_information?: { description?: string } } }>(
      this.fetch,
      "https://slack.com/api/apps.manifest.export",
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.cliToken}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: appId }),
      },
    );
    const d = m.ok ? m.data.manifest?.display_information?.description ?? "" : "";
    this.describeCache.set(user, d);
    return d === "" ? undefined : d;
  }

  /** Is this agent IN that thread? A reply inside a thread you started, or
   *  answered in, is addressed to you whether or not it names you: that is how
   *  Slack treats a thread for a human, and matching only on the name misses
   *  every threaded answer to something you said (operator, 2026-08-21).
   *
   *  Answered from Slack's own record rather than a local ledger, so it stays
   *  right across restarts, across machines, and for threads that predate this
   *  code. Cached per root, since a busy thread asks the same question repeatedly. */
  private async inThread(token: string, channelId: string, root: string, agent: string): Promise<boolean> {
    const key = `${channelId}/${root}/${agent}`;
    const cached = this.threadCache.get(key);
    if (cached !== undefined) return cached;
    const r = await readOk<{ messages?: Array<{ user?: string; username?: string; bot_id?: string }> }>(
      this.fetch,
      `${REPLIES_URL}?channel=${encodeURIComponent(channelId)}&ts=${encodeURIComponent(root)}&limit=200`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return false;
    const ids = this.identities(agent);
    let mine = false;
    for (const m of r.data.messages ?? []) {
      const who = await this.resolveSender(token, { type: "message", user: m.user, username: m.username });
      if (ids.includes(who)) {
        mine = true;
        break;
      }
    }
    this.threadCache.set(key, mine);
    return mine;
  }

  private appTokenFor(agent: string): string {
    return this.agents[agent]?.appToken ?? this.appToken ?? "";
  }

  /** The acting agent's token when it has one, else the config default. Used for
   *  a LOOKUP, where a refusal costs a name rather than a message, so falling
   *  back is better than failing before the verb reports its own error. */
  private tokenOrDefault(agent: string): string {
    const t = this.agentToken(agent);
    return t.ok ? t.token : this.token;
  }

  /** Teach the roster every @name in this text that it does not already know,
   *  by asking Slack who is in the workspace.
   *
   *  THE ROSTER IS A CACHE, and it was being used as the authority. It is written
   *  at onboarding, so anyone who joins afterwards is absent from it, and
   *  `denormalize` leaves an unknown name as literal text. Same shape as the
   *  channel map, which was also a hand-kept copy of something Slack holds.
   *
   *  WHICH OF THE TWO MENTION PATHS THIS IS FOR, since they are separate and I
   *  conflated them: the Slack ENTITY drives the notification a HUMAN gets, and
   *  this is the path that was broken. The `mentioned` stamp that wakes an AGENT
   *  is computed by computeMentions from the text's `@name` tokens, after inbound
   *  entities have been normalized back to names, so a literal name wakes an
   *  agent perfectly well and always did. The receiving agent measured exactly
   *  that and corrected me: "From inside the agent that was supposed to have
   *  missed those messages, nothing was missed" (2026-08-22).
   *
   *  So: a gap here costs a person their notification, and costs an agent
   *  nothing.
   *
   *  users.list is paged ONCE per process and only when a name is unknown, so an
   *  agent talking to people it already knows pays nothing. A name Slack does not
   *  have stays literal, which is correct: it is not a person here. */
  private async learnNames(token: string, text: string): Promise<void> {
    const known = new Set(Object.values(this.roster));
    const wanted = new Set<string>();
    for (const m of text.matchAll(/(^|\s)@([A-Za-z0-9._-]+)/g)) {
      const name = m[2];
      if (name !== undefined && !known.has(name) && !this.rosterMisses.has(name)) wanted.add(name);
    }
    if (wanted.size === 0 || this.rosterLoaded) {
      for (const w of wanted) this.rosterMisses.add(w);
      return;
    }
    this.rosterLoaded = true;
    const team = await this.teamIdFor(token);
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const q =
        `${USERS_LIST_URL}?limit=200` +
        (team === "" ? "" : `&team_id=${encodeURIComponent(team)}`) +
        (cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`);
      const r = await readOk<{
        members?: Array<{ id?: string; name?: string; deleted?: boolean }>;
        response_metadata?: { next_cursor?: string };
      }>(this.fetch, q, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) break;
      for (const u of r.data.members ?? []) {
        if (u.deleted === true) continue;
        if (typeof u.id === "string" && typeof u.name === "string" && this.roster[u.id] === undefined) {
          this.roster[u.id] = u.name;
        }
      }
      cursor = r.data.response_metadata?.next_cursor ?? "";
      if (cursor === "") break;
    }
    const after = new Set(Object.values(this.roster));
    for (const w of wanted) if (!after.has(w)) this.rosterMisses.add(w);
  }

  /** This agent's WORKSPACE id, which conversations.list requires on an org
   *  install: without it Slack answers `missing_argument` and every name lookup
   *  fails.
   *
   *  From auth.teams.list, which is the only method that names WORKSPACES, and
   *  not from auth.test. On an enterprise install auth.test reports
   *  `team_id` = the E… ORG (identical to its own `enterprise_id`), and
   *  conversations.list answers `team_access_not_granted` to that — so reading
   *  the obvious field gives an id that is wrong in a way whose error names
   *  neither the field nor the fix. Measured against this org: auth.test says
   *  E0EXAMPLE010, auth.teams.list says T0EXAMPLE012, and only the second works.
   *
   *  Empty when the login covers no workspace or several, since there is then no
   *  single answer to invent; the lookup still runs, and Slack's own refusal is
   *  what the caller reports. Cached per token: it cannot change under a running
   *  process. */
  private async teamIdFor(token: string): Promise<string> {
    const hit = this.teamIdCache.get(token);
    if (hit !== undefined) return hit;
    const r = await readOk<{ teams?: Array<{ id?: string }> }>(this.fetch, AUTH_TEAMS_LIST_URL, {
      headers: { authorization: `Bearer ${token}` },
    });
    const teams = r.ok ? (r.data.teams ?? []) : [];
    const only = teams.length === 1 ? teams[0]?.id : undefined;
    const id = typeof only === "string" ? only : "";
    this.teamIdCache.set(token, id);
    return id;
  }

  /** The Slack id for a channel NAME, or the id itself when the caller already
   *  has one. The config's map wins; a name absent from it is looked up among
   *  the conversations this agent is actually in.
   *
   *  The mirror of channelNameFor, and it was missing: after inbound resolution
   *  landed, a peer measured 129 messages arriving from a channel whose name
   *  `message read`, `send`, `react` and `channel join` all refused with "no
   *  Slack channel for channel <name>". An agent could hear a room and not answer
   *  in it. Cached, including the miss, so a wrong name costs one lookup.
   *
   *  RETURNS SLACK'S OWN REFUSAL rather than a bare miss. The lookup used to
   *  `break` out of the paging loop on any API error and report the same "no
   *  Slack channel for <name>" a genuine typo produces, so the two were
   *  indistinguishable — and on this org EVERY lookup was the error one, because
   *  conversations.list needs a team_id it was not being given. The name of the
   *  channel the operator had just invited an agent into came back as if the
   *  channel did not exist. */
  /** The Slack channel id for a scramble channel name, under an agent's own
   *  credential, or undefined when it cannot be resolved.
   *
   *  Public so the STATUS path resolves the same way the post path does. It read
   *  a hand-kept map and nothing else, so a channel absent from the map (every
   *  channel an agent was invited into without a config edit) and a map entry
   *  gone stale both ended as `status: channel_not_found`, in a feature that has
   *  already been silently dead once for that exact error (2026-08-21). */
  async channelIdFor(agent: string, name: string): Promise<string | undefined> {
    const r = await this.slackChannelFor(this.tokenOrDefault(agent), name);
    return r.id;
  }

  private async slackChannelFor(
    token: string,
    name: string,
  ): Promise<{ id: string; error?: undefined } | { id?: undefined; error: string }> {
    const mapped = this.channels[name];
    if (mapped !== undefined) return { id: mapped };
    // A RAW SLACK ID IS ALREADY THE ANSWER. `channel` here is a scramble name
    // that usually is not one, but an agent reading an id out of an event or a
    // log has the very thing the lookup is for, and sending it through
    // conversations.list only asks whether some channel is NAMED "C0EXAMPLE007".
    if (/^[CGD][A-Z0-9]{6,}$/.test(name)) return { id: name };
    const cached = this.channelIdCache.get(name);
    if (cached !== undefined && cached !== "") return { id: cached };
    const team = await this.teamIdFor(token);
    let cursor = "";
    // THE AGENT'S OWN CONVERSATIONS, not the workspace's. users.conversations
    // returns exactly the channels this token is a member of, which is exactly
    // the set it can act on: a bot cannot post to, read or react in a channel it
    // was never invited to, so a name matching some other channel resolves to an
    // id that then fails with `not_in_channel` — a worse answer than saying the
    // agent is not in it.
    //
    // conversations.list was the wrong instrument twice over. It answers with
    // the whole workspace, measured here at 203 channels against the 2 this
    // agent is in, so the walk was a hundred times the size of the question; and
    // it was capped at ten pages, which on a workspace past 2000 channels stops
    // and reports the same "no Slack channel" a typo produces. Raised by the
    // model-failure-research agent, which could not resolve a private channel it
    // was in — I could not reproduce that part (paged with a team_id,
    // conversations.list did list every private channel each agent belongs to),
    // and the change is right for the reasons above rather than that one.
    for (let page = 0; page < 10; page++) {
      const q =
        `${USERS_CONVERSATIONS_URL}?types=public_channel,private_channel&exclude_archived=true&limit=200` +
        (team === "" ? "" : `&team_id=${encodeURIComponent(team)}`) +
        (cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`);
      const r = await readOk<{
        channels?: Array<{ id?: string; name?: string }>;
        response_metadata?: { next_cursor?: string };
      }>(this.fetch, q, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) {
        return {
          error:
            `looking up the Slack channel for "${name}" failed: users.conversations answered ` +
            `${r.error}. This is NOT "no such channel" — Slack refused the question.`,
        };
      }
      for (const c of r.data.channels ?? []) {
        if (c.name === name && typeof c.id === "string") {
          this.channelIdCache.set(name, c.id);
          return { id: c.id };
        }
      }
      cursor = r.data.response_metadata?.next_cursor ?? "";
      if (cursor === "") break;
    }
    this.channelIdCache.set(name, "");
    return {
      error:
        `no Slack channel for channel ${name}: this agent is not in a channel by that name. ` +
        `An app cannot add itself to a Slack conversation, so a member has to invite it.`,
    };
  }

  /** This agent's own Slack user id, from the roster the config already keeps
   *  (id -> name), inverted against the agent's identities. Undefined when the
   *  roster does not name it, in which case a join event cannot be told apart
   *  from anyone else's and is left alone. */
  private userIdFor(agent: string): string | undefined {
    const names = this.identities(agent);
    for (const [id, name] of Object.entries(this.roster)) if (names.includes(name)) return id;
    return undefined;
  }

  /** The scramble name for a Slack channel id. The config's mapping wins; a
   *  channel ABSENT from it is asked about through conversations.info, and the
   *  raw id stands in when even that is refused.
   *
   *  It used to return undefined for an unmapped channel and the message was
   *  dropped, silently and with nothing reported, so inviting an agent to a new
   *  channel delivered NOTHING until someone hand-edited slack.json (operator,
   *  2026-08-22). An agent that has been invited somewhere should hear it, and a
   *  name it cannot look up is a naming problem rather than a reason to lose the
   *  message. Cached per id. */
  private async channelNameFor(token: string, id: string): Promise<string> {
    const cached = this.channelNameCache.get(id);
    if (cached !== undefined) return cached;
    const r = await readOk<{ channel?: { name?: string } }>(
      this.fetch,
      `${CONV_INFO_URL}?channel=${encodeURIComponent(id)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const name = r.ok && typeof r.data.channel?.name === "string" && r.data.channel.name !== ""
      ? r.data.channel.name
      : id;
    this.channelNameCache.set(id, name);
    return name;
  }

  /** React to a message with an emoji. A reaction is how a channel acknowledges
   *  without spending a line, which is the point: an agent that answers "got it"
   *  in prose has added noise where a tick would have done.
   *
   *  `already_reacted` is reported as success, since the state the caller wanted
   *  is the state that holds. */
  async react(
    channel: string,
    ts: string,
    emoji: string,
    as: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as), channel);
    if (resolved.id === undefined) return { ok: false, error: resolved.error };
    const slackChannel = resolved.id;
    const t = this.agentToken(as);
    if (!t.ok) return { ok: false, error: t.error };
    const name = emoji.replace(/^:|:$/g, "");
    const r = await readOk<{ error?: string }>(this.fetch, REACT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ channel: slackChannel, timestamp: ts, name }),
    });
    if (!r.ok) {
      if (r.error.includes("already_reacted")) return { ok: true };
      return { ok: false, error: r.error };
    }
    return { ok: true };
  }

  /** Every channel this agent is a MEMBER of, by name.
   *
   *  The sweep used to walk `cfg.channels`, a hand-kept map in a config several
   *  agents share and edit. On 2026-08-22 a peer removed two entries while
   *  testing name resolution, and my own `message check` stopped covering the
   *  channel the operator talks to me in: it reported "none of the 3 configured
   *  channels are readable" and swept nothing that mattered, while the listener
   *  kept delivering, so nothing looked broken.
   *
   *  Membership is a fact Slack holds. Asking it is one call, and it cannot fall
   *  out of date the way a map maintained by hand does. */
  async myChannels(as: string): Promise<{ names: string[]; problem?: string }> {
    const token = this.tokenOrDefault(as);
    const team = await this.teamIdFor(token);
    const names: string[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const q =
        `${USERS_CONVERSATIONS_URL}?types=public_channel,private_channel&exclude_archived=true&limit=200` +
        (team === "" ? "" : `&team_id=${encodeURIComponent(team)}`) +
        (cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`);
      const r = await readOk<{
        channels?: Array<{ id?: string; name?: string }>;
        response_metadata?: { next_cursor?: string };
      }>(this.fetch, q, { headers: { authorization: `Bearer ${token}` } });
      // REPORTED, never an empty list read as "in nothing": an agent in no
      // channels and an agent whose membership call was refused look identical
      // from the outside, and one of them is a broken credential.
      if (!r.ok) return { names, problem: `listing this agent's channels failed: ${r.error}` };
      for (const c of r.data.channels ?? []) {
        if (typeof c.name === "string" && c.name !== "") {
          names.push(c.name);
          if (typeof c.id === "string") this.channelIdCache.set(c.name, c.id);
        }
      }
      cursor = r.data.response_metadata?.next_cursor ?? "";
      if (cursor === "") break;
    }
    return { names };
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
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as), channel);
    if (resolved.id === undefined) return { ok: false, error: resolved.error };
    const slackChannel = resolved.id;
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
   *  as a success.
 *
 *  It returns the ts Slack gave the message, so the ledger can name the actual
 *  reply that closed an item. Without it `answeredBy` held a wall-clock string
 *  pointing at nothing, which `inbox trace` printed and made obvious. */
  async post(
    channel: string,
    text: string,
    as: string,
    thread?: string,
  ): Promise<{ ok: true; ts?: string; problem?: string } | { ok: false; error: string }> {
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as), channel);
    if (resolved.id === undefined) return { ok: false, error: resolved.error };
    const slackChannel = resolved.id;
    const t = this.agentToken(as);
    if (!t.ok) return { ok: false, error: t.error };
    const token = t.token;
    // A NAME SLACK KNOWS BUT THE ROSTER DOES NOT would go out as literal text
    // and notify nobody, which is what happened the hour a third agent joined.
    await this.learnNames(token, text);
    const r = await readOk<{ error?: string; ts?: string; message?: { thread_ts?: string } }>(this.fetch, POST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        channel: slackChannel,
        text: denormalize(text, this.roster),
        ...(thread !== undefined ? { thread_ts: thread } : {}),
        // WHERE THIS AGENT RUNS, on the message itself. Slack carries metadata
        // through history and through the socket, which is how a peer's status
        // line is already recognised, so this needs no app change from anyone
        // and works for an app owned by a different login.
        ...(this.origin === undefined ? {} : { metadata: originMetadata(this.origin) }),
      }),
    });
    if (!r.ok) return { ok: false, error: r.error };
    // A THREAD_TS THAT IS NOT A MESSAGE IS ACCEPTED IN SILENCE. Measured against
    // this workspace: posting with a ts that names no message answers ok:true,
    // puts the line at the TOP LEVEL of the channel, and the response carries no
    // message.thread_ts. One mistyped digit put a reply to the operator outside
    // the thread it answered, and the send reported success.
    //
    // The response is the evidence and it costs nothing to read: a threaded post
    // that comes back without message.thread_ts was not threaded. Reported as a
    // PROBLEM rather than an error, because the message did reach the channel and
    // a caller that retries would say everything twice.
    if (thread !== undefined && thread !== "") {
      const landed = r.data.message?.thread_ts;
      if (landed === undefined) {
        return {
          ok: true,
          ...(typeof r.data.ts === "string" ? { ts: r.data.ts } : {}),
          problem:
            `posted to ${channel} at TOP LEVEL, and NOT in thread ${thread}: Slack accepted that ` +
            `thread_ts and threaded nothing, which means it names no message in this channel. ` +
            `The message IS in the channel, at ts ${String(r.data.ts ?? "unknown")}.`,
        };
      }
      // A THREAD_TS NAMING A REPLY IS HOISTED, silently. Slack has no nested
      // threads, so it puts the message in that reply's ROOT and answers with
      // the root's ts. Measured: aiming at a reply landed the message in the
      // root thread and returned the root's thread_ts, so a check for "did it
      // thread at all" passes while the message is in a different conversation
      // than the one asked for. A peer hit this on the same commit I had
      // measured, and saw no warning (2026-08-22).
      if (landed !== thread) {
        return {
          ok: true,
          ...(typeof r.data.ts === "string" ? { ts: r.data.ts } : {}),
          problem:
            `posted to ${channel} in thread ${landed}, and NOT in ${thread} as asked: Slack has no ` +
            `nested threads, so a thread_ts naming a REPLY is hoisted into that reply's root. ` +
            `The message IS in the channel, at ts ${String(r.data.ts ?? "unknown")}. Pass the ` +
            `root's ts, which a delivered line carries as its own \`thread\`.`,
        };
      }
    }
    return { ok: true, ...(typeof r.data.ts === "string" ? { ts: r.data.ts } : {}) };
  }

  /** Upload a file to a channel, through the SAME resolution and the SAME
   *  mention conversion a plain post gets.
   *
   *  It went around both. `attachmentUpload` read `cfg.channels[target]` itself,
   *  so a channel this agent is in but the config does not map failed with a
   *  short "no Slack channel" while a plain send to that channel worked; and the
   *  text rode to Slack as `initial_comment` without denormalize, so a message
   *  opening with someone's name stored the name LITERALLY and notified nobody.
   *  A peer agent measured both on a live channel (2026-08-22) and named the
   *  shape: "the upload path skips what plain send does."
   *
   *  So the upload lives here now, beside post(), because what they share is not
   *  a helper both call. It is the same question, asked once: which channel, and
   *  whose names are in this text. */
  async upload(
    channel: string,
    filePath: string,
    as: string,
    mimeOverride?: string,
    initialComment?: string,
    thread?: string,
  ): Promise<{ ok: true; id: string; permalink?: string } | { ok: false; error: string }> {
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as), channel);
    if (resolved.id === undefined) return { ok: false, error: resolved.error };
    const t = this.agentToken(as);
    if (!t.ok) return { ok: false, error: t.error };
    if (initialComment !== undefined) await this.learnNames(t.token, initialComment);
    const r = await uploadToSlack(
      this.fetch,
      t.token,
      filePath,
      resolved.id,
      mimeOverride,
      initialComment === undefined ? undefined : denormalize(initialComment, this.roster),
      thread,
    );
    return r.ok ? { ok: true, id: r.out.id, ...(r.out.permalink !== undefined ? { permalink: r.out.permalink } : {}) } : { ok: false, error: r.error };
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
    // A BROADCAST ADDRESSES EVERY AGENT IN THE CHANNEL, and arrived as raw text
    // that matched nothing. The operator wrote `<!channel> ensure everything you
    // write to files are English`, and it reached no agent's inbox: it came in
    // with `mentions: []` and `mentioned: false`, so every agent saw it only on
    // the 15-minute sweep, if at all. Three agents measured that independently
    // against their own inbox and wake logs (2026-08-22).
    //
    // AND THE COMPLIANCE LOOKED LIKE SUCCESS. All three acted on that broadcast
    // within minutes, which from outside is indistinguishable from delivery
    // working. One of them put the distinction exactly: "three agents complying
    // is not evidence the broadcast reached anyone. It is evidence that three
    // agents drain often enough to catch a message nobody was told about." Had
    // any of them been mid-job, it would have sat unseen until the next sweep.
    //
    // Rendered as `@channel`, `@here`, `@everyone`, which computeMentions then
    // picks up like any other name, so one normalization makes the existing
    // machinery do the rest.
    let out = text.replace(/<!(channel|here|everyone)>/g, (_w, kind: string) => `@${kind}`);
    for (const m of out.matchAll(/<@([A-Z0-9]+)>/g)) {
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
  private async downloadFiles(
    token: string,
    files: SlackFileMeta[] | undefined,
    wanted: boolean,
  ): Promise<{ files: Attachment[]; problems: string[] }> {
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
      // BYTES ONLY FOR WHAT IS ADDRESSED TO THIS AGENT. The metadata always
      // arrives, so the id is enough to fetch later, and `attachment view`
      // fetches from Slack when the file is not on disk.
      //
      // It used to pull every file that passed through a channel, for every
      // agent in it, inside the delivery path. Three agents in one room each
      // downloaded the same 41MB archive addressed to one of them, on a
      // filesystem at 99%, and each download delayed a delivery that was not
      // theirs (2026-08-22).
      if (f.url_private && wanted) {
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
    // Ask Slack who is in the thread ONLY on the delivery path. `history` runs
    // this same converter over every row and then discards `mentioned` (a
    // transcript has no per-recipient state), so doing it there would spend one
    // conversations.replies per threaded row to compute a value nobody reads.
    wantThreadWake = false,
  ): Promise<{ delivery: Delivery | undefined; problems: string[] }> {
    // AN INVITE IS NEWS. Being added to a channel reaches a human's attention, and
    // an agent that learns it only by overhearing later traffic has already
    // missed whatever it was added for (operator, 2026-08-22). Delivered as a
    // line addressed to this agent, so the inbox wakes on it.
    if (ev.type === "member_joined_channel") {
      if (as === "" || ev.user === undefined || ev.user !== this.userIdFor(as)) {
        return { delivery: undefined, problems: [] };
      }
      const ch = ev.channel;
      if (ch === undefined) return { delivery: undefined, problems: [] };
      const name = this.channelById[ch] ?? (await this.channelNameFor(token, ch));
      const by = ev.inviter === undefined ? "" : ` by ${await this.resolveName(token, ev.inviter)}`;
      const ts = ev.ts ?? new Date().toISOString();
      return {
        delivery: {
          seq: 0,
          ts,
          channel: name,
          from: "slack",
          text: `You were added to ${name}${by}. Read what the channel is doing before you speak in it.`,
          id: ts,
          mentions: [],
          mentioned: true,
        },
        problems: [],
      };
    }
    // `app_mention` CARRIES A MENTION AND WAS BEING DROPPED. Anything whose type
    // was not `message` returned no delivery, so an app subscribed to
    // app_mention had mentions arriving on its socket and scramble discarded
    // every one: the mention is live on the wire while the inbox sits silent.
    // A fourth agent found it on an app it had adopted, which subscribes to
    // app_mention and to none of the message events (2026-08-22).
    //
    // Both types carry the same fields, so both make the same delivery. An app
    // subscribed to BOTH sends a channel mention twice, once each, which is what
    // the ts dedup in listen and next is for.
    if ((ev.type !== "message" && ev.type !== "app_mention") || !ev.text || ev.text === "") {
      return { delivery: undefined, problems: [] };
    }
    // A status is never a message, and that holds for a PEER's status too.
    if (isStatusLine(ev)) return { delivery: undefined, problems: [] };
    const channel = ev.channel;
    if (channel === undefined) return { delivery: undefined, problems: [] };
    // Normalize <@U…> mentions to @name, resolving unseen ids via users.info
    // under the acting agent's credential.
    const text = await this.normalize(token, ev.text);
    const from = await this.resolveSender(token, ev);
    const dmAgent = this.dmChannels[channel];
    // The mapped case costs no await: a lookup that returns at once still spends a
    // turn of the event loop when it is awaited, and every message pays it.
    const mapped = this.channelById[channel];
    const channelName =
      dmAgent !== undefined
        ? `${DM_PREFIX}${dmAgent}/${from}`
        : mapped ?? (await this.channelNameFor(token, channel));
    // Slack ts is the per-channel cursor (no global seq), used as both ts and the
    // dedup id for a line.
    const ts = ev.ts ?? new Date().toISOString();
    const mentions = computeMentions(channelName, text, from);
    const thread = ev.thread_ts !== undefined && ev.thread_ts !== ts ? ev.thread_ts : undefined;
    // Only on the DELIVERY path: history strips per-recipient state and a
    // transcript does not need a lookup per row.
    // The GUARD is on the call, not inside it: an `await` on the delivery path
    // costs a turn of the event loop even when the function returns at once, and
    // this lookup is impossible without the CLI credential anyway.
    // The sender's own account of where it runs. Malformed metadata reads as no
    // origin and never blocks the delivery: the message is the point.
    const origin = readOrigin(ev.metadata);
    const description =
      wantThreadWake && this.cliToken !== undefined && this.cliToken !== ""
        ? await this.describeSender(token, ev)
        : undefined;
    // Computed BEFORE the files, because it decides whether the bytes are
    // fetched at all.
    const mentioned =
      this.addressesAgent(mentions, as) ||
      (wantThreadWake && thread !== undefined && (await this.inThread(token, channel, thread, as)));
    const dl = await this.downloadFiles(token, ev.files, mentioned);
    const delivery: Delivery = {
      seq: 0,
      ts,
      channel: channelName,
      from,
      text,
      id: ts,
      mentions,
      mentioned,
      ...(thread !== undefined ? { thread } : {}),
      ...(this.senderKind(ev) !== undefined ? { sender: this.senderKind(ev) } : {}),
      ...(wantThreadWake && description !== undefined ? { description } : {}),
      ...(origin === undefined ? {} : { origin }),
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
    onLine: (d: Delivery) => void,
    onProblem: (p: string) => void,
  ): void {
    void this.toDelivery(ev, as, token, true).then(({ delivery, problems }) => {
      for (const p of problems) onProblem(p);
      if (delivery === undefined) return;
      // An agent never delivers its own posts (it would otherwise answer itself).
      // EVERY name this agent answers to, not just its scramble name. `from` is
      // the RESOLVED sender, which for an app is its Slack handle
      // (`scramble_dev`), so comparing it against the scramble name
      // (`scramble-dev`) never matches and the agent is delivered its own posts.
      // Caught by the loop itself: my own message came back to me as a wake.
      if (this.identities(as).includes(delivery.from)) return;
      // ONE LINE PER MESSAGE, whatever Slack calls the event. An app subscribed
      // to both message.channels and app_mention receives a channel mention
      // TWICE, once under each type, and both carry the same ts. Delivering both
      // would wake the agent twice for one question and record two inbox items
      // that need two answers.
      if (this.deliveredTs.has(delivery.ts)) return;
      this.deliveredTs.add(delivery.ts);
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
    token: string,
    as = "",
    forDelivery = false,
  ): Promise<number> {
    if (isStatusLine(m)) return seq;
    const { delivery, problems: dlProblems } = await this.toDelivery(
      // METADATA IS CARRIED THROUGH. This projection names every field the
      // converter may read, so a field left out of it is invisible on the drain
      // path while working on the socket. The sender's origin arrived that way:
      // stamped, delivered live, and dropped by `message check` because this
      // list did not mention it.
      { type: "message", channel: slackChannel, user: m.user, username: m.user, ts: m.ts, thread_ts: m.thread_ts, text: m.text, bot_id: m.bot_id, files: m.files, metadata: m.metadata },
      as,
      token,
      forDelivery,
    );
    problems.push(...dlProblems);
    if (delivery === undefined) return seq;
    // history is channel-scoped: force the requested `channel` (a Slack id tells us
    // the Slack channel, the channel mapping is the caller's frame). Slack has no
    // global seq, so a synthetic per-history counter stands in where the
    // local line's `seq` lives; the message's ts is the real cursor.
    // A DRAIN keeps `mentioned` and the sender's description; a transcript drops
    // them, because per-recipient state has no meaning in a shared transcript.
    if (forDelivery) {
      messages.push({ ...delivery, channel, seq: seq + 1 } as Message);
      return seq + 1;
    }
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
    as?: string,
    // `message check` DRAINS through this method, so it is a delivery even
    // though it reads history: it needs `mentioned` computed against thread
    // participation and the sender's description resolved. `message read` is a
    // transcript and needs neither, and paying for them per row there is waste.
    forDelivery = false,
  ): Promise<{ code: 0 | 1; error?: string; messages: Message[]; problems: string[] }> {
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as ?? ""), channel);
    if (resolved.id === undefined) return { code: 1, error: resolved.error, messages: [], problems: [] };
    const slackChannel = resolved.id;
    const t = this.agentToken(as ?? "");
    if (!t.ok) return { code: 1, error: t.error, messages: [], problems: [] };
    const token = t.token;
    const qs = since !== undefined ? `&oldest=${encodeURIComponent(since)}` : "";
    const r = await readOk<{ messages?: SlackHistoryMessage[] }>(
      this.fetch,
      `${HISTORY_URL}?channel=${encodeURIComponent(slackChannel)}&${WITH_METADATA}${qs}`,
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
      seq = await this.appendLine(m, slackChannel, channel, messages, problems, seq, token, as ?? "", forDelivery);
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
        seq = await this.appendLine(reply, slackChannel, channel, messages, problems, seq, token, as ?? "", forDelivery);
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
              this.deliver(ev, channels, as, token, wantsAll, (d) => settle({ code: 0, line: d }), onProblem);
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
      const opened = await this.listenOnce(channels, wantsAll, as, token, onLine, onProblem);
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
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let established = false;
      void this.connectSocket(as).then(
        (c) => {
          established = true;
          c.socket.onmessage = (raw) =>
            this.routeFrame(raw, c.socket, (ev) => this.deliver(ev, channels, as, token, wantsAll, onLine, onProblem));
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