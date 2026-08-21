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
import type { Delivery, Message } from "./types";
import { DM_PREFIX } from "./types";
import type { SlackSocket } from "./slack-transport";

// --- slack endpoint URLs ------------------------------------------------

const SOCKET_OPEN_URL = "https://slack.com/api/apps.connections.open";
const POST_URL = "https://slack.com/api/chat.postMessage";
const HISTORY_URL = "https://slack.com/api/conversations.history";
const USERS_INFO_URL = "https://slack.com/api/users.info";

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
}

/** A Socket Mode envelope. Slack redelivers any envelope you do not ACK, so we
 *  reply with the envelope_id for every frame that has one. */
interface Frame {
  type?: string;
  envelope_id?: string;
  payload?: { event?: SlackInboundEvent };
}

/** The config the backend reads, a SUBSET of the bridge config (src/slack.ts):
 *  tokens, the channel->Slack channel map, per-agent identities, the mention roster and
 *  the self-filter bot ids. `postToChannel` is deliberately absent — the backend
 *  POSTS STRAIGHT TO SLACK, not into a stitched local channel. */
export interface SlackBackendConfig {
  /** main bot token (xoxb-) used as the fallback for every post. */
  token: string;
  /** app-level token (xapp-) for apps.connections.open (Socket Mode). */
  appToken?: string;
  /** channel name -> Slack channel id. */
  channels: Record<string, string>;
  /** agent name -> { token?: per-agent bot token }. */
  agents: Record<string, { token?: string }>;
  /** slack user id -> name, for <@U…> -> @name normalization. */
  roster: Record<string, string>;
  /** DM channel id -> agent whose bot that DM belongs to. */
  dmChannels: Record<string, string>;
  /** own bot ids the backend never delivers (the self-filter). */
  botIds: string[];
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
  user?: string;
  username?: string;
  text?: string;
  bot_id?: string;
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
  private readonly botIds: string[];
  private readonly dmChannels: Record<string, string>;
  private readonly channelById: Record<string, string>;
  private readonly channels: Record<string, string>;
  private readonly agents: Record<string, { token?: string }>;
  private readonly roster: Record<string, string>;
  /** Cache of users.info answers so a repeat unknown id never re-queries. */
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
    this.botIds = cfg.botIds;
    this.dmChannels = cfg.dmChannels;
    this.channelById = Object.fromEntries(Object.entries(cfg.channels).map(([r, c]) => [c, r]));
    this.channels = cfg.channels;
  }

  /** POST one post to the Slack channel a channel maps to, with the agent's own bot
   *  token when it has one, else the config token. A Slack failure (`ok:false`
   *  with error text) is surfaced as a FAILURE carrying that text, never read
   *  as a success. */
  async post(channel: string, text: string, as: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const slackChannel = this.channels[channel];
    if (!slackChannel) return { ok: false, error: `no Slack channel for channel ${channel}` };
    const token = this.agents[as]?.token ?? this.token;
    const r = await readOk<{ error?: string }>(this.fetch, POST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: slackChannel, text }),
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true };
  }

  /** Resolve a Slack user id to a name: the roster wins, then users.info (the
   *  app holds users:read). An id ABSENT from the roster resolves through
   *  users.info rather than passing through raw — a raw id matches no agent
   *  name, so a <@U…> mention would land silently unmentioned. Cached. */
  private async resolveName(user: string): Promise<string> {
    const cached = this.nameCache.get(user);
    if (cached !== undefined) return cached;
    const roster = this.roster[user];
    if (roster !== undefined) {
      this.nameCache.set(user, roster);
      return roster;
    }
    let name = user;
    const info = await readOk<{ user?: { name?: string } }>(
      this.fetch,
      `${USERS_INFO_URL}?user=${encodeURIComponent(user)}`,
      { headers: { authorization: `Bearer ${this.token}` } },
    );
    if (info.ok && typeof info.data.user?.name === "string") name = info.data.user.name;
    this.nameCache.set(user, name);
    return name;
  }

  /** Normalize `<@U…>` to `@name`: an id in the roster resolves immediately; an
   *  id ABSENT from the roster resolves through (cached) users.info instead of
   *  passing through raw, so a mention never lands silently unmentioned. */
  private async normalize(text: string): Promise<string> {
    let out = text;
    for (const m of text.matchAll(/<@([A-Z0-9]+)>/g)) {
      const uid = m[1]!;
      const name = await this.resolveName(uid);
      out = out.replace(`<@${uid}>`, `@${name}`);
    }
    return out;
  }

  /** Turn one inbound event into an outbound Delivery, or undefined when it
   *  should be dropped (a self-post, an uninteresting event, an unknown
   *  channel). */
  private async toDelivery(ev: SlackInboundEvent, as: string): Promise<Delivery | undefined> {
    if (ev.type !== "message" || !ev.text || ev.text === "") return undefined;
    // Self-filter: never deliver our OWN posts (a bot_id in the config list),
    // which is what keeps an agent from answering itself.
    if (ev.bot_id !== undefined && this.botIds.includes(ev.bot_id)) return undefined;
    const channel = ev.channel;
    if (channel === undefined) return undefined;
    // Normalize <@U…> mentions to @name, resolving unseen ids via users.info.
    const text = await this.normalize(ev.text);
    const from = await this.resolveSender(ev);
    const dmAgent = this.dmChannels[channel];
    const channelName = dmAgent === undefined ? this.channelById[channel] : `${DM_PREFIX}${dmAgent}/${from}`;
    if (channelName === undefined) return undefined;
    // Slack ts is the per-channel cursor (no global seq), used as both ts and the
    // dedup id for a line, exactly as the comment on the CLI documents.
    const ts = ev.ts ?? new Date().toISOString();
    const mentions = computeMentions(channelName, text, from);
    return { seq: 0, ts, channel: channelName, from, text, id: ts, mentions, mentioned: mentions.includes(as) };
  }

  /** Resolve the sender's name: a user token shaped like a Slack id is looked
   *  up (roster then users.info); a plain username passes through. */
  private resolveSender(ev: SlackInboundEvent): Promise<string> {
    const u = ev.user;
    if (u !== undefined && u !== "" && /^[UW][A-Z0-9]+$/.test(u)) return this.resolveName(u);
    return Promise.resolve(ev.username ?? "");
  }

  /** Open one Socket Mode connection: apps.connections.open with the app token,
   *  then the injected socket factory. */
  private async connectSocket(): Promise<{ socket: SlackSocket; close: () => void }> {
    const r = await readOk<{ url?: string }>(this.fetch, SOCKET_OPEN_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.appToken}` },
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

  /** Route an inbound event through the channel filter and deliver (or problem-report). */
  private deliver(
    ev: SlackInboundEvent,
    channels: string[],
    as: string,
    wantsAll: boolean,
    onLine: (d: Delivery) => void,
  ): void {
    void this.toDelivery(ev, as).then((d) => {
      if (d !== undefined && (wantsAll || channels.includes(d.channel))) onLine(d);
    });
  }

  /** history(channel, since): conversations.history mapped into the local line
   *  shape (a channel-scoped Message with mentions). `since` maps to Slack's
   *  `oldest` cursor, so a resume picks up where the last ts stopped. */
  async history(
    channel: string,
    since?: string,
  ): Promise<{ code: 0 | 1; error?: string; messages: Message[] }> {
    const slackChannel = this.channels[channel];
    if (!slackChannel) return { code: 1, error: `no Slack channel for channel ${channel}`, messages: [] };
    const qs = since !== undefined ? `&oldest=${encodeURIComponent(since)}` : "";
    const r = await readOk<{ messages?: SlackHistoryMessage[] }>(
      this.fetch,
      `${HISTORY_URL}?channel=${encodeURIComponent(slackChannel)}${qs}`,
      { headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!r.ok) return { code: 1, error: r.error, messages: [] };
    const messages: Message[] = [];
    let seq = 0;
    for (const m of r.data.messages ?? []) {
      const d = await this.toDelivery(
        { type: "message", channel: slackChannel, user: m.user, username: m.user, ts: m.ts, text: m.text, bot_id: m.bot_id },
        "",
      );
      if (d === undefined) continue;
      // history is channel-scoped: force the requested `channel` (a Slack id tells us
      // the Slack channel, the channel mapping is the caller's frame). Slack has no
      // global seq, so a synthetic per-history counter stands in where the
      // local line's `seq` lives; the message's ts is the real cursor.
      const { mentioned, ...rest } = d;
      void mentioned;
      messages.push({ ...rest, channel, seq: ++seq });
    }
    return { code: 0, messages };
  }

  /** next(channels, as, timeoutSecs, onProblem): block for ONE message then
   *  resolve 0; exit-64 semantics preserved by timing out with nothing
   *  delivered-and-nothing-printed. */
  async next(
    channels: string[],
    as: string,
    timeoutSecs: number,
    onProblem: (p: string) => void,
  ): Promise<{ code: 0; line: Delivery } | { code: 64 }> {
    const deadline = this.now() + timeoutSecs * 1000;
    const wantsAll = channels.length === 0;
    // Connect asynchronously; the caller-facing promise settles on the first
    // matching delivery OR the deadline, whichever comes first.
    return new Promise((resolve) => {
      let conn: { socket: SlackSocket; close: () => void } | undefined;
      let settled = false;
      const settle = (v: { code: 0; line: Delivery } | { code: 64 }): void => {
        if (settled) return;
        settled = true;
        conn?.close();
        resolve(v);
      };
      void this.connectSocket().then(
        (c) => {
          if (settled) return;
          conn = c;
          c.socket.onmessage = (raw) =>
            this.routeFrame(raw, c.socket, (ev) => {
              this.deliver(ev, channels, as, wantsAll, (d) => settle({ code: 0, line: d }));
            });
          if (this.now() >= deadline) settle({ code: 64 });
        },
        (e) => {
          // A Socket Mode connect failure means nothing can arrive: report it
          // and settle with the nothing-to-report exit, so a next() against a
          // bad token does not hang.
          onProblem(e instanceof Error ? e.message : String(e));
          settle({ code: 64 });
        },
      );
      void this.sleep(timeoutSecs * 1000).then(() => {
        if (this.now() >= deadline) settle({ code: 64 });
      });
    });
  }

  /** listen(channels, as, onLine, onProblem): the Socket Mode event stream, ONE
   *  JSON line per message as the local backend emits. Resolves when the
   *  underlying socket disconnects cleanly. */
  async listen(
    channels: string[],
    as: string,
    onLine: (d: Delivery) => void,
    onProblem: (p: string) => void,
  ): Promise<void> {
    const wantsAll = channels.length === 0;
    await new Promise<void>((resolve) => {
      void this.connectSocket().then(
        (c) => {
          c.socket.onmessage = (raw) =>
            this.routeFrame(raw, c.socket, (ev) => this.deliver(ev, channels, as, wantsAll, onLine));
          c.socket.onclose = () => resolve();
        },
        (e) => {
          onProblem(e instanceof Error ? e.message : String(e));
          // A failed connect means no stream: report and let listen end, so a
          // watch with a bad token does not hang forever.
          resolve();
        },
      );
    });
    return;
  }
}