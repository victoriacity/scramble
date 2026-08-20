export const meta = {
  name: 'scramble-slack',
  description: 'The Slack frontend: identity tiers, DMs, mention normalization, DM mirror',
  phases: [{ title: 'slack' }],
}

const COMMON = `
You are implementing part of "scramble" in the repo you are running in.

READ FIRST (they are the contract, do not re-derive them):
- DESIGN.md — what scramble is and every behavioral rule.
- src/types.ts — the shared shapes. Import from it; do not redeclare them.
- PLAN.md — the unit list, so you know which files are someone else's.

HARD INVARIANTS:
- TypeScript on bun, strict mode, ZERO runtime dependencies. Use only bun
  built-ins (Bun.serve, Bun.file, node:fs, node:path). No express, no zod.
- Write the LEAST code that satisfies the contract. Fewer lines and fewer
  branches is the goal, not more features. No feature not in DESIGN.md.
- 100% test coverage of the file(s) you write, enforced by bunfig.toml
  (line/function/statement all 1.0). Every branch you write needs a test that
  reaches it. If a branch is untestable, delete it — that is the point.
- Testability shape: keep IO at the edges and inject it. Pure functions and a
  request handler you can call directly beat anything needing a live socket or
  a real network.
- Other workers are writing OTHER files in this SAME directory right now.
  Touch ONLY your deliverables. Do not edit src/types.ts, DESIGN.md, PLAN.md,
  bunfig.toml, tsconfig.json, package.json, or another unit's file.
- Verify with your OWN test file only, e.g. \`bun test test/<yours>.test.ts\`.
  Do NOT run the whole suite or the gate: other files are mid-write and their
  failures are not yours.
- Never mask a failure: no empty catch, no fallback that hides an error. A
  guard that rejects reports what it saw.

Report at the end: the files you wrote, your test count, and the coverage
numbers your own test run printed.
`


phase('slack')
const out = await agent(`${COMMON}
YOUR UNIT: src/slack.ts + test/slack.test.ts — the Slack frontend.

Deliver \`createBridge(cfg, transport)\` where transport is the INJECTED Slack
seam (postMessage, connect/onEvent) — tests pass a fake, so no Slack account
and no network. Never import a Slack SDK.

Behavior (DESIGN.md "Humans" and contract rule 7):
- Room <-> channel map from cfg. Slack message -> POST to the room as the
  human's name; room message -> Slack.
- Two identity tiers per agent: a per-agent bot token posts as a real bot
  user; without one, post through the single app with the agent's display
  name and icon (the customize path). Choose per agent, tested both ways.
- Inbound normalization: <@U…> mention -> @name using the roster, so the room
  text carries one mention form. Self-filter the bridge's own bot ids so a
  posted message never loops back in.
- DMs: a Slack DM maps to room dm/<agent>/<slack-user>, created on first
  message; replies go back through that agent's identity.
- Agent<->agent DM rooms are mirrored READ-ONLY into cfg.dmMirrorChannel
  (default "#scramble-dms") with a "[a<->b]" prefix, from the firehose stream.
- A dry-run mode returns the API calls it WOULD make instead of calling.
Also emit the Slack app manifest this needs as docs/slack-manifest.yaml
(scopes chat:write, chat:write.customize, channels:history, im:history;
events message.channels, message.im; socket mode on).`)
return { out }
