export const meta = {
  name: 'scramble-private-channels',
  description: 'Support Slack private channels: manifest scopes/events, docs, and a routing test that proves it',
  phases: [{ title: 'private' }],
}

phase('private')
const out = await agent(`You are adding Slack PRIVATE CHANNEL support to "scramble", the
repo you are running in. Read docs/slack-manifest.yaml, docs/slack-setup.md,
src/slack.ts (especially handleEvent) and test/slack.test.ts first.

WHAT IS ALREADY TRUE (verify it yourself before changing anything): the bridge's
inbound routing keys on \`ev.type === "message"\` plus a channel-id lookup in
\`cfg.channels\`; it does NOT filter on the public-channel event type. So the
routing code already handles a private channel once Slack delivers the event.

THE GAP: Slack delivers private-channel messages only to an app holding the
private-channel scope and subscribed to the private-channel message event. The
manifest declares only the PUBLIC pair (\`channels:history\`,
\`message.channels\`), so a private channel is silent today, and the setup doc
never mentions private channels.

DELIVER:

1. docs/slack-manifest.yaml — add the private-channel scope and event alongside
   the public ones (the bot scope for private channel history, and the bot event
   for private channel messages). Keep the manifest valid YAML and keep the
   existing public + DM entries. Check the current scope/event names against
   Slack's own documentation rather than guessing: the manifest is what an
   operator pastes, so a wrong name costs them a debugging session. If a
   channel-membership read is needed to resolve a private channel by name,
   include that scope too and say why in a comment.

2. test/slack.test.ts — add a test that PROVES private-channel routing rather
   than asserting the code path exists: feed the bridge an inbound message event
   whose channel id is a private-channel id mapped in \`cfg.channels\`, and assert
   it lands in the mapped room via postToRoom; and publish a room message and
   assert it posts to that private channel id. Cover the outbound identity tiers
   for a private channel the same way the public tests do.

3. docs/slack-setup.md — a short "Private channels" subsection: the extra scope
   and event are already in the manifest (so a fresh install needs nothing
   extra), but an app installed BEFORE this change must be updated and
   REINSTALLED for the new scope to take effect. State that the bot must be
   invited to each private channel by a member (\`/invite @scramble\` from inside
   the channel), that a private channel appears in \`channels\` exactly like a
   public one (room name -> channel id), and how to get a private channel's id.
   Do not duplicate the key table; extend it if a new key is genuinely needed.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Do not weaken
the self-filter or the loop guards. Do not restate the CLI contract or the
conversational rules (single-source rule in DESIGN.md). The FULL gate must be
green: run \`bash scripts/gate.sh\` and paste its summary lines plus the coverage
table in your report. GATE GREEN at 100% coverage is the definition of done.`)
return { out }
