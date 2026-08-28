// WHERE AN AGENT IS RUNNING, published by every message it sends.
//
// The operator: "Does each agent record its hostname and working directory on
// scramble and an agent may know its same directory peers?" It did not, and the
// absence cost two round trips in one afternoon: an agent introduced itself by
// typing its hostname and `C:\xingyu-agent` into a message by hand, and later a
// drive letter on somebody else's machine needed a human to ask a human.
//
// IT RIDES ON SLACK MESSAGE METADATA, which is the same channel a status line
// already uses to be recognised by every other agent. Nothing is parsed out of
// prose, no app manifest changes, and an app owned by a different login carries
// it as readily as one of ours, which is where reading a peer's manifest fails.
//
// The limit, and it is inherent: an agent learns a peer's location from a
// message that peer has SENT. A silent agent stays unknown until it speaks.
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "./filelock";

/** The metadata event_type marking a message as carrying its sender's origin. */
export const ORIGIN_METADATA_TYPE = "scramble_origin";

/** WHAT RUNS AN AGENT, as its own runtime names it.
 *
 *  The operator: "Scramble should store the agent runtime, work dir and session
 *  ids for each agent in case of a system restart or crash." A host and a
 *  directory survive a crash on their own; the session an agent belonged to does
 *  not, and it is the field that says which conversation to resume and which
 *  transcript holds what the agent was doing. */
export interface Runtime {
  /** `claude-code`, `akari`, or whatever a runtime publishes for itself. */
  name: string;
  /** The runtime's own version, when it publishes one. */
  version?: string;
  /** The session this agent belongs to, in its runtime's own id space. */
  session?: string;
  /** The process id on the host that recorded it. */
  pid?: string;
}

export interface Origin {
  /** The machine's hostname. */
  host: string;
  /** The working directory the agent runs in. */
  dir: string;
  /** The scramble commit it runs, when the install knows one. */
  commit?: string;
  /** What runs the agent, absent when nothing in the environment says. */
  runtime?: Runtime;
  /** THE SENDER'S OWN NAME FOR ITSELF, which settles which id space this row
   *  belongs to.
   *
   *  A delivered line carries the Slack handle in `from`, and an agent's own row
   *  carries its scramble name. Those differ (`model-failure-research` is
   *  `model_failure_researc` on Slack), so one agent appeared twice in the peer
   *  list with the same host, directory and session on both rows. An agent
   *  publishes its own name, and the receiver records it under that. */
  agent?: string;
}

/** The runtime this process is running under, read from the environment.
 *
 *  NOTHING IS GUESSED. An environment naming no runtime yields undefined, since a
 *  made-up runtime or an invented session id would be read as fact by every peer
 *  and by whoever is restarting the fleet.
 *
 *  NO SECRET IS EVER RECORDED. `CLAUDE_CODE_MESSAGING_TOKEN` sits beside the
 *  variables read here, this record is world-readable on the host, and its fields
 *  ride out on a Slack message. Only identifiers go in. */
