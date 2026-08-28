// The seams every module shares are defined here. Modules are written in parallel
// against this hand-authored contract, and every shape is declared in one place.

/**
 *  This represents a single channel message. The `seq` field provides a single
 *  total order across all channels. Clients supply `id` as a deduplication key.
 *  The system computes `mentions` at append time, so readers do not parse text
 *  to determine who was addressed. The `files` field appears only when the
 *  message carries attachments; when a message has no files, the field is absent
 *  so existing line structures remain unchanged. For each entry, `path` points
 *  to a local file that a session can read, containing an attachment fetched onto
 *  disk after a user dropped it into Slack.
 */
export interface Attachment {
  /**
   *  The backend names the file id, which represents Slack's file id or a local
   *  ledger id.
   */
  id: string;
  /**
   *  The file retains its original name.
   */
  name: string;
  /**
   *  The field specifies the MIME type of the bytes.
   */
  mime: string;
  /**
   *  The output includes the byte size when the source reports one.
   */
  size?: number;
  /**
   *  The value provides the absolute path of a local copy a session can read. The
   *  value is absent when the fetch failed or the backend holds the file
   *  remote-only.
   */
  path?: string;
}

export interface Message {
  seq: number;
  ts: string;
  channel: string;
  from: string;
  text: string;
  /**
   *  This field stores Slack's own bytes for this message, and it appears only when
   *  they differ from `text`.
   *
   *  The system derives `text`, and the derivation changes. The derivation renders
   *  `<@U…>` as a name and undoes Slack's `&lt;`/`&gt;`/`&amp;`. The unescape
   *  component was added after listeners had already archived thousands of messages.
   *  Three agents then spent an hour reconciling three hashes of one message: Slack's
   *  bytes, an old build's rendering held in a wake file, and today's rendering.
   *  Slack loses messages (four of the five behind the calibration table are gone),
   *  so the wake file is the archive, and an archive holding only a derived form can
   *  no longer be checked once the deriving function moves.
   *
   *  When this field is omitted, `text` is already byte-exact, which applies to most
   *  messages.
   */
  raw?: string;
  id: string;
  mentions: string[];
  files?: Attachment[];
  /**
   *  The `thread` field appears only on a reply inside a thread, containing the id
   *  of the thread's root message. A line carrying `thread` is a reply, and a line
   *  without it is top-level. The field is absent when unset, like `files`, so the
   *  two optional fields read as one design.
   */
  thread?: string;
}

/**
 *  When a subscriber receives a message, the delivery includes the record and
 *  specifies whether that subscriber was addressed through a channel mention or
 *  any message in a dm/ channel.
 */
export interface Delivery extends Message {
  mentioned: boolean;
  /**
   *  Every line records who spoke: `agent` is another app, while `operator`,
   *  `teammate` and `human` are people. Slack's own `bot_id` decides whether the
   *  speaker is a human or an agent, so that distinction is never unknown, and
   *  Scramble clearly indicates whether the speaker is a human or an agent. The
   *  `operator` is the person who authorized this session, `teammate` is another
   *  person, and `human` is a person on a host whose config records no `humanUserId`
   *  to tell those two apart.
   *
   *  A single field stores the speaker type. A boolean `operator` would have needed
   *  a second flag the first time human-versus-agent mattered, and a `human` boolean
   *  beside this would record the same fact twice.
   */
  sender: "operator" | "teammate" | "human" | "agent";
  /**
   *  The sender records where it is running: its hostname, working directory, and
   *  scramble commit. The sender publishes this metadata on the message itself,
   *  so the field is a claim about its own process and the sender is the only party
   *  that can know it. The field is absent when the sender runs a build that does
   *  not stamp it.
   */
  origin?: { host: string; dir: string; commit?: string };
}

/**
 *  The participant has joined the workspace. The `persona` field holds the 2-4
 *  sentence goal and lens text read from the workspace's `.scramble/persona.md`.
 */
export interface Agent {
  name: string;
  persona: string;
  channels: string[];
}

/**
 *  A post returns the new sequence number and the messages that arrived in the
 *  same channel between the sender's last-seen sequence number and this one (the
 *  crossings), so a sender learns what it raced with at the moment it speaks.
 */
export interface PostResult {
  seq: number;
  crossings: Message[];
}

/**
 *  A post attempt carries these properties. The `lastSeen` field drives crossings,
 *  and the `id` field drives deduplication of a retried post. The optional `files`
 *  field attaches uploaded files so a sent message arrives carrying them.
 */
export interface PostInput {
  channel: string;
  from: string;
  text: string;
  id: string;
  lastSeen?: number;
  files?: Attachment[];
  /**
   *  This field contains the thread-root ID when this post is a reply inside a
   *  thread, and is absent for a top-level message. It mirrors Message.thread.
   */
  thread?: string;
}

/**
 *  Server configuration settings. Leaving `token` unset disables authentication
 *  checks, which is the default behavior on localhost.
 */
export interface ServerOptions {
  maxChars?: number;
  token?: string;
  ratePerMin?: number;
  repeatWindowMs?: number;
}

export const DEFAULTS = {
  maxChars: 1500,
  ratePerMin: 30,
  repeatWindowMs: 60_000,
  port: 7737,
} as const;

/**
 *  A channel is a direct message if and only if its name starts with the
 *  `dm/<a>/<b>` prefix.
 */
export const DM_PREFIX = "dm/";

