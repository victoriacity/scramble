// WHERE AN AGENT IS RUNNING, published by every message it sends.
//
// The operator, 2026-08-22: "Does each agent record its hostname and working
// directory on scramble and an agent may know its same directory peers?" It did
// not, and the absence cost two round trips in one afternoon: an agent
// introduced itself by typing its hostname and `C:\xingyu-agent` into a message
// by hand, and later a drive letter on somebody else's machine needed a human to
// ask a human.
//
// IT RIDES ON SLACK MESSAGE METADATA, which is the same channel a status line
// already uses to be recognised by every other agent. Nothing is parsed out of
// prose, no app manifest changes, and an app owned by a different login carries
// it as readily as one of ours, which is where reading a peer's manifest fails.
//
// The limit, and it is inherent: an agent learns a peer's location from a
// message that peer has SENT. A silent agent stays unknown until it speaks.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The metadata event_type marking a message as carrying its sender's origin. */
export const ORIGIN_METADATA_TYPE = "scramble_origin";

export interface Origin {
  /** The machine's hostname. */
  host: string;
  /** The working directory the agent runs in. */
  dir: string;
  /** The scramble commit it runs, when the install knows one. */
  commit?: string;
}

/** One peer, and where it was last seen running. */
export interface PeerRow extends Origin {
  agent: string;
  /** When this was recorded, ISO, so a stale row reads as stale. */
  at: string;
}

/** Build the origin for THIS process. `commit` is omitted when the running copy
 *  is a checkout with no installed sha: an absent field says nothing, and a
 *  made-up one says something false. */
export function originOf(host: string, dir: string, commit?: string): Origin {
  return { host, dir, ...(commit === undefined || commit === "" ? {} : { commit }) };
}

/** The metadata block to attach to an outbound message. */
export function originMetadata(o: Origin): { event_type: string; event_payload: Record<string, string> } {
  return {
    event_type: ORIGIN_METADATA_TYPE,
    event_payload: { host: o.host, dir: o.dir, ...(o.commit === undefined ? {} : { commit: o.commit }) },
  };
}

/** Read an origin off an inbound message's metadata, or undefined when it
 *  carries none.
 *
 *  DEFENSIVE ON PURPOSE: the payload is written by another agent, possibly on a
 *  build older or newer than this one, and a message whose metadata is malformed
 *  must still be delivered. Anything that is not two non-empty strings is no
 *  origin at all. */
export function readOrigin(metadata: unknown): Origin | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const m = metadata as { event_type?: unknown; event_payload?: unknown };
  if (m.event_type !== ORIGIN_METADATA_TYPE) return undefined;
  if (typeof m.event_payload !== "object" || m.event_payload === null) return undefined;
  const p = m.event_payload as { host?: unknown; dir?: unknown; commit?: unknown };
  if (typeof p.host !== "string" || p.host === "" || typeof p.dir !== "string" || p.dir === "") return undefined;
  return { host: p.host, dir: p.dir, ...(typeof p.commit === "string" && p.commit !== "" ? { commit: p.commit } : {}) };
}

export function peersPath(configPath: string): string {
  return join(dirname(configPath), "peers.jsonl");
}

/** Every peer row, oldest first, skipping anything unparseable: a half-written
 *  line from a killed process must not take the whole record down. */
export function readPeers(path: string): PeerRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: PeerRow[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as PeerRow;
      if (typeof row.agent === "string" && typeof row.host === "string" && typeof row.dir === "string") out.push(row);
    } catch {
      continue;
    }
  }
  return out;
}

/** Record where a peer was seen, when that is news.
 *
 *  APPENDED, and the newest row wins on read. An agent that moves host or
 *  directory has both facts on the record with their times, which is what makes
 *  "it used to run there" answerable. A repeat of what the newest row already
 *  says is not written, so a busy channel does not grow the file per message. */
export function recordPeer(path: string, agent: string, o: Origin, at: string): boolean {
  const rows = readPeers(path);
  const last = rows.filter((r) => r.agent === agent).at(-1);
  if (last !== undefined && last.host === o.host && last.dir === o.dir && last.commit === o.commit) return false;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ agent, ...o, at })}\n`);
  return true;
}

/** The newest row per agent. */
export function currentPeers(rows: PeerRow[]): PeerRow[] {
  const byAgent = new Map<string, PeerRow>();
  for (const r of rows) byAgent.set(r.agent, r);
  return [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

/** The line an agent reads. `sameDir` narrows to peers sharing a directory with
 *  this agent, which is the question the operator asked: who is working where I
 *  am working. */
export function peersReport(rows: PeerRow[], self: Origin | undefined, sameDir: boolean): string {
  const current = currentPeers(rows);
  const shown =
    sameDir && self !== undefined ? current.filter((r) => r.dir === self.dir && r.host === self.host) : current;
  if (shown.length === 0) {
    const scope = sameDir && self !== undefined ? ` running in ${self.dir} on ${self.host}` : "";
    return (
      `No peers${scope} have been seen yet.\n` +
      `A peer is learned from a message it SENT carrying its origin, so an agent that has ` +
      `said nothing since it started is unknown here, and so is one running a scramble too ` +
      `old to stamp it.`
    );
  }
  const lines = shown.map(
    (r) => `  ${r.agent}  ${r.host}  ${r.dir}${r.commit === undefined ? "" : `  (${r.commit})`}  seen ${r.at}`,
  );
  return `${shown.length} peer(s):\n${lines.join("\n")}`;
}
