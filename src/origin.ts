// Every message an agent sends publishes the location where that agent is
// running.
//
// Each agent records its hostname and working directory on scramble so an agent
// may know its same-directory peers. The system previously lacked this record,
// and the absence cost two round trips in one afternoon: an agent introduced
// itself by typing its hostname and `C:\xingyu-agent` into a message by hand, and
// later a drive letter on another machine required a human to ask a human.
//
// This information travels in Slack message metadata, which is the channel a
// status line already uses to be recognized by every other agent. The receiver
// parses nothing out of prose, no app manifest changes, and an app owned by a
// different login carries the data as readily as one of our own apps, which is
// where reading a peer's manifest fails.
//
// An inherent limit remains: an agent learns a peer's location from a message
// that peer has sent. A silent agent stays unknown until it speaks.
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "./filelock";

/**
 *  The metadata `event_type` marks a message as carrying its sender's origin.
 */
export const ORIGIN_METADATA_TYPE = "scramble_origin";

/**
 *  WHAT RUNS AN AGENT, as its own runtime names it.
 *
 *  Scramble should store the agent runtime, working directory, and session ID for
 *  each agent in case of a system restart or crash. A host and a directory survive
 *  a crash on their own, but the session an agent belonged to does not. The session
 *  is the field that says which conversation to resume and which transcript holds
 *  what the agent was doing.
 */
export interface Runtime {
  /**
   *  A runtime publishes `claude-code`, `akari`, or whatever it publishes for
   *  itself.
   */
  name: string;
  /**
   *  The runtime reports its own version when it publishes one.
   */
  version?: string;
  /**
   *  The agent belongs to this session, identified in the runtime's own ID space.
   */
  session?: string;
  /**
   *  This value represents the process ID on the host that recorded it.
   */
  pid?: string;
}

export interface Origin {
  /**
   *  The field contains the machine's hostname.
   */
  host: string;
  /**
   *  The agent runs in this working directory.
   */
  dir: string;
  /**
   *  The install runs the scramble commit when it knows one.
   */
  commit?: string;
  /**
   *  The process that runs the agent is absent when nothing in the environment
   *  specifies it.
   */
  runtime?: Runtime;
  /**
   *  The sender provides its own name to determine which identifier space this row
   *  belongs to.
   *
   *  A delivered line carries the Slack handle in `from`, and an agent's own row
   *  carries its scramble name. Because these names differ (`model-failure-research`
   *  is `model_failure_researc` on Slack), one agent appeared twice in the peer list
   *  with the same host, directory, and session on both rows. An agent publishes its
   *  own name, and the receiver records the agent under that name.
   */
  agent?: string;
}

/**
 *  The process reads the runtime it is running under from the environment.
 *
 *  The system guesses nothing. An environment that names no runtime yields
 *  undefined, since every peer and whoever is restarting the fleet would read an
 *  invented runtime or an invented session id as fact.
 *
 *  The system never records a secret. `CLAUDE_CODE_MESSAGING_TOKEN` sits beside the
 *  variables read here, this record is world-readable on the host, and its fields
 *  travel in a Slack message. Only identifiers enter the record.
 */
