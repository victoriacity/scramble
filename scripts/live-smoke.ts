#!/usr/bin/env bun
// The LIVE smoke: every stage runs the real CLI against the real Slack
// workspace. It exists because `bun test --coverage` was green at 296 tests and
// 100% coverage while four defects were live in the Slack path, each one
// visible in the first minute of hand-testing: a read that hid every agent's
// messages, a file upload Slack rejects, a `message check` that reported
// nothing without checking, and a working status that never cleared on reply.
// Coverage proves the tests ran the lines. Only this proves the product works.
//
//   bun scripts/live-smoke.ts                 # every stage
//   bun scripts/live-smoke.ts thread status   # named stages only
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
const slackId = cfg.channels[CHANNEL];
const names = Object.keys(cfg.agents).filter((n) => cfg.agents[n]?.token);
const [SELF, PEER] = names;
if (!slackId || SELF === undefined || PEER === undefined) {
  console.error(
    `live-smoke: need channel "${CHANNEL}" and two agents with tokens in ${CFG_PATH}; ` +
      `found channel=${slackId ?? "(none)"} agents=[${names.join(", ")}]`,
  );
  process.exit(2);
}
const TOKEN = cfg.agents[SELF]!.token!;
const stamp = process.env.SMOKE_STAMP ?? String(Math.floor(Date.now() / 1000));
const env = { ...process.env, SCRAMBLE_BACKEND: "slack" };

/** Run the CLI through its real entrypoint and hand back everything it said.
 *  Nothing is filtered: a stage that fails prints the whole of stdout and
 *  stderr, because the summary is what hid these defects in the first place. */
async function scramble(
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", "src/bin.ts", ...args], {
    env,
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
  check("attach/inSlack", withFile !== undefined, `a message carrying files in Slack: ${withFile !== undefined}`);
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

const STAGES: Record<string, () => Promise<void>> = {
  read: stageRead,
  thread: stageThread,
  attach: stageAttach,
  wake: stageWakeAndStatus,
  check: stageCheck,
};

const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const run = asked.length ? asked : Object.keys(STAGES);
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
console.log(`\n== live-smoke summary ==`);
if (failures.length === 0) {
  console.log(`ALL ${run.length} stage(s) PASSED against the real workspace`);
  process.exit(0);
}
console.log(`${failures.length} FAILURE(S):`);
for (const f of failures) console.log(`  ${f}`);
process.exit(1);
