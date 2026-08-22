#!/usr/bin/env bun
// The LIVE smoke: every stage runs the real CLI against the real Slack
// workspace. It exists because `bun test --coverage` was green at 296 tests and
// 100% coverage while four defects were live in the Slack path, each one
// visible in the first minute of hand-testing: a read that hid every agent's
// messages, a file upload Slack rejects, a `message check` that reported
// nothing without checking, and a working status that never cleared on reply.
// Coverage proves the tests ran the lines. Only this proves the product works.
//
//   bun scripts/live-smoke.ts                 # read, thread, attach, wake, check
//   bun scripts/live-smoke.ts thread inbound  # named stages only
//
// `inbound` is not in the default run: it checks whether an inbound file's bytes
// reach local disk, which this workspace refuses to serve to a bot token, so it
// would stand red forever and hide a real regression behind a known one.
//
// Requirements: ~/.config/scramble/slack.json (or SCRAMBLE_SLACK_CONFIG) with a
// `team` channel and TWO agents, so one agent can be the peer that the other
// reads, mentions and wakes on. It POSTS to that channel, which is the point:
// the messages a human sees are the evidence.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CFG_PATH =
  process.env.SCRAMBLE_SLACK_CONFIG ??
  join(process.env.HOME ?? ".", ".config", "scramble", "slack.json");
const CHANNEL = process.env.SMOKE_CHANNEL ?? "team";
const cfg = JSON.parse(readFileSync(CFG_PATH, "utf8")) as {
  channels: Record<string, string>;
  agents: Record<string, { token?: string }>;
};
const configuredId = cfg.channels[CHANNEL];
const names = Object.keys(cfg.agents).filter((n) => cfg.agents[n]?.token);
const [firstAgent, secondAgent] = names;
/** Exit with a reason. Declared `never` so the guard below narrows. */
function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}
if (!configuredId || firstAgent === undefined || secondAgent === undefined) {
  die(
    `live-smoke: need channel "${CHANNEL}" and two agents with tokens in ${CFG_PATH}; ` +
      `found channel=${configuredId ?? "(none)"} agents=[${names.join(", ")}]`,
  );
}
// BOUND AFTER THE GUARD, and typed, so they are `string` for the rest of the
// file. A narrowing at module scope does not reach inside a function declared
// later, since that function could be called from anywhere, so every stage below
// would otherwise be handling `string | undefined`.
const slackId: string = configuredId;
const SELF: string = firstAgent;
const PEER: string = secondAgent;
const TOKEN = cfg.agents[SELF]!.token!;
const stamp = process.env.SMOKE_STAMP ?? String(Math.floor(Date.now() / 1000));
const env = { ...process.env, SCRAMBLE_BACKEND: "slack" };

/** Run the CLI through its real entrypoint and hand back everything it said.
 *  Nothing is filtered: a stage that fails prints the whole of stdout and
 *  stderr, because the summary is what hid these defects in the first place. */
async function scramble(
  args: string[],
  stdin?: string,
  envOver?: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", "src/bin.ts", ...args], {
    env: envOver === undefined ? env : { ...env, ...envOver },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, out, err };
}

async function slack(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`https://slack.com/api/${method}?${q}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return (await r.json()) as Record<string, unknown>;
}

type Msg = { ts?: string; text?: string; bot_id?: string; thread_ts?: string; files?: unknown[] };
async function history(limit = 12): Promise<Msg[]> {
  const d = await slack("conversations.history", { channel: slackId, limit: String(limit) });
  return (d.messages as Msg[]) ?? [];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const failures: string[] = [];
function check(stage: string, ok: boolean, detail: string): boolean {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${stage}: ${detail}`);
  if (!ok) failures.push(`${stage}: ${detail}`);
  return ok;
}

/** A read must show what Slack holds: your own line, and a peer agent's. */
async function stageRead(): Promise<void> {
  const text = `smoke ${stamp} read-back`;
  const sent = await scramble(["message", "send", "--target", CHANNEL, "--as", SELF], text);
  if (!check("read/send", sent.code === 0, `exit ${sent.code} ${sent.err.trim()}`)) return;
  const peer = `smoke ${stamp} from the peer`;
  await scramble(["message", "send", "--target", CHANNEL, "--as", PEER], peer);
  await sleep(2000);
  const r = await scramble(["message", "read", "--target", CHANNEL, "--as", SELF]);
  check("read/own", r.out.includes(text), `own line present in read: ${r.out.includes(text)}`);
  check("read/peer", r.out.includes(peer), `peer agent's line present in read: ${r.out.includes(peer)}`);
}

