// `src/slack-backend.ts` provides a third backend behind the same verbs as
// `src/raft.ts`. scramble communicates with Slack over REST and Socket Mode
// transports through injected seams (a `fetch` function and a socket factory), so
// tests need no Slack token, no network, and no socket. The production `fetch` and
// WebSocket live in `src/bin.ts` (which no test imports), so the coverage gate
// stays green.
//
// Slack serves as the source of truth. Every verb talks directly to Slack and
// never mirrors a local store. Slack provides no global sequence number, so the
// message `ts` functions as the per-channel cursor, which is the mapping available
// where Slack keeps no shared total order. The emitted line shape matches the
// local backend exactly (channel, from, text, ts, mentions, plus a `mentioned`
// flag for this agent) because the join skill and the hooks read it verbatim.
import type { Delivery, Message, Attachment } from "./types";
import { DM_PREFIX } from "./types";
import type { SlackSocket } from "./slack-transport";
import { STATUS_METADATA_TYPE } from "./status";
import { proseOf } from "./language";
import { originMetadata, readOrigin, type Origin } from "./origin";
import { downloadFile, uploadToSlack, type SlackFileMeta } from "./attachments";

// --- slack endpoint URLs ------------------------------------------------

const SOCKET_OPEN_URL = "https://slack.com/api/apps.connections.open";
const POST_URL = "https://slack.com/api/chat.postMessage";
const HISTORY_URL = "https://slack.com/api/conversations.history";
/**
 *  Slack omits message metadata from a read unless the request asks for it.
 *  Because the status marker resides in that metadata, this backend requests
 *  metadata on every read.
 */
const WITH_METADATA = "include_all_metadata=true";
const REPLIES_URL = "https://slack.com/api/conversations.replies";
const USERS_INFO_URL = "https://slack.com/api/users.info";
/**
 *  Slack broadcasts address everyone who can read the channel. The system exports
 *  these messages because the inbox ledger needs the same list. A broadcast names
 *  no single agent, and it is still addressed to each of them.
 */
export const BROADCAST_NAMES = ["channel", "here", "everyone"];

const AUTH_TEST_URL = "https://slack.com/api/auth.test";
const AUTH_TEAMS_LIST_URL = "https://slack.com/api/auth.teams.list";
const USERS_LIST_URL = "https://slack.com/api/users.list";
const REACT_URL = "https://slack.com/api/reactions.add";
const UPDATE_URL = "https://slack.com/api/chat.update";
const DELETE_URL = "https://slack.com/api/chat.delete";
const CONV_INFO_URL = "https://slack.com/api/conversations.info";
const USERS_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";

/**
 *  A history call caps the number of threaded root messages it expands. Each
 *  expanded root requires one extra `conversations.replies` request, which bounds
 *  the fan-out. A busy channel cannot permit unbounded expansion. When the cap
 *  drops a root, the read reports that root in its problems list.
 *
 *  The system selects roots by newest reply. When the system selected 5 roots
 *  by root age, an agent replying in a thread started hours earlier read the
 *  channel back, saw nothing newer than 04:34:09, decided the send had failed,
 *  and posted the same progress report 5 times (one agent, ts 1787715280 through
 *  1787715629). The agent needs the thread it writes in expanded, and the root of
 *  that thread is old by definition.
 */
/** How many thread reads are in flight at once, how many times a rate-limited one
 *  is asked again, and how long it waits between attempts.
 *
 *  Awaiting each read inside the row walk made them serial, and one read of a busy
 *  channel passed 120 seconds. Sending all of them at once produced `ratelimited`
 *  across four roots in one sweep, and a dropped expansion loses a thread reply
 *  somebody is waiting on. A few in flight with a retry keeps both failures away.
 */
export const REPLY_CONCURRENCY = 4;
export const REPLY_RETRIES = 3;
export const REPLY_RETRY_PAUSE_MS = 1200;

export const THREAD_EXPANSION_CAP = 25;

/**
 *  The first reconnection attempt for a dropped Socket Mode stream waits
 *  RECONNECT_BACKOFF ms. A connection that once worked continues retrying forever,
 *  bounded by MAX_RECONNECT_BACKOFF. A connection that never opened once fails and
 *  stops there.
 */
const RECONNECT_BACKOFF = 1000;
const MAX_RECONNECT_BACKOFF = 4000;

/**
 *  This value is true for a top-level row that carries a thread. Slack marks the
 *  row with a reply_count above zero and a thread_ts equal to its own ts. Only such
 *  a row expands through conversations.replies. A row without replies never
 *  triggers a request. A reply message has a thread_ts != ts, so it is not a root.
 */
export function isThreadRoot(m: SlackHistoryMessage): boolean {
  const rc = m.reply_count ?? 0;
  return rc > 0 && m.thread_ts !== undefined && m.thread_ts === m.ts;
}

/**
 *  The service receives a Slack message event over Socket Mode and deliberately
 *  reads only the fields mapped to the line format.
 */
export interface SlackInboundEvent {
  type?: string;
  /**
   *  The `member_joined_channel` event contains the id of the member who joined
   *  and, when someone added them, the id of the inviter.
   */
  inviter?: string;
  /**
   *  In Slack message metadata, a scramble status carries STATUS_METADATA_TYPE, and
   *  an ordinary message carries its sender's ORIGIN_METADATA_TYPE.
   */
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

/**
 *  Slack redelivers any Socket Mode envelope you do not ACK, so we reply with the
 *  envelope_id for every frame that has one.
 */
interface Frame {
  type?: string;
  envelope_id?: string;
  payload?: { event?: SlackInboundEvent };
}

/**
 *  The backend reads a subset of the bridge configuration in src/slack.ts:
 *  tokens, the channel-to-Slack channel map, per-agent identities, and the
 *  mention roster. The configuration deliberately omits `postToChannel` because
 *  the backend posts directly to Slack without an intermediate local channel.
 *  The configuration contains no self-filter list. The delivery path suppresses
 *  an agent's own posts by name only when a resolved sender name equals the
 *  consuming agent, which is the same mechanism the local backend uses.
 */
export interface SlackBackendConfig {
  /**
   *  Every post uses the main bot token (xoxb-) as the fallback.
   */
  token: string;
  /**
   *  Socket Mode requires an app-level token (`xapp-`) for `apps.connections.open`.
   */
  appToken?: string;
  /**
   *  The channel name maps to the Slack channel ID.
   */
  channels: Record<string, string>;
  /**
   *  Each agent name maps to an object containing an optional per-agent bot `token`
   *  and an optional per-agent app-level `appToken`.
   */
  agents: Record<string, { token?: string; appToken?: string; handle?: string; appId?: string }>;
  /**
   *  The Slack user ID identifies the human who authorized this machine's session.
   */
  humanUserId?: string;
  /**
   *  This process stamps its location onto every message it posts, so peers can
   *  learn where it runs without anyone typing the location into prose.
   */
  origin?: Origin;
  // This backend holds no CLI credentials. Operators authenticate the Slack CLI
  // only when a new agent joins the app or during a scramble doctor fix, and
  // regular operations run through the bot token. This backend serves regular
  // operations, so the app-config token it used to carry for peer descriptions
  // is gone, along with the description.
  /**
   *  This mapping assigns a channel to `internal` or `external`, overriding the
   *  status derived from its membership list.
   *
   *  A room full of agents can still be where a customer reads, and nothing derives
   *  that status automatically. This configuration names those rooms, while the system
   *  classifies every other channel by counting who is in it.
   */
  tiers?: Record<string, string>;
  /**
   *  The mapping converts Slack user IDs to names to normalize `<@U…>` to `@name`.
   */
  roster: Record<string, string>;
  /**
   *  Each direct message channel ID maps to the agent whose bot owns that direct
   *  message channel.
   */
  dmChannels: Record<string, string>;
  /**
   *  Downloadable Slack attachments are written to this directory. The default path
   *  is `~/.config/scramble/files`, resolved by the caller, which sees HOME.
   */
  filesDir: string;
}

/**
 *  The system builds every outbound Slack call and every socket exclusively
 *  through injected seams, so a test passes fakes and touches no network.
 */
export interface SlackBackendDeps {
  /**
   *  A network seam is injected for the REST calls.
   */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /**
   *  The implementation uses an injected socket factory. The real socket factory
   *  wires Bun's `WebSocket` in `src/bin.ts`.
   */
  createSocket(url: string): SlackSocket;
  /**
   *  The wait function is injectable so a `next()` deadline requires no real delay
   *  under test.
   */
  sleep(ms: number): Promise<void>;
  /**
   *  The caller can inject a clock to set the deadline for `next()`. The clock
   *  defaults to `Date.now()`.
   */
  now?: () => number;
}

/**
 *  An atomic REST response with `ok:false` and error text is a failure that
 *  carries Slack's error.
 */
type OkResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 *  The system parses a Slack REST payload and uses the `ok` field to determine
 *  whether the request succeeded. When a response fails to parse or a fetch throws,
 *  the system surfaces the result as a `FAILURE` and never reads it as a success,
 *  because a caller that cannot tell what Slack returned must not act as if it
 *  had.
 */
/**
 *  This setting specifies how many 200-reply pages a read-back walks before it
 *  gives up. A thread this long is beyond anything measured here, and the refusal
 *  names the bound.
 */
const REPLY_PAGE_CAP = 10;

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
  if (rec.ok !== true) {
    const error = (rec.error as string) ?? "slack call failed";
    // Slack identifies the required scope, but previous versions dropped this
    // information. Adding the next scope fails in the same way, appearing as an
    // unrelated one-word error from the call that requires it. Slack returns
    // `needed` and `provided` on missing_scope, which turns that one word into the
    // answer.
    if (error === "missing_scope") {
      const needed = typeof rec.needed === "string" ? rec.needed : "";
      const provided = typeof rec.provided === "string" ? rec.provided : "";
      const detail = [needed === "" ? "" : `needs ${needed}`, provided === "" ? "" : `has ${provided}`]
        .filter((x) => x !== "")
        .join(", ");
      return {
        ok: false,
        error:
          detail === ""
            ? `missing_scope on ${input}, and slack named no scope`
            : `missing_scope on ${input}: ${detail}. A scope needs a reinstall: bun scripts/onboard-agent.ts <agent>`,
      };
    }
    return { ok: false, error };
  }
  return { ok: true, data: rec as unknown as T };
}

