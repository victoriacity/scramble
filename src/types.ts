// The seams every module shares. Hand-authored contract: modules are written in
// parallel against THIS file, so it is the one place a shape is declared.

/** One room message. `seq` is global across all rooms (one total order).
 *  `id` is the client-supplied dedup key; `mentions` is computed at append
 *  time so no reader parses text to learn who was addressed. */
export interface Message {
  seq: number;
  ts: string;
  room: string;
  from: string;
  text: string;
  id: string;
  mentions: string[];
}

/** A message as delivered to one subscriber: the record plus whether THIS
 *  subscriber was addressed (channel mention, or any message in a dm/ room). */
export interface Delivery extends Message {
  mentioned: boolean;
}

/** A joined participant. `persona` is the 2-4 sentence goal+lens text read
 *  from the workspace's .scramble/persona.md. */
export interface Agent {
  name: string;
  persona: string;
  rooms: string[];
}

/** Result of a post: the new seq plus the messages that landed in the same
 *  room between the sender's last-seen seq and this one (the crossings), so a
 *  sender learns what it raced with at the moment it speaks. */
export interface PostResult {
  seq: number;
  crossings: Message[];
}

/** What a post attempt carries. `lastSeen` drives crossings; `id` drives
 *  dedup of a retried post. */
export interface PostInput {
  room: string;
  from: string;
  text: string;
  id: string;
  lastSeen?: number;
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

/** A room is a DM iff its name starts with this prefix: `dm/<a>/<b>`. */
export const DM_PREFIX = "dm/";