/** A reply sent with --thread must land INSIDE the thread, and the line that
 *  comes back must carry `thread` naming the root. */
async function stageThread(): Promise<void> {
  const root = `smoke ${stamp} thread root`;
  const s = await scramble(["message", "send", "--target", CHANNEL, "--as", SELF], root);
  if (!check("thread/root", s.code === 0, `exit ${s.code} ${s.err.trim()}`)) return;
  await sleep(2000);
  const rootTs = (await history()).find((m) => m.text === root)?.ts;
  if (!check("thread/rootTs", rootTs !== undefined, `root ts ${rootTs ?? "(not found)"}`)) return;
  const rep = await scramble(
    ["message", "send", "--target", CHANNEL, "--as", PEER, "--thread", rootTs!],
    `smoke ${stamp} threaded reply`,
  );
  if (!check("thread/reply", rep.code === 0, `exit ${rep.code} ${rep.err.trim()}`)) return;
  await sleep(2000);
  const d = await slack("conversations.replies", { channel: slackId, ts: rootTs! });
  const msgs = (d.messages as Msg[]) ?? [];
  check("thread/inSlack", msgs.length >= 2, `${msgs.length} message(s) under the root in Slack`);
  const r = await scramble(["message", "read", "--target", CHANNEL, "--as", SELF]);
  const line = r.out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as { text?: string; thread?: string })
    .find((m) => m.text?.includes("threaded reply"));
  check("thread/onLine", line?.thread === rootTs, `read line carries thread=${line?.thread ?? "(absent)"}`);
}