export function runtimeOf(env: (name: string) => string | undefined): Runtime | undefined {
  const value = (name: string): string | undefined => {
    const v = env(name);
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };
  // Provide an override first, so a runtime this code does not recognize still
  // publishes itself without requiring changes here.
  const named = value("SCRAMBLE_RUNTIME");
  if (named !== undefined) {
    return {
      name: named,
      ...(value("SCRAMBLE_RUNTIME_VERSION") === undefined ? {} : { version: value("SCRAMBLE_RUNTIME_VERSION")! }),
      ...(value("SCRAMBLE_SESSION_ID") === undefined ? {} : { session: value("SCRAMBLE_SESSION_ID")! }),
      ...(value("SCRAMBLE_RUNTIME_PID") === undefined ? {} : { pid: value("SCRAMBLE_RUNTIME_PID")! }),
    };
  }
  const claudeSession = value("CLAUDE_CODE_SESSION_ID");
  if (claudeSession !== undefined || value("CLAUDECODE") !== undefined) {
    // The `AI_AGENT` value carries `claude-code_2-1-234_agent...`, so the second
    // underscore-delimited field contains the version with dashes where the dots
    // belong.
    const marker = value("AI_AGENT") ?? "";
    const field = marker.split("_")[1] ?? "";
    const version = /^[0-9]+(-[0-9]+)+$/.test(field) ? field.replace(/-/g, ".") : undefined;
    return {
      name: "claude-code",
      ...(version === undefined ? {} : { version }),
      ...(claudeSession === undefined ? {} : { session: claudeSession }),
      ...(value("CLAUDE_PID") === undefined ? {} : { pid: value("CLAUDE_PID")! }),
    };
  }
  const instance = value("AKARI_INSTANCE_ID");
  if (instance !== undefined || value("AKARI_LANE_ROOT") !== undefined) {
    return {
      name: "akari",
      ...(value("AKARI_BUILD_COMMIT") === undefined ? {} : { version: value("AKARI_BUILD_COMMIT")! }),
      ...(instance === undefined ? {} : { session: instance }),
    };
  }
  return undefined;
}

/**
 *  The entry lists one peer and where it was last seen running.
 */
export interface PeerRow extends Origin {
  agent: string;
  /**
   *  The record stores its timestamp in ISO format, so a stale row reads as stale.
   */
  at: string;
  /**
   *  The system records the name the message arrived under when it differs from the
   *  agent's own name.
   *
   *  This value retires rows written before an agent published its name. The system
   *  drops a row keyed on a Slack handle from the current list once another row
   *  claims that handle.
   */
  handle?: string;
}

/**
 *  The routine builds the origin for this process. The routine omits `commit` when
 *  the running copy is a checkout with no installed SHA, because an absent field
 *  states nothing and an invented value states something false.
 */
