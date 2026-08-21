export const meta = {
  name: 'scramble-delete-bridge-and-raft',
  description: 'Delete the Slack bridge, the web page, and the raft backend',
  phases: [{ title: 'delete' }],
}

phase('delete')
const out = await agent(`You are DELETING code from "scramble", the repo you are running
in. The operator approved it. Read DESIGN.md's opening ("What scramble is"), src/slack.ts,
src/slack-backend.ts, src/slack-transport.ts, src/cli.ts, src/bin.ts and
docs/slack-setup.md first.

WHY: the Slack BRIDGE mirrors a local store into Slack, and the Slack BACKEND makes Slack
the store. Keeping both keeps the two-store reconciliation that produced both defects
found on 2026-08-21: an echo loop, because a Slack-origin message could be republished to
Slack, and a reconnect replay, because the local store held a cursor Slack knew nothing
about. Deleting the bridge removes that bug class rather than a bug.

This is a NET DELETION. Success is measured in lines removed with the gate still green,
so resist re-adding anything as a "compatibility shim".

DELETE:
0. THE RAFT BACKEND: \`src/raft.ts\`, \`test/raft.test.ts\`, the
   \`SCRAMBLE_BACKEND=raft\` arm of the backend switch, and every raft row in the
   backend tables of DESIGN.md, PLAN.md, README.md and the skill. Operator, 2026-08-21:
   raft and scramble are PARALLEL ALTERNATIVES, so a raft backend inside scramble is one
   product wrapping its competitor for no gain.
   KEEP the raft-mirrored GRAMMAR: \`message send\`, \`message check\`, \`message read\`,
   \`profile show/update\`, \`channel join\`, and \`--target\`. Those exist so an agent
   learns one command set across both tools, which survives the backend going. Keep
   PLAN.md's mapping table with a line saying the grammar came from raft and stays while
   the backend does not.
1. \`src/slack.ts\` (the bridge) and \`test/slack.test.ts\`.
2. \`web/index.html\` and \`test/web.test.ts\`. Slack and raft are the human surfaces, so
   the built-in page is dead weight; the daemon's \`GET /\` route goes with it.
3. In \`src/cli.ts\`: the \`slack\` verb (cmdSlack), the bridge single-instance lock
   (acquireBridgeLock, bridgeLockPath), the firehose reader (firehoseTip, feedFirehose),
   the channel discovery (discoverJoinedChannels), the inbound insert (postToChannel) and
   the \`createTransport\` seam on \`Io\` if nothing else uses it. Remove their tests.
4. In \`src/bin.ts\`: whatever existed only to wire the bridge.
5. Any \`ServerOptions\`/route left serving the page.

KEEP, and this is the part to get right:
- \`src/slack-backend.ts\` is the Slack path from here on.
- \`src/slack-transport.ts\` STAYS: the backend imports \`SlackSocket\` from it. It
  currently imports types from \`./slack\`, so MOVE the shared Slack types
  (\`SlackEvent\`, \`SlackPostOptions\`, and whatever else the transport and the backend
  need) into \`src/slack-transport.ts\` or \`src/types.ts\`, whichever leaves fewer
  imports. The bridge's \`SlackConfig\` fields the BACKEND uses (token, agents, channels,
  roster, botIds, filesDir if present) must survive; the bridge-only ones (dmMirrorChannel,
  postToChannel, dryRun as a bridge concept) go.
- The local store, the daemon and \`src/server.ts\` STAY as the offline backend and the
  test fixture. Do not delete them in this unit.
- Two backends remain when you are done: slack and local. Every verb must work under
  both, and the switch must report a clear error for an unknown backend name, naming the
  two that exist.
- Any thread or attachment work that landed in \`src/slack.ts\` must be PORTED to
  \`src/slack-backend.ts\` before the file goes, if the backend lacks it. Losing a feature
  to a deletion is a defect, so check both files for thread_ts handling and mention
  resolution and keep the better implementation.

THEN:
- \`docs/slack-setup.md\` describes the bridge. Rewrite it for the backend:
  \`SCRAMBLE_BACKEND=slack\` with the config at \`~/.config/scramble/slack.json\`, the app
  scopes and events, one app per agent as the identity model, and how to add a channel.
  Drop the bridge's own steps.
- \`skills/scramble/SKILL.md\` and \`README.md\`: remove any instruction to run a bridge.
  Re-lint both with \`python3 skills/scramble/lint_language.py\` until 0 hits.
- \`DESIGN.md\`: the opening already calls the bridge superseded. Update the body so no
  section instructs a reader to run it, and keep the record of WHY it existed.

REPORT: the net line count removed (source and tests separately), and the gate summary.
The FULL gate must be green: run \`bash scripts/gate.sh\` and paste its summary lines plus
the coverage table. GATE GREEN at 100% coverage, with the bridge gone and no feature lost,
is the definition of done.`)
return { out }