/** An attachment must reach Slack as a file on the message. */
async function stageAttach(): Promise<void> {
  const path = `/tmp/scramble-smoke-${stamp}.txt`;
  await Bun.write(path, `scramble live smoke ${stamp}\n`);
  const s = await scramble(
    ["message", "send", "--target", CHANNEL, "--as", SELF, "--attach", path],
    `smoke ${stamp} with a file`,
  );
  if (!check("attach/send", s.code === 0, `exit ${s.code} ${s.out.trim()} ${s.err.trim()}`)) return;
  await sleep(3000);
  const withFile = (await history()).find((m) => (m.files?.length ?? 0) > 0);
  if (!check("attach/inSlack", withFile !== undefined, `a message carrying files in Slack: ${withFile !== undefined}`)) return;

  // READ IT BACK. A file can be carried on a message and be unopenable: a raw
  // PUT upload gets a 200 from Slack, stores a file that shares with nothing and
  // serves a sign-in page instead of bytes, and every surface short of this one
  // reports success. This stage asserted only that the file was LISTED, so it
  // passed through that defect for hours and I read the symptom as an org-wide
  // block on files. The round trip is the only thing that proves an attachment.
  const f = (withFile!.files as Array<{ id?: string }>)[0];
  const info = await slack("files.info", { file: String(f?.id) });
  const file = (info.file ?? {}) as { url_private_download?: string; shares?: unknown };
  const shared = file.shares !== undefined && Object.keys(file.shares as object).length > 0;
  check("attach/shared", shared, `Slack records a share for the file: ${shared}`);
  const back = await fetch(String(file.url_private_download), {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const bytes = new Uint8Array(await back.arrayBuffer());
  const sent = new Uint8Array(await Bun.file(path).arrayBuffer());
  const same = bytes.length === sent.length && bytes.every((b, i) => b === sent[i]);
  check(
    "attach/readBack",
    same,
    same
      ? `${bytes.length} bytes came back byte-for-byte`
      : `the file did NOT come back: ${back.status} ${back.headers.get("content-type") ?? "?"}, ` +
        `${bytes.length} bytes against ${sent.length} sent`,
  );
}

/** A peer's mention must wake the listener, resolved to a name, and the working
 *  status must turn on by itself and clear when the agent replies. */
async function stageWakeAndStatus(): Promise<void> {
  const wake = `/tmp/scramble-smoke-wake-${stamp}.jsonl`;
  await Bun.write(wake, "");
  const listener = Bun.spawn(["bun", "src/bin.ts", "listen", CHANNEL, "--as", SELF], {
    env,
    stdout: Bun.file(wake),
    stderr: "pipe",
  });
  try {
    await sleep(6000);
    await scramble(
      ["message", "send", "--target", CHANNEL, "--as", PEER],
      `smoke ${stamp} @${SELF} wake check`,
    );
    await sleep(6000);
    const lines = (await Bun.file(wake).text())
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { from?: string; mentioned?: boolean; text?: string });
    const woke = lines.find((l) => l.text?.includes(`smoke ${stamp}`));
    check("wake/delivered", woke !== undefined, `the peer's line reached the listener: ${woke !== undefined}`);
    check("wake/mentioned", woke?.mentioned === true, `mentioned=${String(woke?.mentioned)}`);
    check(
      "wake/sender",
      woke?.from !== undefined && !/^[UWB][A-Z0-9]{6,}$/.test(woke.from),
      `from=${woke?.from ?? "(none)"} resolved to a name rather than a raw id`,
    );
    // The LIVE path stamps `thread` from the Socket Mode event, which is a
    // different code path from the history read, so it gets its own check here.
    const root = (await history()).find((m) => m.text?.includes(`smoke ${stamp}`))?.ts;
    if (root !== undefined) {
      await scramble(
        ["message", "send", "--target", CHANNEL, "--as", PEER, "--thread", root],
        `smoke ${stamp} @${SELF} threaded wake`,
      );
      await sleep(6000);
      const threaded = (await Bun.file(wake).text())
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { text?: string; thread?: string })
        .find((l) => l.text?.includes("threaded wake"));
      check(
        "wake/threadStamped",
        threaded?.thread === root,
        `the delivered reply carries thread=${threaded?.thread ?? "(absent)"} for root ${root}`,
      );
    }
    const ledger = join(".scramble", "status.json");
    const active = JSON.parse((await Bun.file(ledger).text()) || '{"entries":[]}') as {
      entries: Array<{ channel: string; ts?: string }>;
    };
    const entry = active.entries.find((e) => e.channel === CHANNEL);
    check("status/set", entry !== undefined, `a status is active for ${CHANNEL} after delivery`);
    await scramble(["message", "send", "--target", CHANNEL, "--as", SELF], `smoke ${stamp} replying`);
    await sleep(4000);
    const after = JSON.parse((await Bun.file(ledger).text()) || '{"entries":[]}') as {
      entries: Array<{ channel: string }>;
    };
    check(
      "status/clearedOnReply",
      after.entries.find((e) => e.channel === CHANNEL) === undefined,
      `the reply cleared the status: ${after.entries.length} entry(ies) left`,
    );
    if (entry?.ts !== undefined) {
      const d = await slack("conversations.history", {
        channel: slackId,
        latest: entry.ts,
        inclusive: "true",
        limit: "1",
      });
      const still = ((d.messages as Msg[]) ?? []).some((m) => m.ts === entry.ts);
      check("status/livingGone", !still, `the living status message was removed from Slack: ${!still}`);
    }
  } finally {
    listener.kill();
  }
}

/** `message check` is the mirrored drain verb. Reporting nothing when a mention
 *  is waiting is the failure this stage exists for. */
async function stageCheck(): Promise<void> {
  await scramble(
    ["message", "send", "--target", CHANNEL, "--as", PEER],
    `smoke ${stamp} @${SELF} check drain`,
  );
  await sleep(2000);
  const r = await scramble(["message", "check", "--as", SELF]);
  check(
    "check/drains",
    r.out.includes(`smoke ${stamp}`),
    `message check returned the waiting mention: ${r.out.trim() || "(nothing)"}`,
  );
}

/** Inbound file BYTES, which this workspace refuses to serve to a bot token.
 *  Kept OUT of the default run so the default stays a regression detector
 *  rather than a permanent red, and kept here so the day the app's install
 *  changes, `bun scripts/live-smoke.ts inbound` answers whether it worked.
 *  Slack's three refusals, all recorded: a sign-in page when the auth header is
 *  dropped across the redirect, `Error serving file.` when it is kept, and a 404
 *  with the token in the query. */
