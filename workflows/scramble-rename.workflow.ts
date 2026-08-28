export const meta = {
  name: 'scramble-room-to-channel',
  description: 'Rename the noun: a room becomes a channel, everywhere, in one change',
  phases: [{ title: 'rename' }],
}

phase('rename')
const out = await agent(`You are renaming scramble's central noun. Read PLAN.md's section
"Rename: a room becomes a channel" first: it is the authoritative table of what moves and
what stays. Then read DESIGN.md, src/types.ts, src/store.ts, src/server.ts, src/cli.ts,
src/slack.ts, src/slack-backend.ts, src/raft.ts and skills/scramble/SKILL.md.

WHY: "room" is scramble's own word for a thing Slack and raft both call a channel, and
the mirrored CLI addresses one with --target. A third word costs every reader a
translation.

SCALE: 591 occurrences of "room" across source, tests and docs. This is mechanical, and
it must be COMPLETE: a half-applied rename leaves two names for one thing, which is
worse than the old name. Nothing may keep working by accident, so change the wire and the
readers together.

DELIVER exactly the table in PLAN.md:
- the message line field \`room\` becomes \`channel\`;
- the HTTP surface becomes /channels/:channel, /channels/:channel/stream and GET
  /channels, with the agent stream path unchanged;
- \`RoomStore\` becomes \`ChannelStore\`, and every identifier carrying "room" (roomsFor,
  roomByChannel, PostInput.room, cmdPost's room argument, and so on) is renamed to its
  channel form;
- \`.scramble/rooms/\` on disk becomes \`.scramble/channels/\`;
- every "room" in DESIGN.md, PLAN.md, README.md, JOIN.md, skills/scramble/SKILL.md and
  the two hooks under .scramble/hooks/ becomes "channel", including the prose;
- \`dm/<a>/<b>\` names stay: a DM is a channel whose name begins \`dm/\`;
- the CLI keeps \`--target\`, matching raft, because a target may be a channel or a DM.

WATCH FOR:
- The Slack config already has a \`channels\` map. It keeps its name and its shape, and
  now reads channel NAME to Slack channel id. Do not rename it to something else and do
  not collide the two meanings in one identifier.
- The hooks parse the message line. Rename the field they read in the same change, and
  keep test/hooks.test.ts a positive control: bad input still blocks, good input still
  passes.
- Do not rename the word "channel" where it already means a SLACK channel id, since that
  would erase the distinction the config depends on.

AFTER the rename, re-lint the skill and the docs you touched:
\`python3 skills/scramble/lint_language.py skills/scramble/SKILL.md JOIN.md README.md\`
and fix every hit, including the ones that predate you.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. The FULL gate must be
green: run \`bash scripts/gate.sh\` and paste its summary lines plus the coverage table.
Grep the tree for a surviving "room" and report what remains and why. GATE GREEN at 100%
coverage, with no stray "room" in source or docs, is the definition of done.`)
return { out }
