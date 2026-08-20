export const meta = {
  name: 'scramble-final',
  description: 'cli (with the harness-agnostic next verb), join docs + hooks, readme — all against the fixed CLI contract',
  phases: [{ title: 'final' }],
}

const COMMON = `
You are implementing part of "scramble" in the repo you are running in.

READ FIRST (they are the contract, do not re-derive them):
- DESIGN.md — what scramble is, the harness-agnostic rule, and every behavioral rule.
- PLAN.md — "The CLI contract (authoritative)" table and the coverage rules.
- src/types.ts — the shared shapes. Import from it; do not redeclare them.
- src/store.ts and src/server.ts — already landed and GATE GREEN. Use them.

HARD INVARIANTS:
- TypeScript on bun, strict mode, ZERO runtime dependencies. Only bun built-ins.
- HARNESS-AGNOSTIC: nothing you write may name or special-case a vendor
  (Claude, codex, ...) in src/. Vendor material belongs in documentation only.
- Write the LEAST code that satisfies the contract. Fewer branches is the goal.
- 100% coverage of the file(s) you write: bunfig has coverageThreshold = 1, so a
  branch no test reaches turns the gate red. An untestable branch is a branch to
  delete. Process entrypoints (Bun.serve, import.meta.main) go in src/bin.ts,
  which NO test imports — see PLAN.md's coverage rules.
- Keep IO at the edges and INJECT it, so tests need no socket and no sleep.
- Other workers are writing OTHER files in this SAME directory right now. Touch
  ONLY your deliverables. Never edit src/types.ts, src/store.ts, src/server.ts,
  DESIGN.md, PLAN.md, bunfig.toml, tsconfig.json, package.json.
- Verify with your OWN test file only (e.g. \`bun test test/cli.test.ts\`). Do NOT
  run the whole suite: other files are mid-write and their failures are not yours.
- Never mask a failure: no empty catch, no fallback that hides an error.

Report the files you wrote, your test count, and your coverage numbers.
`

phase('final')
await parallel([
  () => agent(`${COMMON}
YOUR UNIT: src/cli.ts + src/bin.ts + test/cli.test.ts — the agent-facing CLI, and
the ONLY thing a joining agent needs.

Implement EXACTLY the table in PLAN.md "The CLI contract (authoritative)":
post, listen, next, history, join, serve — with the flags, the stdout format
(one JSON line per message on stdout, diagnostics to stderr) and the exit codes
it names. Export \`main(argv: string[], io): Promise<number>\`; \`io\` carries the
injectable seams (write/writeErr, fetch, env, cwd, and a sleep for backoff) so
tests drive main() with a fake io and the in-process handler from src/server.ts
as fetch — no child process, no socket, no real delay. src/bin.ts is the only
file that touches process.argv or binds a port, and no test imports it.

The two read modes are the whole point of the product, so get them exactly right:
- \`listen\`: long-lived stream; reconnects with capped backoff RESUMING at the
  last seq seen, so no gap and no duplicate across a reconnect.
- \`next\`: blocks for ONE message then exits 0; exits 64 on timeout with nothing
  printed. This is how an agent whose harness has no wake-on-output facility
  participates, so it must work with nothing but a shell.
Both print the same line shape: the message plus its room and a \`mentioned\`
flag for this agent.

Test every verb, both read modes, the reconnect-resume path, the timeout exit,
and the config precedence (--url/--token > env > workspace .scramble/config.json
> localhost default).`),

  () => agent(`${COMMON}
YOUR UNIT: JOIN.md + skills/scramble/{SKILL.md,CONTRACT.md} + the hooks
.scramble/hooks/{post_gate.ts,stop_backstop.ts} + test/hooks.test.ts.

JOIN.md is the HARNESS-NEUTRAL join procedure and the primary document: it tells
ANY agent how to join a room using only the CLI contract in PLAN.md — pick a
read mode (\`listen\` if your harness can wake you on a background process's
output, else park a turn on \`next\`), read .scramble/persona.md and
.scramble/knowledge/INDEX.md, catch up on history, then the reply etiquette.
It names no vendor in its procedure; it ends with a short "wrappers" section
giving the two-line binding for a wake-on-output harness (a background listener
plus that harness's monitor) and for a shell-only harness (park on \`next\`,
answer, park again) — as examples, not as supported-vendor list.

CONTRACT.md holds DESIGN.md's seven conversational rules IN FULL and is the
SINGLE source: SKILL.md and JOIN.md point at its path and never restate the
rules. SKILL.md is the thin Claude Code wrapper: one trigger ("join a scramble
room"), the background-listener + monitor binding, and pointers.

The hooks, per DESIGN.md "Hooks", each a bun script reading hook JSON on stdin
and answering on stdout:
- post_gate.ts: blocks an outgoing message that breaks the speaking rules
  (status-report shape, self-reply, a mention-free post adding nothing). Its
  block message CITES the CONTRACT.md path instead of restating the rule.
- stop_backstop.ts: two checks over the listener cursor — pending (delivered seq
  beyond the last handled seq) and unanswered-addressed (a message this turn had
  mentioned=true and no post from this agent landed in that room afterward).

test/hooks.test.ts is a POSITIVE CONTROL: each hook against known-BAD input must
BLOCK, against known-GOOD input must PASS, and the case that must pass untouched
— not addressed and silent — must not block. A hook that never blocks is the
defect this test exists to catch.`),

  () => agent(`${COMMON}
YOUR UNIT: README.md + docs/slack-manifest.yaml + test/readme.test.ts.

README.md: what scramble is in three sentences; quickstart (start the daemon,
open the web UI at /, join an agent); the harness-agnostic story (the two read
modes table — any agent that can run a shell command can join, so there is no
supported-vendor list); the Slack setup for both identity tiers plus DMs
(pointing at docs/slack-manifest.yaml); cross-machine setup (SCRAMBLE_URL, the
optional shared token, the ssh -L alternative); and the workspace .scramble/
layout (persona.md, config.json, knowledge/).

docs/slack-manifest.yaml: the app manifest the bridge needs — bot scopes
chat:write, chat:write.customize, channels:history, im:history; bot events
message.channels, message.im; socket mode enabled.

Every \`scramble ...\` command you write MUST match PLAN.md's CLI contract table.
test/readme.test.ts extracts every \`scramble\` command line from README.md and
asserts each verb and flag is one the contract table names, by parsing the table
out of PLAN.md — so a documented command that drifts from the contract fails the
test. Do not spawn processes.`),
])

return { units: 3 }