export function originOf(host: string, dir: string, commit?: string, runtime?: Runtime, agent?: string): Origin {
  return {
    host,
    dir,
    ...(commit === undefined || commit === "" ? {} : { commit }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(agent === undefined || agent === "" ? {} : { agent }),
  };
}

/**
 *  This metadata block attaches to an outbound message.
 *
 *  Slack payloads hold strings, so the runtime stores its metadata as flat keys.
 */
export function originMetadata(o: Origin): { event_type: string; event_payload: Record<string, string> } {
  const r = o.runtime;
  return {
    event_type: ORIGIN_METADATA_TYPE,
    event_payload: {
      host: o.host,
      dir: o.dir,
      ...(o.commit === undefined ? {} : { commit: o.commit }),
      ...(r === undefined ? {} : { runtime: r.name }),
      ...(r?.version === undefined ? {} : { runtime_version: r.version }),
      ...(r?.session === undefined ? {} : { session: r.session }),
      ...(r?.pid === undefined ? {} : { pid: r.pid }),
      ...(o.agent === undefined ? {} : { agent: o.agent }),
    },
  };
}

/**
 *  The function reads an origin from an inbound message's metadata, or returns
 *  undefined when the message carries none.
 *
 *  This check is intentionally defensive because another agent writes the payload,
 *  possibly on a build older or newer than this one, and the system must still
 *  deliver a message whose metadata is malformed. The parser treats any value
 *  that is not two non-empty strings as no origin.
 */
export function readOrigin(metadata: unknown): Origin | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const m = metadata as { event_type?: unknown; event_payload?: unknown };
  if (m.event_type !== ORIGIN_METADATA_TYPE) return undefined;
  if (typeof m.event_payload !== "object" || m.event_payload === null) return undefined;
  const p = m.event_payload as Record<string, unknown>;
  if (typeof p.host !== "string" || p.host === "" || typeof p.dir !== "string" || p.dir === "") return undefined;
  const str = (key: string): string | undefined => {
    const v = p[key];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const name = str("runtime");
  return {
    host: p.host,
    dir: p.dir,
    ...(str("commit") === undefined ? {} : { commit: str("commit")! }),
    ...(str("agent") === undefined ? {} : { agent: str("agent")! }),
    // A payload containing a session without a runtime name carries no runtime. The
    // runtime name makes the session id readable, since session ids from two runtimes
    // look alike and mean different things.
    ...(name === undefined
      ? {}
      : {
          runtime: {
            name,
            ...(str("runtime_version") === undefined ? {} : { version: str("runtime_version")! }),
            ...(str("session") === undefined ? {} : { session: str("session")! }),
            ...(str("pid") === undefined ? {} : { pid: str("pid")! }),
          },
        }),
  };
}

/**
 *  The check determines whether two origins contain matching values, field by
 *  field in a fixed order.
 *
 *  Serializing each side with `JSON.stringify` evaluates key order. A row read back
 *  from disk lists `agent` first and a fresh origin does not, so every origin
 *  looked new and the file grew a line per message.
 */
export function sameOrigin(a: Origin, b: Origin): boolean {
  const flat = (o: Origin): string =>
    [o.host, o.dir, o.commit ?? "", o.runtime?.name ?? "", o.runtime?.version ?? "", o.runtime?.session ?? "", o.runtime?.pid ?? ""].join(
      " ",
    );
  return flat(a) === flat(b);
}

export function peersPath(configPath: string): string {
  return join(dirname(configPath), "peers.jsonl");
}

/**
 *  Assign one file to each writer, so no two processes ever append to the same
 *  file.
 *
 *  Six agents shared `peers.jsonl` on one host. An orphaned `du -shx` walked 1.3PB
 *  for 81 hours on that host and stalled the filesystem. Writes returned `EIO`,
 *  eight processes sat in `D-state`, and the shared file ended up with a line that
 *  no parser could read. A lock helps a healthy filesystem and degrades on a
 *  stalled one, since `withFileLock` breaks a lock it cannot take within one
 *  second and writes anyway.
 *
 *  A writer that owns its file needs no coordination with other processes. A torn
 *  write can only damage that writer's own rows, and the reader merges every file it
 *  finds.
 */
export function peersDir(pathInRecordDir: string): string {
  return join(dirname(pathInRecordDir), "peers.d");
}

/**
 *  An agent writes this file. The system sanitises the name because it becomes a
 *  path, and an agent name arrives from a configuration that a person edits.
 */
export function peerFileFor(configPath: string, agent: string): string {
  const safe = agent.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "agent";
  return join(peersDir(configPath), `${safe}.jsonl`);
}

/**
 *  The process parses every peer row, oldest first, and skips unparseable entries,
 *  because a half-written line from a killed process must not take the whole
 *  record down.
 */
export function readPeers(path: string): PeerRow[] {
  return readPeerFile(path).rows;
}

/**
 *  The full record comprises the shared file that every build wrote before this
 *  change, plus one file per writer. The system returns rows oldest first across all
 *  of these files, since `currentPeers` keeps the newest row per agent.
 *
 *  The system still reads the shared file. It holds every row written up to this
 *  change, and the system never rewrites a record of what was seen.
 */
export function readPeerFile(path: string): { rows: PeerRow[]; damaged: number } {
  const shared = readOneFile(path);
  const rows = [...shared.rows];
  let damaged = shared.damaged;
  let names: string[] = [];
  try {
    names = readdirSync(peersDir(path)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    const one = readOneFile(join(peersDir(path), name));
    rows.push(...one.rows);
    damaged += one.damaged;
  }
  // Read records oldest first across files. Each file is already ordered, but a
  // merge of two files loses this ordering, so a newest-row-wins read would pick
  // whichever file sorted last. A row with no timestamp keeps its place.
  return { rows: rows.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")), damaged };
}

/**
 *  The output returns the parsed rows and the count of lines that no parser could
 *  read from a single file.
 *
 *  A skipped line is a signal that the system dropped. Six agents appended to one
 *  file on a shared filesystem, and an agent reported a line that no parser could
 *  read. The reader had stepped over that line in silence since it appeared. The
 *  interface reported `here are the peers` and did not report
 *  `one line of the record is damaged`.
 */
export function readOneFile(path: string): { rows: PeerRow[]; damaged: number } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { rows: [], damaged: 0 };
  }
  const rows: PeerRow[] = [];
  let damaged = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as PeerRow;
      if (typeof row.agent === "string" && typeof row.host === "string" && typeof row.dir === "string") rows.push(row);
      else damaged += 1;
    } catch {
      damaged += 1;
    }
  }
  return { rows, damaged };
}

