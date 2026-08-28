export const meta = {
  name: 'scramble-threads-and-mentions',
  description: 'Carry thread context on every line, reply into threads, and resolve unknown mention ids in the bridge',
  phases: [{ title: 'threads' }],
}

phase('threads')
const out = await agent(`You are closing two gaps in "scramble", the repo you are running
in. Read src/types.ts, src/slack.ts, src/slack-backend.ts, src/raft.ts, src/cli.ts and
skills/scramble/SKILL.md first.

GAP 1, THREADS. Slack sends \`thread_ts\` on a threaded message and scramble drops it, so
a reply inside a thread is indistinguishable from a new top-level message, and every
reply scramble sends lands in the channel rather than in the thread it answers. The
operator asked for this twice, and the field is already in the data: a
conversations.history read shows \`thread_ts=1787291684.717739\` on an existing message.

GAP 2, MENTIONS IN THE BRIDGE. src/slack-backend.ts already resolves an unknown Slack
user id through users.info and caches it. src/slack.ts does NOT: it maps \`<@U…>\` through
the static \`roster\` only, so an id missing from the config passes through as a raw id,
matches no agent name, and the message lands with \`mentions: []\`. That happened live:
an @mention of the akari bot was recorded as unmentioned because the bot's own id was
absent from the roster, and it failed silently, reading as an ordinary message.

DELIVER:

1. \`src/types.ts\`: \`Message\` gains an OPTIONAL \`thread?: string\`, the id of the
   thread's root message. Set it ONLY when the message is a REPLY inside a thread, so
   the presence of the field answers the question directly: a line with \`thread\` is a
   reply, a line without it is top-level. Name it \`thread\` rather than \`thread_ts\`,
   because raft addresses the same idea as \`#channel:threadId\`.

2. Inbound, in both src/slack.ts and src/slack-backend.ts: when the Slack event carries
   \`thread_ts\` AND that value differs from the message's own \`ts\`, set \`thread\` to it.
   A parent message that merely HAS replies carries \`thread_ts == ts\` and must NOT be
   marked a reply.

3. Outbound: \`scramble message send --target <channel> --thread <id>\` posts into that
   thread. In the Slack path pass \`thread_ts\`; in the raft path address
   \`#channel:threadId\`, which raft's target grammar already supports; in the local
   backend record it on the message. Keep \`post\` working as the alias.

4. src/slack.ts adopts the backend's mention resolution: the roster wins, then
   users.info (the app holds users:read), with the answers cached so a repeat unknown id
   never re-queries. Do not delete the roster: it stays the override. Inject the fetch
   seam so tests need no token and no network.

5. skills/scramble/SKILL.md: document that a line carrying \`thread\` is a reply, and that
   answering inside a thread means passing \`--thread\`. Keep it to a few sentences, and
   re-lint the skill with \`python3 skills/scramble/lint_language.py skills/scramble/SKILL.md\`
   until it reports 0 hits.

TESTS, each proving behavior rather than shape:
- an inbound reply (thread_ts != ts) carries \`thread\`; a parent (thread_ts == ts) does
  not; a plain message has no \`thread\` field;
- \`message send --thread\` reaches chat.postMessage with \`thread_ts\`, and the raft
  backend turns it into the \`#channel:threadId\` target;
- an unknown mention id resolves through users.info, lands as \`@name\`, and a second
  occurrence hits the cache rather than the network;
- a users.info failure REPORTS and leaves the raw id, never a silent drop.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Do not change the
existing line fields, only add the optional one. The FULL gate must be green: run
\`bash scripts/gate.sh\` and paste its summary lines plus the coverage table. GATE GREEN
at 100% coverage is the definition of done.`)
return { out }