async function stageInbound(): Promise<void> {
  const r = await scramble(["message", "read", "--target", CHANNEL, "--as", SELF]);
  const withFiles = r.out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as { files?: Array<{ id: string; path?: string }> })
    .filter((m) => (m.files?.length ?? 0) > 0);
  if (!check("inbound/present", withFiles.length > 0, `${withFiles.length} line(s) carry files`)) return;
  const downloaded = withFiles.flatMap((m) => m.files ?? []).filter((f) => f.path !== undefined);
  check(
    "inbound/downloaded",
    downloaded.length > 0,
    downloaded.length > 0
      ? `${downloaded.length} file(s) on disk, first at ${downloaded[0]!.path}`
      : `no file has a local path. What scramble reported: ${r.err.split("\n")[0] ?? "(nothing on stderr)"}`,
  );
}

/** RESOLVING A CHANNEL BY NAME when the config does not map it — the path an
 *  agent takes the moment it is invited somewhere new, and the one nothing
 *  covered. It ran through conversations.list without a team_id, which on an org
 *  install answers `missing_argument`; the code swallowed that and reported "no
 *  Slack channel for <name>", so a channel the operator had just added the agent
 *  to looked like a channel that did not exist. Then, given auth.test's team_id,
 *  Slack answered `team_access_not_granted`, because on an enterprise install
 *  that field is the E… ORG and only auth.teams.list names the workspace.
 *
 *  Run against a config whose `channels` map is EMPTY, so the map cannot answer
 *  and the lookup has to. No invite and no human needed: it is the same
 *  resolution, reached by removing the shortcut. */
async function stageResolve(): Promise<void> {
  // The channel's own Slack name, which is what an invited agent has and need
  // not equal the scramble alias the config maps: here `team` is an alias and
  // Slack calls the channel something else entirely.
  const info = await slack("conversations.info", { channel: slackId });
  const real = (info.channel as { name?: string } | undefined)?.name;
  if (!check("resolve/name", typeof real === "string" && real !== "", `Slack calls it #${real ?? "(unnamed)"}`)) return;
  const bare = `/tmp/scramble-smoke-nomap-${stamp}.json`;
  await Bun.write(bare, JSON.stringify({ ...cfg, channels: {} }));
  const r = await scramble(["message", "read", "--target", String(real), "--as", SELF], undefined, {
    SCRAMBLE_SLACK_CONFIG: bare,
  });
  const lines = r.out.split("\n").filter((l) => l.startsWith("{"));
  check(
    "resolve/byName",
    r.code === 0 && lines.length > 0,
    r.code === 0 && lines.length > 0
      ? `read #${real} by name with no mapping, ${lines.length} line(s)`
      : `exit ${r.code}, ${lines.length} line(s). What scramble said: ${r.err.trim() || "(nothing)"}`,
  );
}

/** THE ATTACHMENT PATH TAKING THE SAME ROUTE AS A PLAIN SEND. Both halves were
 *  broken and neither showed up here, because this smoke only ever attached to a
 *  MAPPED channel with no name in the text.
 *
 *  A peer agent measured both on a live channel (2026-08-22): `--attach` read the
 *  config's channel map itself, so a channel the agent is IN but the config does
 *  not name failed while a plain send to it worked; and the text rode as
 *  `initial_comment` with no mention conversion, so a message opening with the
 *  operator's name stored the name literally and notified nobody, on an answer he
 *  had asked for.
 *
 *  Run against a config whose `channels` map is EMPTY, so the upload has to
 *  resolve the name, with a mention in the text so the conversion has to happen. */
async function stageAttachUnmapped(): Promise<void> {
  const info = await slack("conversations.info", { channel: slackId });
  const real = (info.channel as { name?: string } | undefined)?.name;
  if (!check("attachUnmapped/name", typeof real === "string" && real !== "", `Slack calls it #${real ?? "(unnamed)"}`)) return;

  const bare = `/tmp/scramble-smoke-attach-nomap-${stamp}.json`;
  await Bun.write(bare, JSON.stringify({ ...cfg, channels: {} }));
  const path = `/tmp/scramble-smoke-attach-${stamp}.txt`;
  await Bun.write(path, `unmapped attach ${stamp}\n`);

  const r = await scramble(
    ["message", "send", "--target", String(real), "--as", SELF, "--attach", path],
    `smoke ${stamp} @${PEER} unmapped attach`,
    { SCRAMBLE_SLACK_CONFIG: bare },
  );
  if (!check("attachUnmapped/send", r.code === 0, `exit ${r.code} ${r.out.trim()} ${r.err.trim()}`)) return;

  await sleep(3000);
  const mine = (await history(8)).find((m) => (m.text ?? "").includes(`${stamp} `) && (m.files?.length ?? 0) > 0);
  if (!check("attachUnmapped/inSlack", mine !== undefined, `the message carrying the file is in Slack: ${mine !== undefined}`)) return;

  // THE MENTION AS SLACK STORED IT. A literal "@name" notifies nobody; the entity
  // form is what reaches the person. This is the half that cost the operator an
  // answer he had asked for.
  const raw = String(mine!.text ?? "");
  const converted = /<@U[A-Z0-9]+>/.test(raw);
  check(
    "attachUnmapped/mention",
    converted,
    converted ? `the mention is an entity: ${raw.slice(0, 60)}` : `the name stayed LITERAL, so it notified nobody: ${raw.slice(0, 60)}`,
  );
}