/**
 *  The system records where a peer was seen whenever that information is new.
 *
 *  The file appends entries, and reads resolve to the newest row. An agent that
 *  moves host or directory keeps both facts on record with their times, which makes
 *  "it used to run there" answerable. The system does not write a duplicate of
 *  what the newest row already says, so a busy channel does not grow the file per
 *  message.
 */
export function recordPeer(path: string, writer: string, arrivedAs: string, o: Origin, at: string): boolean {
  // The name an agent publishes takes precedence. A delivered line names its sender
  // by Slack handle, and an agent's own row names itself by scramble name, so one
  // agent held two rows carrying the same host, directory, and session under
  // `model_failure_researc` and `model-failure-research`. The agent is the authority
  // on its own identity, and `arrivedAs` serves as the fallback for a message from a
  // build that publishes no name.
  const agent = o.agent === undefined || o.agent === "" ? arrivedAs : o.agent;
  const handle = agent === arrivedAs ? undefined : arrivedAs;
  // Each agent writes exclusively to its own file, with no shared writes across
  // agents. Six agents previously shared one file on a host whose filesystem
  // stalled, where writes returned EIO, eight processes sat in D-state, and the
  // shared file ended with a line no parser could read. A lock was the first fix,
  // but it degrades on that filesystem because `withFileLock` breaks a lock it
  // cannot take within a second and writes anyway. A writer that owns its file
  // needs no agreement with any other writer.
  //
  // The lock remains for the internal processes of this agent, since a listener,
  // a send process, and a timer sweep all record the same row. The file is named
  // for the writer. It previously held the subject's name, so when six agents on
  // one host each learned about the same remote peer from its messages, all six
  // appended to that peer's file, returning the shared writer under another name.
  // An agent read the code and reported the defect before any line tore. A writer
  // owns one file and records whoever it learns about in it.
  const mine = peerFileFor(path, writer);
  return withFileLock(mine, () => {
    const rows = readOneFile(mine).rows;
    const last = rows.filter((r) => r.agent === agent).at(-1);
    // The full origin determines whether an update is new, and that origin includes
    // both the runtime and the session. A key composed of only the host, directory,
    // and commit retained the first session identifier that an agent published and
    // dropped every subsequent identifier, so a restart into a new session left the
    // record pointing at a session that had died.
    if (last !== undefined && sameOrigin(last, o) && last.handle === handle) return false;
    mkdirSync(dirname(mine), { recursive: true });
    appendFileSync(mine, `${JSON.stringify({ agent, ...o, ...(handle === undefined ? {} : { handle }), at })}\n`);
    return true;
  });
}

/**
 *  The output keeps the newest row for each agent and leaves out handle-keyed
 *  rows that an agent has since claimed.
 *
 *  A row written before agents published their names is keyed on a Slack handle.
 *  Once the same agent writes a row that names that handle as its own, the old row
 *  represents the same agent under another identifier, and printing both rows
 *  indicates that two agents run in one directory in one session.
 */
