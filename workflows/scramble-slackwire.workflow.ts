export const meta = {
  name: 'scramble-slackwire',
  description: 'Wire the Slack bridge to a real Socket Mode transport and a scramble slack entrypoint',
  phases: [{ title: 'slackwire' }],
}

phase('slackwire')
const out = await agent(`You are finishing the Slack frontend in "scramble", the repo you
are running in. Read DESIGN.md ("Humans"), PLAN.md ("The CLI contract", "Coverage
rules"), src/slack.ts, src/cli.ts, src/bin.ts and docs/slack-manifest.yaml first.

THE GAP: src/slack.ts implements the bridge against an INJECTED SlackTransport and
is fully tested, but (a) no real transport implementation exists, and (b) nothing
wires it to an entrypoint — \`grep -rn slack src/bin.ts src/cli.ts\` returns nothing.
So an operator who installs the Slack app has no way to run the bridge.

DELIVER:

1. src/slack-transport.ts — the REAL SlackTransport (the interface already declared
   in src/slack.ts: \`connect(onEvent)\` and \`postMessage(opts)\`), with ZERO
   dependencies, using only bun built-ins:
     - Socket Mode: POST https://slack.com/api/apps.connections.open with the
       app-level token (xapp-, scope connections:write) to obtain the wss URL,
       open it with the built-in WebSocket, and ACK every envelope by sending back
       its envelope_id (Slack redelivers what you do not ack). Reconnect with
       capped backoff when the socket closes, and honor a \`disconnect\` frame.
     - postMessage: POST https://slack.com/api/chat.postMessage with the bot token,
       carrying username/icon_emoji for the persona tier when the bridge passes
       them. Slack answers 200 with {"ok":false,"error":...} on failure — treat
       that as a FAILURE and surface the error text; never let it read as success.
   Keep the network at the edges: take \`fetch\` and a WebSocket factory as
   INJECTED constructor arguments so tests use fakes and need no network. Every
   branch must be reachable by a test (100% coverage; see PLAN.md).

2. A \`scramble slack\` verb in src/cli.ts (add it to the CLI contract table in
   PLAN.md in the same change, since that table is authoritative): reads the
   bridge config from the workspace's .scramble/slack.json, builds the real
   transport, calls createBridge, subscribes to the daemon's firehose stream so
   every room message is published to Slack, and routes inbound Slack messages
   into rooms via the config's postToRoom seam. Flags: --url/--token like every
   other verb, plus --dry-run which prints the Slack calls it WOULD make instead
   of connecting. Process/network binding belongs in src/bin.ts per the coverage
   rules; main() must stay testable with injected io.

3. docs/slack-setup.md — the operator's step list, short and checkable: create the
   app from docs/slack-manifest.yaml, generate the app-level token
   (connections:write) and install for the bot token, invite the bot to the
   channel, write .scramble/slack.json (document EVERY key with a real example:
   channels room->channel-id map, agents name->{token?,icon?}, dmMirrorChannel,
   botIds), then \`scramble slack --dry-run\` to verify the config before going
   live. State the two identity tiers and that DMs to an individual agent need
   the real-bot-user tier (a persona is not a user entity, so Slack has nothing
   to open a DM with).

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies (no Slack SDK,
no ws package). Nothing in src/ names an agent vendor — Slack is a HUMAN frontend,
which is allowed; a harness vendor is not. Do not weaken the loop guards. The
FULL gate must be green: run \`bash scripts/gate.sh\` and paste its summary lines
plus the coverage table in your report. GATE GREEN at 100% coverage is done.`)
return { out }