/**
 *  Each line is a message read from `conversations.history`.
 */
export interface SlackHistoryMessage {
  ts?: string;
  /**
   *  In Slack message metadata, a scramble status carries STATUS_METADATA_TYPE, and
   *  an ordinary message carries its sender's ORIGIN_METADATA_TYPE.
   */
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
  thread_ts?: string;
  /**
   *  The field records Slack's count of replies under this message when the message
   *  is a threaded root. A reply_count above zero with thread_ts equal to its own ts
   *  marks the row as a root whose replies live under conversations.replies.
   */
  reply_count?: number;
  /**
   *  A read selects the threads worth expanding by activity, using the timestamp
   *  of the newest reply under this root.
   */
  latest_reply?: string;
  user?: string;
  username?: string;
  text?: string;
  bot_id?: string;
  files?: SlackFileMeta[];
}

/**
 *  To determine whether a line is a scramble status or spoken text, the status
 *  manager keys on the metadata it stamps, so any agent recognizes any agent's
 *  status. The system ignores message text, because a human is allowed to say
 *  "working". The ts ledger cannot answer this, because it only ever knew this
 *  agent's own status.
 */
export function isStatusLine(m: { metadata?: { event_type?: string } }): boolean {
  return m.metadata?.event_type === STATUS_METADATA_TYPE;
}

/**
 *  The outbound transform converts `@name` into Slack's `<@U…>` entity, mirroring
 *  what `normalize` does on the incoming path. Without this conversion, a mention an
 *  agent writes remains literal text: Slack renders it in grey and sends no
 *  notification to a human, while agents still wake because the receive path parses
 *  `@name` itself, so the defect is invisible from an agent's side (peer agent,
 *  confirmed in Slack's raw record).
 *
 *  Because `roster` maps user identifiers to names, the code inverts the mapping
 *  here. A name nobody in the roster answers to stays literal text, since an invalid
 *  entity renders worse than plain text, and the parser leaves a fenced block
 *  alone, because an `@name` in a code sample is a code sample. The function is
 *  pure, so unit tests cover the fence and unknown-name rules.
 */
