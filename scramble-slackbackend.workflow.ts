export const meta = {
  name: 'scramble-slack-backend',
  description: 'Slack as a third backend behind the same four verbs, so Slack IS the store',
  phases: [{ title: 'backend' }],
}

phase('backend')
const out = await agent(`You are adding SLACK AS A BACKEND to "scramble", the repo you are
running in. Read DESIGN.md, PLAN.md ("The CLI contract", "Coverage rules"),
src/cli.ts, src/raft.ts (the pattern to copy) and src/slack.ts + src/slack-transport.ts
(existing Slack code you may reuse) first.

THE DIRECTION (operator): stop mirroring Slack into a local store and let
SLACK BE THE SOURCE OF TRUTH. Slack becomes a third backend behind the SAME verbs, the
way src/raft.ts already is. The bridge shape (two stores reconciled by a relay) produced
both defects found today: an echo loop, because a Slack-origin message could be
republished to Slack, and a replay, because the room had a cursor Slack knew nothing
about. One store makes both impossible.

DELIVER src/slack-backend.ts implementing the same four verbs as the raft backend,
with EVERY network seam INJECTED (a fetch function and a socket factory) so tests need
no Slack token, no network and no socket:

- post(room, text, as): chat.postMessage to the channel the room maps to, with the
  agent's own bot token from the config's agents map when it has one, else the config
  token. Slack answers 200 with {"ok":false,"error":...} on failure: treat that as a
  FAILURE carrying Slack's error text, never as success.
- history(room, since): conversations.history mapped into scramble's line shape.
- listen(rooms, as): the Socket Mode event stream, printing one JSON line per message
  in the SAME shape the local backend emits.
- next(rooms, as, timeoutSecs): blocks for ONE message then exits 0; exits 64 on
  timeout with nothing printed.

The line shape must match the local backend exactly, because the join skill and the
hooks read it: room, from, text, mentions, and a \`mentioned\` flag for this agent.
Slack has no global seq, so use the message \`ts\` as the cursor and say so in a comment;
a per-channel cursor is the honest mapping.

Mentions: normalize \`<@U…>\` to \`@name\` through the config roster, then compute
\`mentioned\` for this agent from the normalized text plus its own name. An id absent
from the roster resolves through users.info (the app holds users:read) rather than
passing through as a raw id, since a raw id matches no agent name and the message
lands silently unmentioned. Cache what users.info returns.

Self-filter: never deliver a message whose bot_id is one of the config's botIds, which
is what keeps an agent from answering itself.

Wire it behind the existing verbs, selected by SCRAMBLE_BACKEND=slack (the env switch
src/cli.ts already has for raft) so post, next, listen and history behave identically
from the agent's point of view under local, raft, or slack.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies (no Slack SDK; the
existing src/slack-transport.ts already speaks Socket Mode with bun's WebSocket and can
be reused). Do NOT delete the local store, the daemon, or the bridge in this unit: this
adds a backend, and removing the bridge is a separate decision. The FULL gate must be
green: run \`bash scripts/gate.sh\` and paste its summary lines plus the coverage table.
GATE GREEN at 100% coverage is the definition of done.`)
return { out }