export function currentPeers(rows: PeerRow[]): PeerRow[] {
  const byAgent = new Map<string, PeerRow>();
  for (const r of rows) byAgent.set(r.agent, r);
  const claimed = new Set([...byAgent.values()].map((r) => r.handle).filter((h): h is string => h !== undefined));
  return [...byAgent.values()]
    .filter((r) => !claimed.has(r.agent))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

/**
 *  An agent reads this line. The `sameDir` filter narrows the list to peers that
 *  share a directory with this agent, which answers the operator's question about
 *  who is working in the same directory.
 */
/**
 *  This view lists peers whose commit differs from the commit installed locally,
 *  ordered by the newest sighting first.
 *
 *  A host that stops updating sends no signal. The staleness notice compares a
 *  running listener against the commit installed on that same machine, so a machine
 *  where nobody installs updates has nothing to disagree with and stays quiet. An
 *  agent observed this on a host five commits behind, where every listener matched
 *  its install and no notice had ever fired.
 *
 *  A peer's message carries the commit it ran, so a difference between that commit
 *  and the local install is visible without git and without a network. The system
 *  leaves open which side is older, because commit ids carry no order and `git log`
 *  answers the question in one command.
 */
export function peersOnOtherCommits(
  rows: PeerRow[],
  installed: string | undefined,
  self: Origin | undefined,
): PeerRow[] {
  if (installed === undefined || installed === "") return [];
  return currentPeers(rows)
    .filter((r) => r.commit !== undefined && r.commit !== installed)
    .filter((r) => !(self !== undefined && r.host === self.host && r.dir === self.dir))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function peersReport(rows: PeerRow[], self: Origin | undefined, sameDir: boolean, damaged = 0): string {
  // The reader names a damaged line that it previously stepped over in silence.
  // Six agents append to this file on a shared filesystem. One agent reported
  // a line that no parser could read, and every reader had been skipping it
  // without a word.
  const torn =
    damaged === 0
      ? ""
      : `\n${damaged} line(s) in the record could not be parsed and were skipped. Two processes ` +
        `appending at once on a shared filesystem tear a line; the rows above are what survived.`;
  const current = currentPeers(rows);
  const shown =
    sameDir && self !== undefined ? current.filter((r) => r.dir === self.dir && r.host === self.host) : current;
  if (shown.length === 0) {
    const scope = sameDir && self !== undefined ? ` running in ${self.dir} on ${self.host}` : "";
    return (
      `No peers${scope} have been seen yet.\n` +
      `A peer is learned from a message it SENT carrying its origin, so an agent that has ` +
      `said nothing since it started is unknown here, and so is one running a scramble too ` +
      `old to stamp it.${torn}`
    );
  }
  // A restart requires the runtime and the session. A host and a directory identify
  // where to look. The session id specifies which conversation was interrupted, and
  // nobody can reconstruct this field after the process is gone.
  const lines = shown.map((r) => {
    const rt = r.runtime;
    const ran =
      rt === undefined
        ? ""
        : `  ${rt.name}${rt.version === undefined ? "" : ` ${rt.version}`}` +
          `${rt.session === undefined ? "" : ` session ${rt.session}`}${rt.pid === undefined ? "" : ` pid ${rt.pid}`}`;
    return `  ${r.agent}  ${r.host}  ${r.dir}${r.commit === undefined ? "" : `  (${r.commit})`}${ran}  seen ${r.at}`;
  });
  // The message sent to each recipient depends on that recipient's own commit. An
  // announcement for two commits stated that both changes touch `src/cli.ts`, which
  // covered the range written in that update. An agent five commits back replied
  // with its own range of 15 files, including the delivery path. A reader on that
  // build who took that statement at face value would have skipped a restart their
  // build needs.
  //
  // The commits above provide the input to that statement, so the reminder goes
  // where they are printed.
  const behind = [...new Set(shown.map((r) => r.commit).filter((c): c is string => c !== undefined))];
  const note =
    self?.commit === undefined || behind.every((c) => c === self.commit)
      ? ""
      : `\nBefore you tell any of them what changed, read the range from THEIR commit:\n` +
        `  git diff --stat <their commit>..${self.commit}\n` +
        `Your own last diff describes nobody's build except yours.`;
  return `${shown.length} peer(s):\n${lines.join("\n")}${note}${torn}`;
}

