export const meta = {
  name: 'scramble-threads-v2',
  description: 'Thread context on every line, rebuilt against the files that exist now',
  phases: [{ title: 'threads' }],
}

phase('threads')
const out = await agent(`You are rebuilding a feature that was LOST, in "scramble", the repo
you are running in. Read src/types.ts, src/slack-backend.ts, src/cli.ts,
src/attachments.ts (for the shape of a recent optional field on a message) and
skills/scramble/SKILL.md first.

WHAT HAPPENED: a unit built thread support into src/slack.ts and src/raft.ts while a
concurrent unit deleted both files, so the merges kept the deletion and the feature is
gone from main. The dispatch-spec commits survive and the implementation does not
(postmortem: akrust `log/postmortems/2026-08-21-parallel-delete-cliffed-a-feature.md`).
Neither of those files exists now, so build against what does.

WHY THE FEATURE MATTERS: Slack sends \`thread_ts\` on a threaded message and scramble drops
it, so a reply inside a thread is indistinguishable from a new top-level message, and
every reply scramble sends lands in the channel rather than in the thread it answers. The
operator has asked for this three times. The field is in the data: a
conversations.history read shows \`thread_ts=1787291684.717739\` on an existing message.

DELIVER:

1. \`src/types.ts\`: \`Message\` gains an OPTIONAL \`thread?: string\`, the id of the thread's
   root message, set ONLY when the message is a REPLY inside a thread. So the presence of
   the field answers the question directly: a line with \`thread\` is a reply, a line
   without it is top-level. Follow how the attachments unit added its optional field, so
   the two look like one design rather than two.

2. INBOUND, in \`src/slack-backend.ts\`: when a Slack message event carries \`thread_ts\` AND
   that value differs from the message's own \`ts\`, set \`thread\`. A parent that merely HAS
   replies carries \`thread_ts == ts\` and must NOT be marked a reply.

3. OUTBOUND: \`scramble message send --target <channel> --thread <id>\` posts into that
   thread, passing \`thread_ts\` to chat.postMessage. The local backend records it on the
   message. Keep \`post\` working as the alias.

4. \`skills/scramble/SKILL.md\`: two sentences saying a line carrying \`thread\` is a reply,
   and that answering inside a thread means passing \`--thread\`. Re-lint with
   \`python3 skills/scramble/lint_language.py skills/scramble/SKILL.md\` until 0 hits.

TESTS, behavioral:
- an inbound reply (thread_ts != ts) carries \`thread\`; a parent (thread_ts == ts) does
  not; a plain message has no \`thread\` field at all;
- \`message send --thread\` reaches chat.postMessage with \`thread_ts\`;
- the local backend round-trips a threaded message through history.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Do not reintroduce
src/slack.ts or src/raft.ts, both deliberately deleted. Do not change the existing line
fields, only add the optional one. The FULL gate must be green: run \`bash scripts/gate.sh\`
and paste its summary lines plus the coverage table. GATE GREEN at 100% coverage is the
definition of done.`)
return { out }