export function runtimeOf(env: (name: string) => string | undefined): Runtime | undefined {
  const value = (name: string): string | undefined => {
    const v = env(name);
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };
  // AN OVERRIDE FIRST, so a runtime this code has never heard of still publishes
  // itself without a change here.
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
    // `AI_AGENT` carries `claude-code_2-1-234_agent...`, so the version sits in
    // the second underscore field with dashes where the dots belong.
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

/** One peer, and where it was last seen running. */
export interface PeerRow extends Origin {
  agent: string;
  /** When this was recorded, ISO, so a stale row reads as stale. */
  at: string;
  /** The name the message arrived under, when it differs from the agent's own.
   *
   *  This is what retires the rows written before an agent published its name:
   *  a row keyed on a Slack handle is dropped from the current list once another
   *  row claims that handle. */
  handle?: string;
}

/** Build the origin for THIS process. `commit` is omitted when the running copy
 *  is a checkout with no installed sha: an absent field says nothing, and a
 *  made-up one says something false. */
export function originOf(host: string, dir: string, commit?: string, runtime?: Runtime, agent?: string): Origin {
  return {
    host,
    dir,
    ...(commit === undefined || commit === "" ? {} : { commit }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(agent === undefined || agent === "" ? {} : { agent }),
  };
}

/** The metadata block to attach to an outbound message.
 *
 *  Slack's payload holds strings, so the runtime rides as flat keys. */
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
    // A PAYLOAD WITH A SESSION AND NO RUNTIME NAME carries no runtime: the name
    // is what makes the session id readable, since two runtimes' ids look alike
    // and mean different things.
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

/** Whether two origins say the same thing, field by field in a fixed order.
 *
 *  A `JSON.stringify` of each side was tried and it compares KEY ORDER: a row
 *  read back from disk lists `agent` first and a fresh origin does not, so every
 *  origin looked new and the file grew a line per message. */
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

/** ONE FILE PER WRITER, so no two processes ever append to the same file.
 *
 *  Six agents shared `peers.jsonl` on one host. That host's filesystem stalled
 *  under an orphaned `du -shx` walking 1.3PB for 81 hours: writes returned EIO,
 *  eight processes sat in D-state, and the shared file ended up with a line no
 *  parser could read. A lock helps a healthy filesystem and degrades on that one,
 *  since `withFileLock` breaks a lock it cannot take within a second and writes
 *  anyway.
 *
 *  A writer that owns its file needs no agreement with anybody. A torn write can
 *  only damage the writer's own rows, and the reader merges every file it finds. */
export function peersDir(pathInRecordDir: string): string {
  return join(dirname(pathInRecordDir), "peers.d");
}

/** The file one agent writes. The name is sanitised because it becomes a path,
 *  and an agent name arrives from a config a person edits. */
export function peerFileFor(configPath: string, agent: string): string {
  const safe = agent.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "agent";
  return join(peersDir(configPath), `${safe}.jsonl`);
}

/** Every peer row, oldest first, skipping anything unparseable: a half-written
 *  line from a killed process must not take the whole record down. */
export function readPeers(path: string): PeerRow[] {
  return readPeerFile(path).rows;
}

/** THE WHOLE RECORD: the shared file every build wrote before this change, plus
 *  one file per writer. Rows come back oldest first across all of them, since the
 *  newest row per agent is what `currentPeers` keeps.
 *
 *  The shared file is still READ. It holds every row written up to this change,
 *  and rewriting a record of what was seen is never on the table. */
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
  // OLDEST FIRST ACROSS FILES. Each file is already in order, and a merge of two
  // files is not, so the newest-row-wins read would pick whichever file sorted
  // last. A row with no timestamp keeps its place.
  return { rows: rows.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")), damaged };
}

/** The rows AND the count of lines no parser could read, from ONE file.
 *
 *  A SKIPPED LINE IS A SIGNAL, and this dropped it. Six agents appended to one
 *  file on a shared filesystem, an agent reported a line nothing could parse, and
 *  the reader had been stepping over it in silence since it appeared: the surface
 *  said `here are the peers` and never `one line of the record is damaged`. */
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

/** Record where a peer was seen, when that is news.
 *
 *  APPENDED, and the newest row wins on read. An agent that moves host or
 *  directory has both facts on the record with their times, which is what makes
 *  "it used to run there" answerable. A repeat of what the newest row already
 *  says is not written, so a busy channel does not grow the file per message. */
export function recordPeer(path: string, writer: string, arrivedAs: string, o: Origin, at: string): boolean {
  // THE NAME THE AGENT PUBLISHES WINS. A delivered line names its sender by Slack
  // handle, and an agent's own row names itself by scramble name, so one agent
  // held two rows carrying the same host, directory and session under
  // `model_failure_researc` and `model-failure-research`. The agent it belongs to
  // is the authority on which it is; `arrivedAs` is the fallback for a message
  // from a build that publishes no name.
  const agent = o.agent === undefined || o.agent === "" ? arrivedAs : o.agent;
  const handle = agent === arrivedAs ? undefined : arrivedAs;
  // THIS AGENT'S OWN FILE, which nobody else writes. Six agents shared one file
  // on a host whose filesystem stalled: writes returned EIO, eight processes sat
  // in D-state, and the shared file ended with a line no parser could read. A
  // lock was the first fix and it degrades on exactly that filesystem, since
  // `withFileLock` breaks a lock it cannot take within a second and writes
  // anyway. A writer that owns its file needs no agreement with anybody.
  //
  // The lock stays for the processes of THIS agent, which are several: a
  // listener, a send, and a sweep on a timer all record the same row.
  // THE FILE IS NAMED FOR THE WRITER, and it held the SUBJECT's name first. Six
  // agents on one host each learn the same remote peer from its messages, so all
  // six appended to that peer's file: the shared writer I had just removed, back
  // under another name. An agent read the code and reported it before any line
  // tore. A writer owns one file and records whoever it learns about in it.
  const mine = peerFileFor(path, writer);
  return withFileLock(mine, () => {
    const rows = readOneFile(mine).rows;
    const last = rows.filter((r) => r.agent === agent).at(-1);
    // THE WHOLE ORIGIN DECIDES WHETHER THIS IS NEWS, runtime and session
    // included. A key of host, dir and commit alone kept the first session id an
    // agent ever published and dropped every later one, so a restart into a new
    // session left the record pointing at a session that had died.
    if (last !== undefined && sameOrigin(last, o) && last.handle === handle) return false;
    mkdirSync(dirname(mine), { recursive: true });
    appendFileSync(mine, `${JSON.stringify({ agent, ...o, ...(handle === undefined ? {} : { handle }), at })}\n`);
    return true;
  });
}

/** The newest row per agent, with the handle-keyed rows an agent has since
 *  claimed left out.
 *
 *  A row written before agents published their names is keyed on a Slack handle.
 *  Once the same agent writes a row naming that handle as its own, the old row is
 *  the same agent under its other id, and printing both says two agents run in
 *  one directory in one session. */
export function currentPeers(rows: PeerRow[]): PeerRow[] {
  const byAgent = new Map<string, PeerRow>();
  for (const r of rows) byAgent.set(r.agent, r);
  const claimed = new Set([...byAgent.values()].map((r) => r.handle).filter((h): h is string => h !== undefined));
  return [...byAgent.values()]
    .filter((r) => !claimed.has(r.agent))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

/** The line an agent reads. `sameDir` narrows to peers sharing a directory with
 *  this agent, which is the question the operator asked: who is working where I
 *  am working. */
/** Peers whose commit differs from the one installed HERE, newest sighting
 *  first.
 *
 * THE HOST THAT STOPS UPDATING SENDS NO SIGNAL. The staleness notice compares a
 * running listener against the commit installed on the same machine, so a
 * machine nobody installs on has nothing to disagree with and stays quiet. An
 * agent found that on a host five commits behind, where every listener matched
 * its install and no notice had ever fired.
 *
 *  A peer's own message carries the commit it ran, so a difference between that
 *  and this install is visible without git and without a network. WHICH SIDE IS
 *  OLDER IS LEFT OPEN: commit ids carry no order, and `git log` answers it in
 *  one command. */
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
  // A DAMAGED LINE IS NAMED, and it used to be stepped over in silence. Six
  // agents append to this file on a shared filesystem; one reported a line no
  // parser could read, and every reader had been skipping it without a word.
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
  // THE RUNTIME AND THE SESSION ARE WHAT A RESTART NEEDS. A host and a directory
  // say where to look; the session id says which conversation was interrupted,
  // and it is the field nobody can reconstruct after the process is gone.
  const lines = shown.map((r) => {
    const rt = r.runtime;
    const ran =
      rt === undefined
        ? ""
        : `  ${rt.name}${rt.version === undefined ? "" : ` ${rt.version}`}` +
          `${rt.session === undefined ? "" : ` session ${rt.session}`}${rt.pid === undefined ? "" : ` pid ${rt.pid}`}`;
    return `  ${r.agent}  ${r.host}  ${r.dir}${r.commit === undefined ? "" : `  (${r.commit})`}${ran}  seen ${r.at}`;
  });
  // WHAT TO TELL EACH OF THEM DEPENDS ON THEIR OWN COMMIT. I announced two
  // commits with "both changes touch src/cli.ts", which was the range I had
  // just written. An agent five commits back answered with their own range: 15
  // files, the delivery path included. A reader on that build who took my
  // sentence at face value would have skipped a restart their build needs.
  //
  // The commits above are the input to that sentence, so the reminder goes where
  // they are printed.
  const behind = [...new Set(shown.map((r) => r.commit).filter((c): c is string => c !== undefined))];
  const note =
    self?.commit === undefined || behind.every((c) => c === self.commit)
      ? ""
      : `\nBefore you tell any of them what changed, read the range from THEIR commit:\n` +
        `  git diff --stat <their commit>..${self.commit}\n` +
        `Your own last diff describes nobody's build except yours.`;
  return `${shown.length} peer(s):\n${lines.join("\n")}${note}${torn}`;
}