export function denormalize(text: string, roster: Record<string, string>): string {
  const idOf = new Map<string, string>();
  for (const [id, name] of Object.entries(roster)) idOf.set(name, id);
  // Code fences do not prevent Slack from sending notifications. Slack parses
  // `<!channel>` and `<@U…>` wherever they appear, including inside code fences and
  // backtick spans, so a message documenting the token pings the room. A message
  // describing this pair woke every agent during an explanation of the fix.
  // Escaping the opening bracket leaves the visible text identical and notifies
  // nobody, which is what an author quoting the token means.
  const defuse = (part: string): string =>
    part.replace(/<(![a-z]+|@[A-Z0-9]+)>/g, (_w, inner: string) => `&lt;${inner}>`);
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    // Inline backtick spans are treated as code. The parser skipped fenced lines but
    // converted inline spans. Therefore, an `@name` handle in an inline span notified
    // that person while `computeMentions` read prose and recorded nothing. They
    // received a ping with no item in their ledger, which is the split this file
    // closes. The scramble skill tells agents to write examples in a span for
    // exactly this reason, and inline spans now follow that rule.
    const convert = (part: string): string =>
      // Any character that is not part of a name may precede the @, and the
          // The parsing rule previously required whitespace or the start of a line. A
          // mention following a full stop, a comma, a bracket, or a CJK punctuation
          // mark was
          // sent as plain text and notified nobody. Two agents encountered this
          // behavior,
          // and both worked around it by placing a space before the @. One agent
          // demonstrated
          // the clean case: a message that converted its mention at the line start and
          // left
          // the mention that followed a full stop, in a script whose full stop is its
          // own
          // character (reported).
          //
          // The rule excludes `<` alongside name characters, so the system leaves an
          // already-converted `<@U123>` alone, and an address like name@example.com
          // stays
          // untouched because the character before its @ is part of a name.
          part.replace(/(^|[^A-Za-z0-9._<-])@([A-Za-z0-9._-]+)/g, (whole, lead: string, name: string) => {
            // A broadcast is also an entity. The skill teaches the `@channel` syntax
            // for
            // drafts, and every agent writes this form. The system sent `@channel` to
            // Slack
            // as plain text, so the message displayed a grey `@channel` and notified
            // nobody. This file already fixed this failure for reading, but had never
            // fixed
            // it for writing.
            if ((BROADCAST_KINDS as readonly string[]).includes(name)) return `${lead}<!${name}>`;
            const exact = idOf.get(name);
            if (exact !== undefined) return `${lead}<@${exact}>`;
            // A trailing dot ends the sentence, but the matcher consumed it as part of
            // the
            // mention. A Slack handle may contain a dot, so the match includes dots,
            // and
            // `@name.` at the end of a sentence looked up a handle nobody has. As a
            // result,
            // the mention went out as plain text and notified nobody. A comma or an
            // exclamation mark never did this, since neither is a handle character. The
            // agent
            // named in the mention measured this behavior from raw Slack payloads.
            const trimmed = name.replace(/\.+$/, "");
            const id = trimmed === name ? undefined : idOf.get(trimmed);
            return id === undefined ? whole : `${lead}<@${id}>${name.slice(trimmed.length)}`;
          });
    out.push(
      fenced || line.trimStart().startsWith("```")
        ? defuse(line)
        : // Odd segments are the spans between backticks, and they stay as they
          // A `split` on a global pattern keeps delimiters at odd indices, so a lone
          // backtick leaves its text in an even segment and converts the way plain
          // prose
          // does.
          line
            .split(/(`[^`\n]*`)/g)
            .map((part, i) => (i % 2 === 1 ? defuse(part) : convert(part)))
            .join(""),
    );
  }
  return out.join("\n");
}

/**
 *  This function determines the members that a message addresses. A dm/ channel
 *  addresses its peers, which includes every member except the sender, and a group
 *  channel addresses the @-tokens in the text. The implementation is pure, so it is
 *  trivially unit-tested.
 */
/**
 *  The read path undoes Slack's three character escapes.
 *
 *  Slack stores `<`, `>`, and `&` as `&lt;`, `&gt;`, and `&amp;`, so a message
 *  carrying `--target <channel>` reads back with the brackets escaped, and
 *  `--verify` called it DIFFERS while the message was intact. The comparison
 *  evaluates what the author wrote, so the read operation undoes what the wire
 *  did.
 *
 *  The system decodes `&amp;` last, because decoding it first would turn
 *  `&amp;lt;` into `&lt;` and then into `<`, creating a bracket that the author
 *  never typed.
 */
/**
 *  Slack's auto-links collapse back to the words the author typed.
 *
 *  Slack linkifies bare dotted words inside backtick spans as readily as outside
 *  them, so `users.info` returns as `<http://users.info|users.info>`. That is
 *  Slack's transformation of Slack's own storage, so a read-back that reports it as
 *  a difference cries wolf on every message that names a module, a domain or a
 *  file, and a guard agents learn to skip guards nothing.
 *
 *  This behavior applies only to the auto-link format where the label repeats the
 *  target. A written link whose label says something else belongs to the author
 *  and stays whole.
 *
 *  THE BARE FORM CORRUPTS CODE. A full URL comes back wrapped with no label at all,
 *  `<http://127.0.0.1:8080>`, and that form survived this function: an agent sent
 *  four source files to a peer, and the two holding a URL in a string literal
 *  arrived with the brackets inside the quotes. The sender saw their own draft and
 *  read nothing wrong. Unwrapping it returns the bytes the author typed, and an
 *  author who typed the bracketed form gets the same URL either way.
 */
export function undoAutoLinks(text: string): string {
  return text
    .replace(/<(?:https?:\/\/|mailto:)([^|>]+)\|([^>]+)>/g, (whole, target: string, label: string) =>
      target === label || target.replace(/\/$/, "") === label ? label : whole,
    )
    // Only these schemes. A user mention is `<@U0…>`, a broadcast is `<!channel>`,
    // and a channel link is `<#C0…>`, none of which this may touch. A bare mail
    // address loses the scheme, which is what the labelled form already does.
    .replace(/<(https?:\/\/[^|>\s]+)>/g, "$1")
    .replace(/<mailto:([^|>\s]+)>/g, "$1");
}

export function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 *  The three broadcasts appear in the form a reader sees.
 *
 *  One pair operates in two directions. The `normalize` tool turns `<!channel>`
 *  into `@channel` for the reader and the ledger, and `denormalize` turns
 *  `@channel` back into the entity that notifies. A draft written with `@channel`,
 *  in the manner the skill teaches, went out as literal text and notified nobody.
 *  A draft written with the raw entity read back in the other form and made
 *  `--verify` print DIFFERS over an intact message. Both directions come from this
 *  single list.
 */
export const BROADCAST_KINDS = ["channel", "here", "everyone"] as const;

/**
 *  The sent text uses the form the read-back returns, so the two compare as equals.
 */
export function readerBroadcasts(text: string): string {
  return text.replace(/<!(channel|here|everyone)>/g, (_w, kind: string) => `@${kind}`);
}

export function computeMentions(channel: string, text: string, sender: string): string[] {
  const out = new Set<string>();
  if (channel.startsWith(DM_PREFIX)) {
    for (const seg of channel.split("/").slice(1)) {
      if (seg && seg !== sender) out.add(seg);
    }
  } else {
    // The parser scans prose only, because `denormalize` skips fenced blocks and
    // backtick spans, and Slack therefore creates no entity for an `@name` written
    // inside one. The earlier implementation counted them anyway, so a delivery
    // claimed a mention that notified nobody. In a message whose fence carried the
    // words `preserve EVERY @name`, the delivery returned with `name` in its mention
    // list, and no such agent exists. The extractor uses the same name pattern
    // `denormalize` converts, so what this records and what Slack notifies remain the
    // same string. Splitting on whitespace and trimming non-word characters retained
    // a possessive: `@alignment_benchmark's` converted to that agent's id and
    // recorded `alignment_benchmark's`, a name nobody has, so the person received a
    // ping while their ledger owed nothing. The extractor also applies the whole
    // pattern `denormalize` uses, including its leading boundary. Taking the name
    // portion and dropping the boundary caused `ret@4096` to record 4096 and an email
    // address to record its domain, entering mentions of non-handle strings into the
    // same ledger that holds a real one. The character `<` sits with the name
    // characters so an already-converted `<@U123>` is left to the entity reader.
    for (const m of proseOf(text).matchAll(/(?:^|[^A-Za-z0-9._<-])@([A-Za-z0-9._-]+)/g)) {
      const name = (m[1] ?? "").replace(/[._-]+$/, "");
      if (name) out.add(name);
    }
  }
  return [...out];
}

/**
 *  The Slack backend sends post, history, listen, and next operations directly to
 *  Slack. It is the third backend to support the same verbs that the local and raft
 *  backends provide.
 */
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
  /**
   *  The path `<channel>/<root>/<agent>` identifies that agent in that thread.
   */
  private readonly threadCache = new Map<string, boolean>();
  /**
   *  The system maps each Slack channel ID to its scrambled name for channels absent
   *  from the config.
   */
  private readonly channelNameCache = new Map<string, string>();
  /**
   *  The mapping relates each channel name to its Slack ID, returning `""` for a name
   *  this agent cannot reach.
   */
  private readonly channelIdCache = new Map<string, string>();
  private readonly teamIdCache = new Map<string, string>();
  /**
   *  This process retains timestamps it has already delivered, so one message
   *  arriving under two event types produces one line. The lifetime of a listener
   *  bounds this behavior and defines its scope.
   */
  private readonly deliveredTs = new Set<string>();
  /**
   *  Each process pages users.list at most once. The process remembers any name Slack
   *  does not have as a miss, so an unknown name costs one lookup in total.
   */
  private rosterLoaded = false;
  private readonly rosterMisses = new Set<string>();
  private readonly roster: Record<string, string>;
  private readonly origin: Origin | undefined;
  private readonly filesDir: string;
  /**
   *  This cache stores `users.info` responses so a repeated unknown id never
   *  triggers a new query. The cache key is `<acting token>:<user id>` because each
   *  agent resolves names under its own credentials. The same Slack user id can
   *  answer differently under one app than under another, so two apps must never
   *  share a cache slot.
   */
  private readonly nameCache = new Map<string, string>();
  /**
   *  This map records whether a Slack user ID belongs to a bot. The system populates
   *  entries from `users.list`, and queries `users.info` for any ID that `users.list`
   *  did not contain.
   */
  private readonly botById = new Map<string, boolean>();

  constructor(cfg: SlackBackendConfig, deps: SlackBackendDeps) {
    this.fetch = deps.fetch;
    this.createSocket = deps.createSocket;
    this.sleep = deps.sleep;
    this.now = deps.now ?? (() => Date.now());
    this.token = cfg.token;
    this.appToken = cfg.appToken;
    this.agents = cfg.agents;
    this.humanUserId = cfg.humanUserId;
    this.roster = cfg.roster;
    this.origin = cfg.origin;
    this.filesDir = cfg.filesDir;
    this.dmChannels = cfg.dmChannels;
    this.channelById = Object.fromEntries(Object.entries(cfg.channels).map(([r, c]) => [c, r]));
    this.channels = cfg.channels;
  }

  /**
   *  A single helper determines which bot token the acting agent uses. The helper
   *  returns the agent's own token when available, or falls back to the default
   *  token in the configuration, which is how `post` already resolves it. Every
   *  outbound Slack call site (posting, reading history, expanding threaded replies,
   *  looking up names with `users.info`, and downloading inbound attachments)
   *  resolves tokens through this helper, so the system never loses the acting
   *  identity on a read that was sent with a different agent's credential. When
   *  neither the agent nor the default configuration provides a token, the helper
   *  returns a failure that names the agent and the missing configuration key.
   */
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

  /**
   *  The acting agent uses an app-level token (xapp-) for its SOCKET connection. It
   *  uses the agent's own per-agent appToken when present, and the top-level default
   *  otherwise, so a single-app config keeps working unchanged.
   */
  /**
   *  To determine whether a line addresses an agent, Slack resolves `<@U…>` to the
   *  application handle. This handle is a different string from the agent's scramble
   *  name. The handle for `scramble-dev` is `scramble_dev`, so a mention arrived with
   *  `mentioned:false` and the tier-one wake path, which filters on
   *  `"mentioned":true`, slept through it. The handle recorded on the agent's config
   *  entry is an alias for its name.
   */
  /**
   *  Every line records the speaker as `operator`, `teammate`, `human`, or `agent`.
   *
   *  Scramble clearly indicates whether the speaker is a human or an agent. That
   *  distinction is never in doubt: a `bot_id` on the event shows that an app spoke,
   *  and its absence shows that a person did.
   *
   *  Distinguishing which human spoke requires a configuration entry. The
   *  `humanUserId` parameter names the person who authorized the session, so the
   *  system separates `operator` and `teammate` only where it records this
   *  identifier. Without this setting, the value is `human`, which provides the
   *  necessary classification without guessing further details. The system
   *  previously omitted this field in that case, which caused a person and an
   *  unknown entity to appear identical.
   */
  private senderKind(ev: SlackInboundEvent): "operator" | "teammate" | "human" | "agent" {
    if (ev.bot_id !== undefined && ev.bot_id !== "") return "agent";
    if (this.humanUserId === undefined || this.humanUserId === "") return "human";
    return ev.user === this.humanUserId ? "operator" : "teammate";
  }

  /**
   *  This field contains every name the agent answers to: its scramble name and,
   *  when recorded, its Slack handle. The definition is PUBLIC because
   *  `message check` in the CLI does its own delivery filtering and needs the same
   *  answer; maintaining two copies of the agent's identity caused the handle
   *  mismatch to reach three places at once.
   */
  identities(agent: string): string[] {
    const handle = this.agents[agent]?.handle;
    return handle !== undefined && handle !== "" && handle !== agent ? [agent, handle] : [agent];
  }

  private addressesAgent(mentions: string[], agent: string): boolean {
    if (mentions.some((m) => BROADCAST_NAMES.includes(m))) return true;
    return this.identities(agent).some((id) => mentions.includes(id));
  }

  /**
   *  The agent determines whether it participates in a thread. A reply inside a
   *  thread that the agent started or previously answered addresses the agent whether
   *  or not the text names it. Slack handles thread context this way for human users,
   *  and a name-only match misses every threaded answer to a message the agent sent.
   *
   *  The system resolves participation from Slack's own record, so the result stays
   *  accurate across restarts, across machines, and for threads that predate this
   *  code. The system caches each lookup per root message, since a busy thread asks
   *  the same question repeatedly.
   */
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

  /**
   *  The system uses the acting agent's token when the agent has one, or the
   *  configuration default. A LOOKUP uses this token, where a refusal costs a name
   *  and the message still goes, so falling back beats failing before the verb
   *  reports its own error.
   */
  private tokenOrDefault(agent: string): string {
    const t = this.agentToken(agent);
    return t.ok ? t.token : this.token;
  }

  /**
   *  The system queries Slack for workspace members to record every `@name` in this
   *  text that the roster does not already contain.
   *
   *  The roster is a cache, but the system treated it as the authority. The system
   *  writes the roster at onboarding, so anyone who joins afterward is absent from
   *  it, and `denormalize` leaves an unknown name as literal text. The channel map
   *  shares this design as a manually maintained copy of data that Slack holds.
   *
   *  Two separate mention paths exist. The Slack entity drives the notification a
   *  human receives, and this path failed. The `mentioned` stamp that wakes an agent
   *  is computed by `computeMentions` from the text's `@name` tokens after inbound
   *  entities normalize back to names, so a literal name wakes an agent. Measurements
   *  from the receiving agent confirmed that it missed zero messages.
   *
   *  Therefore, a gap here costs a person their notification and costs an agent
   *  nothing.
   *
   *  The system pages `users.list` once per process and only when a name is
   *  unknown, so an agent communicating with known people incurs no cost. A name
   *  that Slack does not hold remains literal text, which is correct because no
   *  such member exists in the workspace.
   */
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
        members?: Array<{ id?: string; name?: string; deleted?: boolean; is_bot?: boolean }>;
        response_metadata?: { next_cursor?: string };
      }>(this.fetch, q, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) break;
      for (const u of r.data.members ?? []) {
        if (u.deleted === true) continue;
        // Slack marks every member as a bot or a person on the same page that carries
        // the
        // name. The channel tier is a count of who is in the room.
        if (typeof u.id === "string" && typeof u.is_bot === "boolean") this.botById.set(u.id, u.is_bot);
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

  /**
   *  The agent requires this workspace ID for conversations.list on an organization
   *  install. Without it, Slack answers `missing_argument` and every name lookup
   *  fails.
   *
   *  auth.teams.list provides this ID because it is the only method that names
   *  workspaces. On an enterprise install, auth.test reports `team_id` as the
   *  organization ID (identical to its own `enterprise_id`), and conversations.list
   *  answers `team_access_not_granted` to that ID, so reading the obvious field gives
   *  an ID that is wrong in a way whose error names neither the field nor the fix.
   *  Measured against this organization, auth.test returns E01EXAMPLE1,
   *  auth.teams.list returns T01EXAMPLE1, and only T01EXAMPLE1 works.
   *
   *  This value is empty when the login covers no workspace or several workspaces,
   *  since there is then no single answer to invent. The lookup still runs, and the
   *  caller reports Slack's own refusal. The agent caches this value per token
   *  because it cannot change under a running process.
   */
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

  /**
   *  This function returns the Slack ID for a channel name, or returns the ID when
   *  the caller already provides one. The configuration map takes precedence; when a
   *  name is absent from the map, the function looks up the channel among the
   *  conversations the agent belongs to.
   *
   *  This function mirrors `channelNameFor`. After inbound resolution shipped, a
   *  measurement recorded 129 messages arriving from a channel whose name `message
   *  read`, `send`, `react` and `channel join` all refused with "no Slack channel for
   *  channel <name>". An agent could hear a room and could not answer in it. The
   *  lookup caches results, including misses, so an invalid name costs one lookup.
   *
   *  The lookup returns Slack's refusal response with the miss inside it. The lookup
   *  previously exited the paging loop with `break` on any API error and reported the
   *  same "no Slack channel for <name>" error that a genuine typo produces, so the
   *  two were indistinguishable. In this organization every lookup produced an error,
   *  because `conversations.list` requires a `team_id` that the caller did not
   *  provide. The name of a channel that an operator had just invited an agent into
   *  returned as if the channel did not exist.
   */
  /**
   *  This function returns the Slack channel id for a scramble channel name under
   *  an agent's own credential, or returns undefined when it cannot resolve the
   *  channel.
   *
   *  The function is public so the STATUS path resolves the same way the post path
   *  does. It previously read a hand-maintained map and nothing else, so a channel
   *  absent from the map (every channel an agent was invited into without a config
   *  edit) and a stale map entry both ended as `status: channel_not_found`, in a
   *  feature that has already been silently dead once for that exact error.
   */
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
    // A raw Slack ID directly provides the target value. The `channel` parameter
    // usually contains an encoded name, and an agent that reads an identifier from an
    // event or a log already holds the target of the lookup. Querying
    // conversations.list with this identifier only asks whether a channel is named
    // "C0EXAMPLE007".
    if (/^[CGD][A-Z0-9]{6,}$/.test(name)) return { id: name };
    const cached = this.channelIdCache.get(name);
    if (cached !== undefined && cached !== "") return { id: cached };
    const team = await this.teamIdFor(token);
    let cursor = "";
    // THE AGENT'S OWN CONVERSATIONS. The `users.conversations` method returns exactly
    // the channels this token belongs to, which is the exact set it can act on. A bot
    // cannot post to, read, or react in a channel it was never invited to, so a name
    // matching another channel resolves to an id that fails with `not_in_channel`,
    // which reads worse than stating that the agent is outside that channel.
    //
    // The `conversations.list` method was the wrong tool for two reasons. It returns
    // the whole workspace, measured here at 203 channels against the 2 this agent is
    // in, so the walk was a hundred times the size of the question. In addition, it
    // was capped at ten pages, which on a workspace past 2000 channels stops and
    // reports the same "no Slack channel" message that a typo produces. The
    // model-failure-research agent raised this after failing to resolve a private
    // channel it was in. That failure did not reproduce (paged with a `team_id`,
    // `conversations.list` listed every private channel each agent belongs to), and
    // the reasons above carry the change on their own.
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

  /**
   *  The agent resolves its own Slack user ID by inverting the configuration's
   *  roster mapping of IDs to names against its identities. This ID is undefined
   *  when the roster does not name the agent. When the ID is undefined, the agent
   *  cannot distinguish its own join events from those of other users, so it leaves
   *  the join event alone.
   */
  private userIdFor(agent: string): string | undefined {
    const names = this.identities(agent);
    for (const [id, name] of Object.entries(this.roster)) if (names.includes(name)) return id;
    return undefined;
  }

  /**
   *  This function resolves a Slack channel id to a name. The configuration mapping
   *  takes precedence. When a channel is absent from the configuration, the system
   *  requests its name through `conversations.info`, and uses the raw channel id when
   *  that request is refused.
   *
   *  The system previously returned `undefined` for an unmapped channel and dropped
   *  the message, silently and with nothing reported, so inviting an agent to a new
   *  channel delivered nothing until someone edited `slack.json` by hand. An agent
   *  that has been invited somewhere should hear it, and a name it cannot look up is
   *  a naming problem, and the message still goes through. The system caches names
   *  per id.
   */
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

  /**
   *  Add an emoji reaction to a message. A reaction acknowledges a message without
   *  taking up an entire line in the channel. An agent that replies with "got it" in
   *  text adds noise where a tick mark suffices.
   *
   *  The system reports `already_reacted` as a success, since the state requested by
   *  the caller is the state that holds.
   */
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
      // The log records the outgoing request alongside the response. The error message
      // `react failed: channel_not_found` reported only the error name, and an agent
      // measured that a direct `reactions.add` call with what appeared to be matching
      // inputs answered `ok:true`. A reader could not identify the outgoing channel id
      // or the active credential from that line, so the report could go no further.
      //
      // The log names each token by its source and suppresses the secret itself. An
      // agent's token and the configuration default represent different applications,
      // and identifying which application acted is the first requirement when Slack
      // reports that a channel does not exist.
      const via = this.agents[as]?.token !== undefined && this.agents[as]?.token !== "" ? `${as}'s own token` : "the config default token";
      return {
        ok: false,
        error: `${r.error} (channel ${channel} resolved to ${slackChannel}, ts ${ts}, under ${via})`,
      };
    }
    return { ok: true };
  }

  /**
   *  REWRITE ONE MESSAGE THAT IS ALREADY IN THE CHANNEL.
   *
   *  Agents edit and delete messages. Slack allows a bot token to edit only what
   *  that token posted, and it states which token posted it, so the refusal names
   *  the credential that acted.
   *
   *  The text passes through `denormalize` exactly as a post does, so an `@name` in
   *  an edit notifies the same person it would have notified in the send.
   */
  async update(
    channel: string,
    ts: string,
    text: string,
    as: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as), channel);
    if (resolved.id === undefined) return { ok: false, error: resolved.error };
    const t = this.agentToken(as);
    if (!t.ok) return { ok: false, error: t.error };
    await this.learnNames(t.token, text);
    const r = await readOk(this.fetch, UPDATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ channel: resolved.id, ts, text: denormalize(text, this.roster) }),
    });
    return r.ok ? { ok: true } : { ok: false, error: this.actedAs(r.error, channel, resolved.id, ts, as) };
  }

  /**
   *  Delete one message that this agent posted.
   */
  async remove(channel: string, ts: string, as: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as), channel);
    if (resolved.id === undefined) return { ok: false, error: resolved.error };
    const t = this.agentToken(as);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await readOk(this.fetch, DELETE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ channel: resolved.id, ts }),
    });
    return r.ok ? { ok: true } : { ok: false, error: this.actedAs(r.error, channel, resolved.id, ts, as) };
  }

  /**
   *  Record Slack's error alongside the request and the credential that made it.
   *  A bare `message_not_found` reads as "no such message" when it usually means
   *  the message belongs to a different app.
   */
  private actedAs(error: string, channel: string, id: string, ts: string, as: string): string {
    const own = this.agents[as]?.token;
    const via = own !== undefined && own !== "" ? `${as}'s own token` : "the config default token";
    return `${error} (channel ${channel} resolved to ${id}, ts ${ts}, under ${via})`;
  }

  /**
   *  The sweep processes every channel by name in which this agent is a member.
   *
   *  Previously, the sweep traversed `cfg.channels`, a map maintained by hand in a
   *  configuration file that several agents share and edit. A peer removed two
   *  entries while testing name resolution, so this agent's `message check` stopped
   *  covering the channel where the operator speaks to it. The check reported
   *  "none of the 3 configured channels are readable" and swept nothing that
   *  mattered, while the listener kept delivering, so nothing looked broken.
   *
   *  Slack stores channel membership. Querying Slack takes one call, and that result
   *  cannot fall out of date the way a map maintained by hand does.
   */
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
      // The system reports membership explicitly. A caller cannot read an empty list as
      // an agent in no channels, because an agent in no channels and an agent whose
      // membership call was refused look identical from the outside, and one of them
      // is a broken credential.
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

  /**
   *  Determine whether the agent's application is in the conversation, and find
   *  its handle. An application cannot add itself to a public or private Slack
   *  conversation. A member invites the application. So the useful answer to
   *  whether it joined reports whether the invite occurred, and gives the handle to
   *  invite when the invite has not happened. A one-message read serves as the
   *  probe, because that read is the access the agent needs.
   */
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

  /**
   *  The operation publishes a post to the mapped Slack channel, using the agent's
   *  own bot token when present, or the configuration token otherwise. A Slack
   *  failure (`ok:false` with error text) surfaces as a FAILURE carrying that text,
   *  and the system never treats the failure as a success.
   *
   *  The call returns the ts value Slack gave the message, so the ledger can name
   *  the reply that closed an item. Without it, `answeredBy` held a wall-clock string
   *  pointing at nothing, which `inbox trace` printed and made obvious.
   */
  async post(
    channel: string,
    text: string,
    as: string,
    thread?: string,
  ): Promise<{ ok: true; ts?: string; thread?: string; problem?: string } | { ok: false; error: string }> {
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as), channel);
    if (resolved.id === undefined) return { ok: false, error: resolved.error };
    const slackChannel = resolved.id;
    const t = this.agentToken(as);
    if (!t.ok) return { ok: false, error: t.error };
    const token = t.token;
    // A name known to Slack but absent from the roster would go out as literal text
    // and notify nobody, which is what happened the hour a third agent joined.
    await this.learnNames(token, text);
    const r = await readOk<{ error?: string; ts?: string; message?: { thread_ts?: string } }>(this.fetch, POST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        channel: slackChannel,
        text: denormalize(text, this.roster),
        ...(thread !== undefined ? { thread_ts: thread } : {}),
        // The message itself records where this agent runs. Slack carries metadata
        // through
        // history and through the socket, which is how the system already recognises a
        // peer's status line, so this requires no app change from anyone and works for
        // an
        // app owned by a different login.
        //
        // The sender names itself. The field `as` holds the scramble name, and a
        // receiver
        // reading `from` off the delivered line sees the Slack handle, so one agent
        // held
        // two rows in the peer record under its two ids.
        ...(this.origin === undefined ? {} : { metadata: originMetadata({ ...this.origin, agent: as }) }),
      }),
    });
    if (!r.ok) return { ok: false, error: r.error };
    // The service silently accepts a thread_ts that references no existing message.
    // When measured against this workspace, posting with a ts that names no message
    // returns ok:true, places the message at the top level of the channel, and
    // delivers a response carrying no message.thread_ts. A mistyped digit once placed
    // a reply to the operator outside the thread it answered, and the send reported
    // success.
    //
    // The response provides the evidence and costs nothing to read: a threaded post
    // that returns without message.thread_ts was not threaded. The program reports
    // the issue as a PROBLEM, with a 0 exit, because the message did reach the
    // channel and a caller that retries would say everything twice.
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
      // Slack silently hoists a `thread_ts` that targets a reply. Slack has no nested
      // threads, so it puts the message in that reply's root thread and returns the
      // timestamp of the root message. Measurements show that aiming at a reply puts
      // the
      // message in the root thread and returns the root `thread_ts`, so a check for
      // whether the message threaded passes while the message resides in a conversation
      // different from the one requested. The execution generates no warning.
      if (landed !== thread) {
        return {
          ok: true,
          ...(typeof r.data.ts === "string" ? { ts: r.data.ts } : {}),
          // A reader finds where a message went by querying
          // `conversations.replies`
          // for the root message that Slack selected. When an agent threaded under a
          // reply,
          // the read-back returned "slack has no message at <ts>" for a message present
          // in
          // the channel.
          thread: landed,
          problem:
            `posted to ${channel} in thread ${landed}, and NOT in ${thread} as asked: Slack has no ` +
            `nested threads, so a thread_ts naming a REPLY is hoisted into that reply's root. ` +
            `The message IS in the channel, at ts ${String(r.data.ts ?? "unknown")}. Pass the ` +
            `root's ts, which a delivered line carries as its own \`thread\`.`,
        };
      }
    }
    return {
      ok: true,
      ...(typeof r.data.ts === "string" ? { ts: r.data.ts } : {}),
      ...(thread !== undefined && thread !== "" ? { thread } : {}),
    };
  }

  /**
   *  WHETHER THIS CHANNEL HOLDS A MESSAGE AT THIS ts, and what sits beside it.
   *
   *  Agents use citations to direct readers to evidence, but a mistyped digit points
   *  to a message that does not exist. In one case, an agent copied a timestamp by
   *  hand from a notification preview and cited `1787656658.009669` for a line Slack
   *  holds at `1787656658.009699`, which forced the reader to search the channel to
   *  find what was meant. Four investigations in one day turned on an exact ts.
   *
   *  The whole-second value serves as the detector. A ts whose whole-second portion
   *  matches a real message while the fraction differs is a transcription error,
   *  because nothing else produces that pattern. A ts belonging to another channel
   *  matches no second this channel holds, so the detector stays quiet: agents learn
   *  to ignore a check that fires on a correct citation.
   */
  async citedMessage(
    channel: string,
    ts: string,
    as: string,
  ): Promise<{ exact: boolean; near?: string; author?: string; error?: string }> {
    const second = ts.split(".")[0] ?? "";
    if (!/^\d{10}$/.test(second)) return { exact: false, error: `${ts} is not a Slack ts` };
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as), channel);
    if (resolved.id === undefined) return { exact: false, error: resolved.error };
    const t = this.agentToken(as);
    if (!t.ok) return { exact: false, error: t.error };
    // The time interval covers the full second surrounding the citation, including
    // both endpoints.
    const url =
      `${HISTORY_URL}?channel=${encodeURIComponent(resolved.id)}` +
      `&oldest=${encodeURIComponent(`${second}.000000`)}&latest=${encodeURIComponent(`${second}.999999`)}` +
      `&inclusive=true&limit=20`;
    const r = await readOk<{ messages?: Array<{ ts?: string; user?: string; username?: string }> }>(this.fetch, url, {
      headers: { authorization: `Bearer ${t.token}` },
    });
    if (!r.ok) return { exact: false, error: r.error };
    const rows = (r.data.messages ?? []).filter((m) => (m.ts ?? "") !== "");
    // Record who wrote the message on the note. Citing a timestamp attributed an
    // incident to the wrong agent. The timestamp and the incident belonged to a third
    // agent, and the named agent had to issue a correction. A timestamp points to an
    // author, and the send operation reads the author already.
    const named = async (row: { user?: string; username?: string }): Promise<string | undefined> => {
      if (row.username !== undefined && row.username !== "") return row.username;
      if (row.user === undefined || row.user === "") return undefined;
      return this.resolveName(t.token, row.user);
    };
    const exact = rows.find((m) => m.ts === ts);
    if (exact !== undefined) {
      const author = await named(exact);
      return { exact: true, ...(author === undefined ? {} : { author }) };
    }
    const near = rows[0];
    if (near === undefined) return { exact: false };
    const author = await named(near);
    return { exact: false, near: near.ts!, ...(author === undefined ? {} : { author }) };
  }

  /**
   *  Read one message back from Slack by its `ts` timestamp, as Slack stored it.
   *
   *  The exit code of a send operation indicates that Slack accepted the payload,
   *  but gives no information about what the channel now holds. The message
   *  rewriter, mention conversion, and Slack's own formatting alter the posted
   *  content after receipt. Three agents created their own read-back wrappers to
   *  inspect the stored output.
   *
   *  The `oldest` parameter is inclusive and `latest` is exclusive, so a single-message
   *  window requires `inclusive=true` with both endpoints set to the same `ts`.
   */
  async storedMessage(
    channel: string,
    ts: string,
    as: string,
    thread?: string,
  ): Promise<{ ok: true; text: string; mentions: string[] } | { ok: false; error: string }> {
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as), channel);
    if (resolved.id === undefined) return { ok: false, error: resolved.error };
    const t = this.agentToken(as);
    if (!t.ok) return { ok: false, error: t.error };
    // The conversations.history endpoint omits thread replies, so verifying a reply
    // returned "slack has no message at <ts>" while `message read` found the message
    // and its text was intact. An agent measured this behavior on its own threaded
    // reply and kept its wrapper for this case. The client reads a reply through
    // conversations.replies on its root message, using the timestamp that the send
    // operation threaded under.
    const threaded = thread !== undefined && thread !== "";
    const base = threaded
      ? `${REPLIES_URL}?channel=${encodeURIComponent(resolved.id)}&${WITH_METADATA}` +
        `&ts=${encodeURIComponent(thread)}&limit=200`
      : `${HISTORY_URL}?channel=${encodeURIComponent(resolved.id)}&${WITH_METADATA}` +
        `&oldest=${encodeURIComponent(ts)}&latest=${encodeURIComponent(ts)}&inclusive=true&limit=1`;
    // A reply past the first page remains in the channel. The `conversations.replies`
    // method returns thread messages in oldest-first order, so a newly posted reply
    // resides on the last page, and a single 200-reply request answers "slack has no
    // message at <ts>" for a message sitting in the thread. This is the same false
    // negative that made a sender post twice, one page further out.
    let row: { ts?: string; text?: string } | undefined;
    let cursor = "";
    let pages = 0;
    for (;;) {
      pages += 1;
      const r = await readOk<{
        messages?: Array<{ ts?: string; text?: string }>;
        response_metadata?: { next_cursor?: string };
      }>(this.fetch, cursor === "" ? base : `${base}&cursor=${encodeURIComponent(cursor)}`, {
        headers: { authorization: `Bearer ${t.token}` },
      });
      if (!r.ok) return { ok: false, error: r.error };
      row = (r.data.messages ?? []).find((m) => m.ts === ts);
      if (row !== undefined) break;
      const next = r.data.response_metadata?.next_cursor ?? "";
      // The inspection is bounded, and the system reports the bound. When a thread is
      // longer than this limit, the output states how far it looked, so nobody reads
      // the answer as "the message is gone".
      if (!threaded || next === "" || pages >= REPLY_PAGE_CAP) {
        return {
          ok: false,
          error:
            `slack has no message at ${ts} in ${channel}` +
            (threaded ? `, searched ${pages} page(s) of thread ${thread}${next === "" ? "" : " and more remain"}` : ""),
        };
      }
      cursor = next;
    }
    const stored = row.text ?? "";
    // A single message produces two readings. The normalized text provides what a
    // reader sees and what the sender compares against. Slack sends notifications
    // only for entities, and only `<@U…>` in the raw text serves as an entity.
    //
    // Counting `@name` tokens in the text conflates these forms. A mention that failed
    // to convert still reads as a mention, which is the exact defect that shipped this
    // evening, so the check would have reported a live mention for a name notifying
    // nobody.
    const entities = [...stored.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => this.roster[m[1] ?? ""] ?? (m[1] ?? ""));
    // A broadcast entity notifies the room, and this list held user entities alone,
    // so `--verify` reported a live `<!channel>` as a mention that notified nobody.
    // An agent read that on a test send and took it as proof the broadcast was inert.
    for (const m of stored.matchAll(/<!(channel|here|everyone)>/g)) entities.push(m[1] ?? "");
    const text = await this.normalize(t.token, stored);
    return { ok: true, text, mentions: [...new Set(entities)] };
  }

  /**
   *  The file upload routine sends a file to a channel through the same channel
   *  resolution and mention conversion that a plain post receives.
   *
   *  Earlier versions bypassed both steps. `attachmentUpload` read
   *  `cfg.channels[target]` directly, so an upload to a channel that the agent
   *  occupied failed with "no Slack channel" when the configuration omitted the
   *  mapping, while a plain send to that channel succeeded. The text also traveled
   *  to Slack as `initial_comment` without denormalization, so a message that opened
   *  with a name stored the raw literal text and notified nobody. Live channel
   *  measurements confirmed that the upload path omitted the operations that a plain
   *  send performs.
   *
   *  The upload routine now lives beside post(), because both operations ask the
   *  same question once: which channel receives the payload, and which names appear
   *  in the text.
   */
  async upload(
    channel: string,
    filePath: string,
    as: string,
    mimeOverride?: string,
    initialComment?: string,
    thread?: string,
  ): Promise<{ ok: true; id: string; permalink?: string; ts?: string } | { ok: false; error: string }> {
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
    return r.ok
      ? {
          ok: true,
          id: r.out.id,
          ...(r.out.permalink !== undefined ? { permalink: r.out.permalink } : {}),
          ...(r.out.ts !== undefined ? { ts: r.out.ts } : {}),
        }
      : { ok: false, error: r.error };
  }

  /**
   *  To resolve a Slack user id to a name, the system checks the roster first, then
   *  users.info, since the app holds users:read. An id absent from the roster
   *  resolves through users.info, and a raw id passed through matches no agent name,
   *  so a <@U…> mention would arrive silently unmentioned. The system caches lookups
   *  per acting credential (the `token` argument), so one agent's lookup can never
   *  reuse another agent's answer.
   */
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

  /**
   *  The system normalizes `<@U…>` to `@name`. An ID in the roster resolves
   *  immediately. An ID absent from the roster resolves through cached `users.info`,
   *  so a mention never arrives silently unmentioned. The system performs this
   *  resolution under the acting agent's own credential (`token`).
   */
  private async normalize(token: string, text: string): Promise<string> {
    // A broadcast addresses every agent in the channel, but arrived as raw text that
    // matched nothing. A broadcast reading `<!channel> ensure everything you write
    // to files are English`, the message reached no agent inbox. The payload arrived
    // with `mentions: []` and `mentioned: false`, so every agent saw the broadcast
    // only during the 15-minute sweep, if at all. Three agents measured this behavior
    // independently against their own inboxes and wake logs.
    //
    // Agent compliance appeared successful. All three agents acted on that broadcast
    // within minutes, which is indistinguishable from working delivery from the
    // outside. Three agents complying demonstrates that three agents drain their
    // inboxes often enough to catch an unannounced message. If any agent had been
    // mid-job, the broadcast would have sat unseen until the next sweep.
    //
    // Formatting broadcasts as `@channel`, `@here`, and `@everyone` allows
    // `computeMentions` to process them like any other name, so one normalization
    // makes the existing machinery do the rest.
    let out = readerBroadcasts(text);
    for (const m of out.matchAll(/<@([A-Z0-9]+)>/g)) {
      const uid = m[1]!;
      const name = await this.resolveName(token, uid);
      out = out.replace(`<@${uid}>`, `@${name}`);
    }
    return undoAutoLinks(unescapeSlack(out));
  }

  /**
   *  The system downloads every file on an event into filesDir and maps each to
   *  an Attachment on the line. All downloads use the acting agent's bot token
   *  (`token`), because Slack file access follows the app. When a download fails,
   *  the system reports the failure by pushing it onto `problems`, and the message
   *  still carries the file's metadata without a `path`, so the agent learns a file
   *  exists and that fetching it failed.
   */
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
      // An agent downloads bytes only for messages addressed to this agent. The
      // metadata always arrives, so the id is enough to fetch later, and
      // `attachment view` fetches from Slack when the file is not on disk.
      //
      // The delivery path previously downloaded every file that passed through a
      // channel for every agent in that channel. Three agents in one room each
      // downloaded the same 41MB archive addressed to one of them on a filesystem at
      // 99%, and each download delayed deliveries for other agents.
      if (f.url_private && wanted) {
        const r = await downloadFile(this.fetch, f.url_private, token, this.filesDir, fileId, name);
        if (r.ok) entry.path = r.path;
        else problems.push(r.error);
      }
      output.push(entry);
    }
    return { files: output, problems };
  }

  /**
   *  The function transforms a single inbound event into an outbound Delivery. The
   *  function returns undefined when the event contains no text, represents an
   *  unhandled event type, or belongs to an unknown channel. This step is pure and
   *  applies no self-suppression. The function returns every line, and the delivery
   *  path (next/listen) decides which senders to suppress by name. The function also
   *  downloads any `files` the event carries using the acting agent's `token`, and it
   *  reports a download failure that still leaves the message deliverable.
   */
  private async toDelivery(
    ev: SlackInboundEvent,
    as: string,
    token: string,
    // Query Slack for the members of a thread only on the delivery path. The
    // `history` command runs this same converter over every row and then discards
    // `mentioned`, because a transcript has no per-recipient state, so running the
    // query there would spend one conversations.replies call per threaded row to
    // compute a value nobody reads.
    wantThreadWake = false,
  ): Promise<{ delivery: Delivery | undefined; problems: string[] }> {
    // An invitation is news. Adding a member to a channel reaches a human's
    // attention, and an agent that learns of the addition only by overhearing later
    // traffic has already missed whatever it was added for. An invite is delivered as a
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
          // Slack generated this message as an automated system. A join notice is
          // machine-generated, so `agent` is the correct value for a field that records
          // whether a human spoke.
          sender: "agent",
        },
        problems: [],
      };
    }
    // The system was dropping `app_mention` events, which carry mentions. Any event
    // with a type other than `message` returned no delivery, so an application
    // subscribed to `app_mention` had mentions arriving on its socket while the system
    // discarded every one: the mention was live on the wire while the inbox sat
    // silent. A fourth agent found this issue on an application it had adopted, which
    // subscribes to `app_mention` and to none of the message events.
    //
    // Both types carry the same fields, so both make the same delivery. An application
    // subscribed to both types sends a channel mention twice, once for each type,
    // which is what the `ts` deduplication in `listen` and `next` is for.
    if ((ev.type !== "message" && ev.type !== "app_mention") || !ev.text || ev.text === "") {
      return { delivery: undefined, problems: [] };
    }
    // A status is never a message, and the same rule applies to a peer's status.
    if (isStatusLine(ev)) return { delivery: undefined, problems: [] };
    const channel = ev.channel;
    if (channel === undefined) return { delivery: undefined, problems: [] };
    // The system normalizes <@U…> mentions to @name and resolves unseen IDs via
    // users.info under the acting agent's credential.
    const text = await this.normalize(token, ev.text);
    const from = await this.resolveSender(token, ev);
    const dmAgent = this.dmChannels[channel];
    // Mapped lookups do not use an await. A lookup that returns immediately still
    // spends a turn of the event loop when it is awaited, and every message pays that
    // cost.
    const mapped = this.channelById[channel];
    const channelName =
      dmAgent !== undefined
        ? `${DM_PREFIX}${dmAgent}/${from}`
        : mapped ?? (await this.channelNameFor(token, channel));
    // Slack ts acts as a per-channel cursor without a global sequence number, and
    // serves as both a timestamp and a deduplication identifier for a line.
    const ts = ev.ts ?? new Date().toISOString();
    const mentions = computeMentions(channelName, text, from);
    const thread = ev.thread_ts !== undefined && ev.thread_ts !== ts ? ev.thread_ts : undefined;
    // History strips per-recipient state only on the delivery path, so a transcript
    // does not require a lookup for each row.
    //
    // The guard sits at the call site because an `await` on the delivery path costs a
    // turn of the event loop even when the function returns immediately, and the
    // lookup cannot run without the CLI credential.
    //
    // Origin metadata records the sender's account of where it runs. Malformed
    // metadata reads as no origin and never blocks delivery, because the message is
    // the point.
    const origin = readOrigin(ev.metadata);
    // The system computes this before the files, because it decides whether the bytes
    // are fetched at all.
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
      // The archive preserves Slack's original bytes only when rendering changed them,
      // so a plain message carries no second copy.
      ...(ev.text !== undefined && ev.text !== text ? { raw: ev.text } : {}),
      id: ts,
      mentions,
      mentioned,
      ...(thread !== undefined ? { thread } : {}),
      sender: this.senderKind(ev),
      ...(origin === undefined ? {} : { origin }),
    };
    if (dl.files.length > 0) delivery.files = dl.files;
    return { delivery, problems: dl.problems };
  }

  /**
   *  To resolve the sender's name, the system looks up a user token formatted like a
   *  Slack ID first in the roster and then through users.info under the acting
   *  agent's `token`. A plain username passes through.
   */
  private resolveSender(token: string, ev: SlackInboundEvent): Promise<string> {
    const u = ev.user;
    if (u !== undefined && u !== "" && /^[UW][A-Z0-9]+$/.test(u)) return this.resolveName(token, u);
    return Promise.resolve(ev.username ?? "");
  }

