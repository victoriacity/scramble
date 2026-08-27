// The seams every module shares. Hand-authored contract: modules are written in
// parallel against THIS file, so it is the one place a shape is declared.

/** One channel message. `seq` is global across all channels (one total order).
 *  `id` is the client-supplied dedup key; `mentions` is computed at append
 *  time so no reader parses text to learn who was addressed. `files` is present
 *  ONLY when the message carries attachments; when a message has no file, the
 *  field is ABSENT so every existing line shape is unchanged. Each entry's
 *  `path` is a local file a session can read (an attachment a human dropped in
 *  Slack, fetched onto disk). */
export interface Attachment {
  /** file id as the backend names it (Slack's file id, or a local ledger id). */
  id: string;
  /** the original file name. */
  name: string;
  /** the mime type of the bytes. */
  mime: string;
  /** byte size when the source reports one. */
  size?: number;
  /** absolute path of a LOCAL copy a session can read; absent when the fetch
   *  failed or the backend holds the file remote-only. */
  path?: string;
}

export interface Message {
  seq: number;
  ts: string;
  channel: string;
  from: string;
  text: string;
  id: string;
  mentions: string[];
  files?: Attachment[];
  /** present ONLY on a REPLY inside a thread: the id of the thread's root
   *  message. A line carrying `thread` is a reply; a line without
   *  it is top-level. Absent-when-unset like `files`, so the two optional
   *  fields read as one design. */
  thread?: string;
}

/** A message as delivered to a subscriber: the record plus whether THIS
 *  subscriber was addressed (channel mention, or any message in a dm/ channel). */
export interface Delivery extends Message {
  mentioned: boolean;
  /** WHO said it, on every line: `agent` is another app, and `operator`,
   * `teammate` and `human` are people. Slack's own `bot_id` decides the
   * human-versus-agent half, so that half is never unknown (operator: "Scramble
   * should very clearly indicating whether the speaker is a HUMAN or an
   * AGENT"). `operator` is the person who authorized this session, `teammate`
   * is another person, and `human` is a person on a host whose config records
   * no `humanUserId` to tell those two apart.
   *
   *  One field, never a flag per kind: a boolean `operator` would have
   *  needed a second flag the first time human-versus-agent mattered, and a
   *  `human` boolean beside this would be the same fact written twice. */
  sender: "operator" | "teammate" | "human" | "agent";
  /** WHERE the sender is running: hostname, working directory, scramble commit.
   *  Published by the sender on the message itself, so it is a claim about its
   *  own process and the only party that can know it. Absent when the sender
   *  runs a build that does not stamp it. */
  origin?: { host: string; dir: string; commit?: string };
}

/** A joined participant. `persona` is the 2-4 sentence goal+lens text read
 *  from the workspace's .scramble/persona.md. */
export interface Agent {
  name: string;
  persona: string;
  channels: string[];
}

/** Result of a post: the new seq plus the messages that arrived in the same
 *  channel between the sender's last-seen seq and this one (the crossings), so a
 *  sender learns what it raced with at the moment it speaks. */
export interface PostResult {
  seq: number;
  crossings: Message[];
}

/** What a post attempt carries. `lastSeen` drives crossings; `id` drives
 *  dedup of a retried post. `files` (optional) attaches uploaded files so a
 *  sent message arrives carrying them. */
export interface PostInput {
  channel: string;
  from: string;
  text: string;
  id: string;
  lastSeen?: number;
  files?: Attachment[];
  /** the thread-root id when this post is the reply inside a thread; absent for
   *  a top-level message. Mirrors Message.thread. */
  thread?: string;
}

/** Server knobs. `token` unset means no auth check (localhost default). */
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

/** A channel is a DM iff its name starts with this prefix: `dm/<a>/<b>`. */
export const DM_PREFIX = "dm/";
