export const meta = {
  name: 'scramble-status',
  description: 'Show an agent working, set automatically by delivery and cleared by the reply',
  phases: [{ title: 'status' }],
}

phase('status')
const out = await agent(`You are adding an AUTOMATIC working-status surface to "scramble",
the repo you are running in. Read src/slack-backend.ts, src/raft.ts, src/cli.ts,
src/types.ts and skills/scramble/SKILL.md first.

WHY: an agent that takes 40 seconds to answer looks dead in Slack, and Slack has a native
indicator for it. The scope is already granted: a probe of \`assistant.threads.setStatus\`
with this app's bot token returned \`invalid_thread_ts\` rather than \`missing_scope\`.

THE DESIGN RULE, from the operator: status is NOT an agent-invoked verb. An agent that has
to remember to set a status will forget, and a rule that depends on remembering is not a
mechanism. Status is set and cleared by scramble itself, from events scramble already
sees:

  delivery of a message to this agent  ->  status ON for that channel
  a post by this agent to that channel ->  status OFF
  no post within the TTL               ->  status OFF

So the whole lifecycle is bracketed by \`next\` / \`listen\` / \`message check\` on one side
and \`post\` / \`message send\` on the other. Do NOT add a \`scramble status\` verb, and do
not ask the agent to describe its work: the text is scramble's, short and fixed
("working"), because agent-authored progress prose is a message pretending to be a
status.

CONCURRENCY: other units are in flight. Do NOT touch src/slack.ts or src/raft.ts, both
of which another unit is deleting. Put the status logic in a NEW src/status.ts and keep
the hooks in src/cli.ts and src/slack-backend.ts minimal, so a concurrent merge rebases
cleanly.

DELIVER:

1. SET ON DELIVERY. When a verb delivers a message addressed to this agent, set the
   status for that channel before the line reaches stdout. A message that is NOT
   addressed to this agent sets nothing, since a channel where the agent will stay silent
   must not show it working.
2. CLEAR ON REPLY. When this agent posts to a channel with an active status, clear it as
   part of the same call.
3. TTL. Record each active status in \`.scramble/status.json\` as channel, agent, the
   Slack ts when a living message backs it, and an expiry. Default TTL 120 seconds,
   overridable by \`SCRAMBLE_STATUS_TTL\`. Every scramble invocation clears whatever has
   expired before doing its own work, and \`listen\`, being long-lived, clears on expiry
   while it runs. A status must never outlive the work it describes.
4. BACKENDS, network seams INJECTED so tests need no token:
   - Slack, preferring \`assistant.threads.setStatus\` with \`channel_id\` + \`thread_ts\`
     when the target is an assistant thread, and otherwise a LIVING MESSAGE: post once,
     remember the ts, \`chat.update\` it on change, delete it on clear, and replace its
     text when delete is refused. One living message per channel, never a second.
   - local: record it so a test can read it back.
5. OPT OUT with \`SCRAMBLE_STATUS=off\`, one switch, for an operator who wants silence.

RULES:
- Status is never a message: no \`seq\`, absent from \`history\`, never delivered to a
  listener. A status line waking a peer agent would turn progress into traffic.
- A failed status NEVER fails the work it brackets. Report on stderr, carry on, exit as
  the underlying verb would have.
- Setting a status twice for one channel updates rather than posting again.

Then: skills/scramble/SKILL.md gets a SHORT note saying status is automatic, that an
agent neither sets nor clears it, and that \`SCRAMBLE_STATUS=off\` disables it. Re-lint
with \`python3 skills/scramble/lint_language.py skills/scramble/SKILL.md\` until 0 hits.

TESTS, behavioral:
- a delivered message addressed to this agent sets the status, and one not addressed to
  it sets nothing;
- a post to that channel clears it, in the same call;
- a second status for one channel calls chat.update with the remembered ts, proven by
  asserting postMessage ran once;
- an expired entry is cleared by the next invocation, whatever verb that is;
- a Slack {"ok":false} answer is reported and the underlying verb still succeeds;
- SCRAMBLE_STATUS=off performs no status call at all;
- status appears in neither history nor a listener's output.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. The FULL gate must be
green: run \`bash scripts/gate.sh\` and paste its summary lines plus the coverage table.
GATE GREEN at 100% coverage is the definition of done.`)
return { out }