/**
 *  When a Socket Mode connection is refused (for example, when
 *  apps.connections.open returns invalid_auth), scramble cannot check the channel,
 *  which says nothing about whether the channel was quiet. The report therefore
 *  names Slack's error and the `appToken` configuration key (the app-level xapp-
 *  token) that supplies the credential, because a wrong or missing app token must
 *  never read as silence.
 */
  private connectRefused(e: unknown): string {
    const detail = e instanceof Error ? e.message : String(e);
    return `apps.connections.open refused: ${detail} (config key: appToken)`;
  }

  /**
   *  The client opens a single Socket Mode connection by calling
   *  `apps.connections.open` with the acting agent's app-level token. The client
   *  uses the agent's own `appToken` when present, or uses the top-level default
   *  token, and then connects with the injected socket factory.
   */
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

  /**
   *  The client acknowledges an envelope and routes its event, honoring a server
   *  disconnect frame.
   */
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

  /**
   *  The system routes an inbound event through the channel filter and delivers it.
   *  The system reports a download problem through onProblem before delivering the
   *  line, so the agent learns a file failed but still gets the message. The
   *  delivery filter never delivers an agent's own post when the resolved sender name
   *  equals the consuming agent's name, so an agent does not answer itself. The local
   *  backend applies this same name mechanism to its stream. History never passes
   *  through this filter, so a transcript read keeps every line.
   */
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
      // An agent never delivers its own posts, because it would otherwise answer
      // itself.
      // The filter checks every name this agent answers to, including its handle. The
      // `from` value is the resolved sender, which for an app is its Slack handle
      // (`scramble_dev`), so comparing it against the scramble name (`scramble-dev`)
      // never matches and the agent is delivered its own posts. The loop caught this
      // behavior when the agent's own message returned to it as a wake.
      if (this.identities(as).includes(delivery.from)) return;
      // The system processes one line per message regardless of what Slack calls the
      // event. When an application subscribes to both message.channels and app_mention,
      // Slack sends a channel mention twice, once under each event type, and both
      // events
      // carry the same ts. Delivering both events would wake the agent twice for one
      // question and record two inbox items that need two answers.
      if (this.deliveredTs.has(delivery.ts)) return;
      this.deliveredTs.add(delivery.ts);
      if (wantsAll || channels.includes(delivery.channel)) {
        onLine(delivery);
      }
    });
  }

  /**
   *  Build a Message from a Slack history or replies row through the same ingestion
   *  path as a live event, so its thread, mentions, and files come out
   *  byte-identical, and append it to `messages`. The call returns the sequence
   *  number after the append, or the prior sequence number when the row carries no
   *  text and is dropped.
   */
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
      // Metadata is carried through. This projection names every field the converter
      // may read, so a field left out of it is invisible on the drain path while
      // working on the socket. The sender's origin arrived stamped, was delivered live,
      // and was dropped by `message check` because this list did not mention it.
      { type: "message", channel: slackChannel, user: m.user, username: m.user, ts: m.ts, thread_ts: m.thread_ts, text: m.text, bot_id: m.bot_id, files: m.files, metadata: m.metadata },
      as,
      token,
      forDelivery,
    );
    problems.push(...dlProblems);
    if (delivery === undefined) return seq;
    // History is scoped to a channel, so the system forces the requested `channel`.
    // A Slack ID identifies the Slack channel, and the channel mapping defines the
    // caller's frame. Slack has no global seq, so a synthetic per-history counter
    // stands in where the local line's `seq` lives. The message's ts is the real
    // cursor. A DRAIN keeps `mentioned`. A transcript drops `mentioned` because
    // per-recipient state has no meaning in a shared transcript.
    if (forDelivery) {
      messages.push({ ...delivery, channel, seq: seq + 1 } as Message);
      return seq + 1;
    }
    const { mentioned, ...rest } = delivery;
    void mentioned;
    messages.push({ ...rest, channel, seq: seq + 1 });
    return seq + 1;
  }

  /**
   *  The `history(channel, since)` function maps `conversations.history` entries into
   *  the local line format, which represents a channel-scoped `Message` with mentions.
   *  The `since` parameter maps to Slack's `oldest` cursor, so a resume operation
   *  picks up where the last `ts` stopped.
   *
   *  For threaded replies, `conversations.history` returns only top-level messages,
   *  and threaded replies live under `conversations.replies`. When Slack marks a
   *  top-level row as a thread root with a `reply_count` above zero and a `thread_ts`
   *  equal to its own `ts`, the handler expands that row with a single
   *  `conversations.replies` call, so `message read` and `message history` see the
   *  replies an agent posted under that root. The ingestion process avoids
   *  duplicating the root. Because `conversations.replies` returns the root as its
   *  first entry, the system drops that entry when its `ts` equals the root's `ts`.
   *  A root that has replies is not a reply and carries no `thread`, while the ingest
   *  rule assigns each reply a `thread` pointing to the root because its `thread_ts`
   *  differs from its own `ts`.
   */
  async history(
    channel: string,
    since?: string,
    as?: string,
    // The `message check` command drains through this method, so it acts as a
    // delivery even though it reads history. It needs `mentioned` computed against
    // thread participation. The `message read` command is a transcript and needs
    // neither, and paying for them per row there is waste.
    forDelivery = false,
  ): Promise<{ code: 0 | 1; error?: string; messages: Message[]; problems: string[] }> {
    const resolved = await this.slackChannelFor(this.tokenOrDefault(as ?? ""), channel);
    if (resolved.id === undefined) return { code: 1, error: resolved.error, messages: [], problems: [] };
    const slackChannel = resolved.id;
    const t = this.agentToken(as ?? "");
    if (!t.ok) return { code: 1, error: t.error, messages: [], problems: [] };
    const token = t.token;
    // THE CURSOR FILTERS THE LINES, and Slack's `oldest` filters the ROOTS. Passing
    // the cursor to the API hid every reply under a root older than it: an agent read
    // a channel whose recent traffic lives in old threads, got an empty answer from
    // `--after`, and concluded the messages were gone. The read asks for the recent
    // window, expands the threads, and drops what sits at or before the cursor.
    const qs = "";
    const r = await readOk<{ messages?: SlackHistoryMessage[] }>(
      this.fetch,
      `${HISTORY_URL}?channel=${encodeURIComponent(slackChannel)}&${WITH_METADATA}${qs}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return { code: 1, error: r.error, messages: [], problems: [] };
    const messages: Message[] = [];
    const problems: string[] = [];
    let seq = 0;
    // A caller maintains its cursor on `ts`, which serves as Slack's per-channel
    // cursor. The `conversations.history` method returns rows in newest-first order,
    // and the walk processes them in that exact order. A threaded root message's
    // replies sit in place, positioned immediately under the root, because
    // `conversations.replies` lists the root first and then its replies. Resuming at
    // a `ts` therefore encounters every line after it in the same relative order,
    // since a reply never reorders above its root, and the read executes in a single
    // pass that preserves Slack's overall newest-first sequence.
    //
    // The system determines which roots to expand before the walk begins, so the
    // choice depends on the newest reply independently of the order returned by
    // history.
    const roots = (r.data.messages ?? []).filter(isThreadRoot);
    // A CURSOR NARROWS THE WORK TO THE THREADS THAT MOVED. Slack reports each root's
    // newest reply, so a root whose latest reply predates the cursor holds nothing
    // this read can return, and expanding it spends a call to confirm that. On this
    // channel the cap was dropping 43 roots per sweep while almost none of them had
    // moved, so the reads that mattered were the ones being dropped.
    const since_ = since === undefined ? 0 : Number(since);
    const candidates =
      since_ > 0 ? roots.filter((m) => Number(m.latest_reply ?? m.ts ?? 0) > since_) : roots;
    const expandable = new Set(
      [...candidates]
        .sort((a, b) => Number(b.latest_reply ?? b.ts ?? 0) - Number(a.latest_reply ?? a.ts ?? 0))
        .slice(0, THREAD_EXPANSION_CAP)
        .map((m) => m.ts ?? ""),
    );
    // THE REPLY CALLS GO OUT TOGETHER. Each expandable root costs one
    // `conversations.replies` request, and awaiting them inside the walk made them
    // serial: an agent measured a read of one busy channel past 120 seconds, where
    // the channel's recent traffic lives inside threads and the roots are old. One
    // round trip for the whole set replaces up to 25 in a row, and the walk below
    // keeps Slack's newest-first order, since every reply it needs is already in a map.
    const fetched = new Map<string, SlackHistoryMessage[]>();
    // A BURST TRIPS SLACK'S LIMIT. Sending all 25 at once produced
    // `ratelimited` across four roots in one sweep on a busy channel, and a dropped
    // expansion means a thread reply somebody is waiting on never arrives. The pool
    // below keeps a few in flight and retries a rate-limited call after a pause,
    // which is what Slack's own answer asks for.
    const pending = [...expandable];
    const readRoot = async (rootTs: string): Promise<void> => {
      for (let attempt = 0; attempt < REPLY_RETRIES; attempt += 1) {
        const rep = await readOk<{ messages?: SlackHistoryMessage[] }>(
          this.fetch,
          // Request metadata here as well. Every other read passes
          // include_all_metadata and this one did not, so a message posted in a thread
          // returned without an origin and without a status marker, which left `peers`
          // unable to say which host wrote it.
          `${REPLIES_URL}?channel=${encodeURIComponent(slackChannel)}&${WITH_METADATA}` +
            `&ts=${encodeURIComponent(rootTs)}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        // A failed reply request keeps the top-level messages, reports the problem,
        // and leaves the rest of the read alone.
        if (rep.ok) {
          fetched.set(rootTs, rep.data.messages ?? []);
          return;
        }
        // A rate-limited call is worth asking again, and every other error is the
        // answer. The pause grows with the attempt.
        if (rep.error !== "ratelimited" || attempt === REPLY_RETRIES - 1) {
          problems.push(`thread replies failed for root ${rootTs}: ${rep.error ?? "slack call failed"}`);
          return;
        }
        await this.sleep(REPLY_RETRY_PAUSE_MS * (attempt + 1));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(REPLY_CONCURRENCY, pending.length) }, async () => {
        for (;;) {
          const next = pending.shift();
          if (next === undefined) return;
          await readRoot(next);
        }
      }),
    );
    let droppedRoots = 0;
    for (const m of r.data.messages ?? []) {
      seq = await this.appendLine(m, slackChannel, channel, messages, problems, seq, token, as ?? "", forDelivery);
      if (!isThreadRoot(m)) continue;
      // The system bounds fan-out by sending one extra `conversations.replies` request
      // per threaded root, capped at `THREAD_EXPANSION_CAP` on the roots with the
      // newest
      // replies. Unbounded expansion on a busy channel is unacceptable.
      if (!expandable.has(m.ts ?? "")) {
        // A root the cursor ruled out holds nothing newer, so its absence from this
        // read is no loss and says nothing to report.
        if (since_ > 0 && Number(m.latest_reply ?? m.ts ?? 0) <= since_) continue;
        droppedRoots += 1;
        continue;
      }
      const rootTs = m.ts ?? "";
      for (const reply of fetched.get(rootTs) ?? []) {
        // conversations.replies returns the root message as its first entry. The root
        // already appeared exactly once above with no `thread`, so drop it.
        if (reply.ts !== undefined && reply.ts === m.ts) continue;
        seq = await this.appendLine(reply, slackChannel, channel, messages, problems, seq, token, as ?? "", forDelivery);
      }
    }
    // The cursor applies here, after the threads are in. A caller keeps its cursor on
    // `ts`, so the comparison is numeric on the same field.
    const after = since === undefined ? 0 : Number(since);
    const kept = after > 0 ? messages.filter((m) => Number(m.ts ?? 0) > after) : messages;
    if (droppedRoots > 0) {
      // A dropped root must never look like an empty thread. The cap truncates the
      // read, so the system reports it through the same problems channel a partial read
      // already uses, naming how many roots went unexpanded.
      problems.push(
        `read capped: ${droppedRoots} threaded root(s) left unexpanded, chosen by newest reply. ` +
          `A reply in one of those threads is NOT in this read, so an absence here is not proof ` +
          `a message failed to post.`,
      );
    }
    return { code: 0, messages: kept, problems };
  }

  /**
   *  `next(channels, as, timeoutSecs, onProblem)` blocks for one message and then
   *  resolves with code 0. The call preserves exit code 64 semantics by timing out
   *  with nothing delivered and nothing printed. A connection that cannot be
   *  established (such as a refused `apps.connections.open`, for example
   *  `invalid_auth`) resolves with code 1, which means scramble could not look. Exit
   *  code 64 indicates a quiet channel after a look that worked.
   */
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
      // Because an agent with no token and no default has nothing to act on, the system
      // fails and names the agent and the key.
      onProblem(t.error);
      return { code: 1, error: t.error };
    }
    const token = t.token;
    // The client connects asynchronously. The promise returned to the caller settles
    // on the first matching delivery, the deadline, or a refused connection,
    // whichever comes first.
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
          // A refused connection means that scramble could not inspect the channel. The
          // caller must distinguish broken credentials from a quiet channel, so
          // scramble
          // returns code 1 to indicate that scramble could not inspect the channel.
          // Code 64
          // is reserved to indicate that the channel was quiet. Scramble reports a
          // message
          // naming the Slack error and the `appToken` configuration key.
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

  /**
   *  `listen(channels, as, onLine, onProblem)` processes the Socket Mode event
   *  stream, emitting one JSON line per message as the local backend produces it.
   *  When a connection that worked previously drops, it retains its backoff and
   *  reconnects. A connection that has never succeeded fails and returns 1, because
   *  retrying a refusal into silence lets a broken app token scroll past an
   *  unattended watch.
   *
   *  The healthy stream never resolves. The only terminating return is 1.
   */
  async listen(
    channels: string[],
    as: string,
    onLine: (d: Delivery) => void,
    onProblem: (p: string) => void,
  ): Promise<number> {
    const wantsAll = channels.length === 0;
    const t = this.agentToken(as);
    if (!t.ok) {
      // Because an agent with no token and no default has nothing to act on, the system
      // fails and names the agent and the key.
      onProblem(t.error);
      return 1;
    }
    const token = t.token;
    let everConnected = false;
    let backoff = RECONNECT_BACKOFF;
    for (;;) {
      const opened = await this.listenOnce(channels, wantsAll, as, token, onLine, onProblem);
      if (opened) everConnected = true;
      // The system could not establish the first connection because scramble could not
      // look, so the process fails here. Retrying the same refusal forever is the
      // alternative that hides the error. 64 is the quiet-channel code, and 1 means
      // "scramble could not look".
      if (!opened && !everConnected) return 1;
      // When an established connection drops, it is reconnected with backoff.
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_RECONNECT_BACKOFF);
    }
  }

  /**
   *  The client connects once, delivers events until the socket closes, and reports
   *  whether the `OPEN` established. The call returns `TRUE` when the connection
   *  came up, even if it later dropped, and returns `FALSE` when the open itself
   *  failed. A dropped connection keeps the loop alive with backoff.
   */
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
