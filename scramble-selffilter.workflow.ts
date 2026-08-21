export const meta = {
  name: 'scramble-selffilter',
  description: "A read must show a peer agent messages; only your own are suppressed",
  phases: [{ title: 'selffilter' }],
}

phase('selffilter')
const out = await agent(`You are fixing a defect in "scramble", the repo you are running in,
found by a live test against a real Slack workspace. Read src/slack-backend.ts,
src/server.ts, src/store.ts, src/cli.ts and src/types.ts first.

THE DEFECT, measured live. Two apps are installed in one Slack workspace and both post to
the same private channel. \`scramble message read --target team --as akari\` exits 0 and
prints 14 lines, and NOT ONE of them is from an app: every message an agent posted is
missing, including messages from the OTHER agent. A direct conversations.history read of
the same channel with the same token shows those messages present, carrying
\`bot_id=B0EXAMPLE003\` and \`user=U0EXAMPLE014\`. So a read reports success while hiding real
messages, and agent-to-agent conversation is invisible through scramble's own surface.

THE CAUSE, at src/slack-backend.ts:286 inside \`toDelivery\`:

    if (ev.bot_id !== undefined && this.botIds.includes(ev.bot_id)) return { delivery: undefined, ... }

Two things are wrong with it and both must be fixed.

1. IT IS KEYED TO THE WRONG IDENTITY. \`botIds\` is a flat config list of every app, so the
   filter drops EVERY agent's messages, not the reading agent's. The intent is "never
   deliver my own posts, so I do not answer myself". The identity that expresses is the
   reading agent, the \`as\` argument, not the set of all apps.

2. IT RUNS ON THE HISTORY PATH. \`history\` feeds conversations.history rows through this
   same \`toDelivery\` (see the call near src/slack-backend.ts:396), so a suppression meant
   for delivery also censors a transcript read. The local backend does not do this: the
   server excludes a name on the STREAM (\`/channels/:channel/stream?exclude=<name>\` in
   src/server.ts) and history returns every line. The Slack backend must match that
   split, so one mechanism means the same thing in both backends.

DELIVER:

1. \`toDelivery\` becomes a pure conversion with no self-suppression: given an event it
   returns the line.
2. SUPPRESSION MOVES TO THE DELIVERY PATHS ONLY (what \`next\`, \`listen\` and
   \`message check\` consume), and its test is the SAME one the local backend applies: the
   resolved sender name equals the consuming agent's name. Name-based, because
   \`resolveSender\` already resolves a bot's user id through the roster and users.info, so
   akari's own post resolves to \`akari\`, and because the local backend already filters by
   name. Do not invent a second identity notion.
3. \`history\` and \`message read\` return EVERY line: your own, a peer agent's, a human's.
4. \`botIds\`: after the change, find every remaining use. If nothing authoritative reads it,
   DELETE it from the config type, the loader, and any doc or example that sets it, rather
   than leaving a second hand-maintained copy of "who am I" beside the name comparison. If
   some other code genuinely needs it, say in your final report which line needs it and why
   a name cannot serve there.

TESTS, behavioral, each one failing before your change and passing after:
- a message from a DIFFERENT agent (an event with a bot_id and a user id resolving to
  another name) IS delivered, and when it mentions the reading agent, \`mentioned\` is true;
- a message from the reading agent's OWN identity is NOT delivered to that agent's
  listener;
- \`history\` includes both the reading agent's own message and a peer agent's;
- the existing thread, attachment and status behavior is unchanged: a reply still carries
  \`thread\`, a parent still does not.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Do not add a config knob
for this; the correct behavior is not optional. Do not touch src/slack.ts or src/raft.ts,
which do not exist and must not come back. The FULL gate must be green: run
\`bash scripts/gate.sh\` and paste its summary lines plus the coverage table. GATE GREEN at
100% coverage is the definition of done.`)
return { out }
