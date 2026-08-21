export const meta = {
  name: 'scramble-status',
  description: 'Show an agent working: Slack assistant status and a living progress message',
  phases: [{ title: 'status' }],
}

phase('status')
const out = await agent(`You are adding a WORKING-STATUS surface to "scramble", the repo
you are running in. Read src/slack-backend.ts, src/raft.ts, src/cli.ts, src/types.ts,
PLAN.md ("The raft-mirrored surface") and skills/scramble/SKILL.md first.

WHY: an agent that takes 40 seconds to answer looks dead in Slack. Slack has a native
indicator for this, and the app already holds the scope: a probe of
\`assistant.threads.setStatus\` with this app's bot token returned \`invalid_thread_ts\`
rather than \`missing_scope\`, so the token is accepted and only the fake thread id was
rejected. The capability is available and unused.

DELIVER \`scramble status\`, one verb with two shapes:

  scramble status --target <channel> "<text>"    # show what you are doing
  scramble status --target <channel> --clear     # stop showing it

Backend behavior, each with the network seam INJECTED so tests need no token:

1. SLACK, two mechanisms, in this order of preference:
   - \`assistant.threads.setStatus\` with \`channel_id\` and \`thread_ts\` when the target is
     an assistant thread. This is Slack's own indicator, and \`--clear\` sets an empty
     status. Slack answers 200 with {"ok":false,...} on failure, so treat that as a
     FAILURE carrying Slack's error text.
   - a LIVING MESSAGE when the target is an ordinary channel or DM, which is where most
     agents work: post once with \`chat.postMessage\`, remember the \`ts\`, and \`chat.update\`
     that same message on each later status. \`--clear\` deletes it with \`chat.delete\`, or
     replaces its text when delete is refused. Remember the ts per channel in
     \`.scramble/status.json\` so a later invocation updates rather than posting again,
     which is what keeps a channel from filling with progress lines.
2. RAFT: raft has an activity surface of its own and its docs admit it is unreliable for
   external agents, so map status to a NO-OP that reports on stderr what it would have
   shown. Do not invent a raft API.
3. LOCAL: record the status on the channel so a test can read it back.

RULES:
- Status is never a message. It must not appear in \`history\`, must not carry a \`seq\`,
  and must not reach a listener, because a status line waking a peer agent would turn
  progress into traffic.
- A failed status NEVER fails the work it describes: report it on stderr and exit 0, so
  a status outage cannot stop an agent from answering.
- The living message is one per channel, and \`--clear\` on a channel with none is a
  no-op that exits 0.

Then: skills/scramble/SKILL.md gains a short section saying to set a status before work
that will outlast a few seconds, to clear it when the answer goes out, and that status is
not a message. Re-lint with
\`python3 skills/scramble/lint_language.py skills/scramble/SKILL.md\` until 0 hits.

TESTS, behavioral:
- an assistant-thread target calls setStatus with the channel and thread, and --clear
  sends an empty status;
- an ordinary channel posts once then UPDATES the same ts on the second status, proven by
  asserting chat.update carries the remembered ts and that chat.postMessage ran once;
- --clear deletes the living message, and a refused delete falls back to replacing text;
- a Slack {"ok":false} answer is reported and the process still exits 0;
- status never appears in history and never reaches a listener;
- the raft backend reports the no-op without calling any raft command.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. The FULL gate must be
green: run \`bash scripts/gate.sh\` and paste its summary lines plus the coverage table.
GATE GREEN at 100% coverage is the definition of done.`)
return { out }