/** A SWEEP FROM NO CURSOR AT ALL, which is what a fresh agent has and what a
 *  cursor that moved leaves behind. Twice today a cursor changed location and the
 *  next sweep re-delivered whole channels: hundreds of lines into a channel of
 *  people, until the harness suppressed it for rate.
 *
 *  This asserts the shape rather than a count: a first sweep may legitimately
 *  return a lot, and the SECOND must return nothing, because the cursor it wrote
 *  has to be the one it reads back. */
async function stageFreshCursor(): Promise<void> {
  const dir = `/tmp/scramble-smoke-cursor-${stamp}`;
  await Bun.write(`${dir}/.scramble/keep`, "");
  const bare = `${dir}/config.json`;
  await Bun.write(bare, JSON.stringify(cfg));

  const first = await scramble(["message", "check", "--as", SELF], undefined, {
    SCRAMBLE_SLACK_CONFIG: bare,
  });
  if (!check("freshCursor/first", first.code === 0, `exit ${first.code} ${first.err.trim().split("\n")[0] ?? ""}`)) return;

  const second = await scramble(["message", "check", "--as", SELF], undefined, {
    SCRAMBLE_SLACK_CONFIG: bare,
  });
  const lines = second.out.split("\n").filter((l) => l.startsWith("{")).length;
  check(
    "freshCursor/settles",
    second.code === 0 && lines === 0,
    second.code === 0 && lines === 0
      ? "the second sweep returned nothing, so the cursor it wrote is the one it read"
      : `the second sweep returned ${lines} line(s), exit ${second.code}: the cursor did not survive its own write`,
  );
}

const STAGES: Record<string, () => Promise<void>> = {
  read: stageRead,
  resolve: stageResolve,
  attachUnmapped: stageAttachUnmapped,
  freshCursor: stageFreshCursor,
  thread: stageThread,
  attach: stageAttach,
  wake: stageWakeAndStatus,
  check: stageCheck,
  inbound: stageInbound,
};

/** The default run. `inbound` is excluded and must be asked for by name. */
const DEFAULT_STAGES = ["read", "resolve", "thread", "attach", "attachUnmapped", "freshCursor", "wake", "check"];

const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const run = asked.length ? asked : DEFAULT_STAGES;
console.log(`live-smoke: channel=${CHANNEL} self=${SELF} peer=${PEER} stamp=${stamp}`);
for (const name of run) {
  const fn = STAGES[name];
  if (fn === undefined) {
    console.error(`live-smoke: no stage "${name}" (have: ${Object.keys(STAGES).join(", ")})`);
    process.exit(2);
  }
  console.log(`\n== ${name} ==`);
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${String(e)}`);
  }
}
// WRITE THE RECORD, naming the commit it ran against. A claim that the Slack
// path works is checkable against this file instead of against memory: if the
// commit here is not HEAD, the claim is about code that no longer exists.
const head = await (async () => {
  const p = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  return out === "" ? "(unknown)" : out;
})();
await Bun.write(
  join(".scramble", "last-live-smoke.json"),
  `${JSON.stringify(
    {
      commit: head,
      at: new Date().toISOString(),
      channel: CHANNEL,
      self: SELF,
      peer: PEER,
      stages: run,
      failures,
      passed: failures.length === 0,
    },
    null,
    2,
  )}\n`,
);

console.log(`\n== live-smoke summary ==`);
console.log(`recorded in .scramble/last-live-smoke.json at commit ${head}`);
if (failures.length === 0) {
  console.log(`ALL ${run.length} stage(s) PASSED against the real workspace`);
  process.exit(0);
}
console.log(`${failures.length} FAILURE(S):`);
for (const f of failures) console.log(`  ${f}`);
process.exit(1);
