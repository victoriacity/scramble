export const meta = {
  name: 'scramble-impl-rest',
  description: 'Continue scramble: server, cli, slack, codex, web, skill+hooks, readme (store has landed)',
  phases: [
    { title: 'server', detail: 'HTTP handler, streams, guards' },
    { title: 'edges', detail: 'cli, slack bridge, codex driver, web ui' },
    { title: 'harness', detail: 'skill + hooks, readme' },
  ],
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

phase('server')
const server = await agent(`${COMMON}
YOUR UNIT: src/server.ts + test/server.test.ts — the HTTP surface over the store.

The store is already written (src/store.ts, report: src/store.ts is landed and GATE GREEN (15 tests, 100% coverage on store.ts + types.ts)). Import it.

Deliver \`createHandler(store, opts: ServerOptions): (req: Request) => Response
| Promise<Response>\` plus a thin \`serve(opts)\` that hands it to Bun.serve.
Tests call the handler DIRECTLY with \`new Request(...)\` — no listening socket.

Routes (DESIGN.md is authoritative):
- POST /rooms/:room  body {from,text,id,lastSeen} -> 200 {seq,crossings}
- GET  /rooms/:room?since=N -> messages
- GET  /rooms/:room/stream?since=N&exclude=<name> -> newline-delimited JSON
  stream, one message per line, resumable via since
- GET  /agents/:name/stream?since=N -> the agent's rooms only, each line a
  Delivery (carries \`mentioned\`), own messages excluded
- GET  /stream?since=N -> firehose (every room), for the Slack DM mirror
- GET  /agents -> roster; GET /rooms -> room list (dm/* included)
- POST /agents/:name  body {persona,room} -> join
- GET  / -> serve web/index.html

Guards, each reporting what it rejected (never silently):
- text longer than maxChars -> 413 {error:"shorten",max}
- per-sender rate limit (ratePerMin) and identical-repeat drop
  (repeatWindowMs) -> 429 with what tripped. Humans are never rate-limited:
  a sender that has not joined as an agent is treated as human.
- when opts.token is set, require \`Authorization: Bearer <token>\` on every
  route -> 401 otherwise. Unset means no check (the localhost default).
Streams: use a ReadableStream so a test can read the first lines and cancel.
Test every guard, every route, and both the token-set and token-unset paths.`)

phase('edges')
await parallel([
  () => agent(`${COMMON}
YOUR UNIT: src/cli.ts + test/cli.test.ts — the agent-facing CLI.

src/store.ts and src/server.ts exist (server report: ${server}). Import them.

Deliver \`main(argv: string[], io): Promise<number>\` where io carries the
injectable seams (stdout/stderr write, fetch, env, cwd). Tests drive main()
with a fake io and an in-process handler as fetch — no child process, no
socket. A tiny \`#!/usr/bin/env bun\` entry at the bottom calls main only when
the file is the entrypoint (import.meta.main).

Verbs (DESIGN.md):
- post <room> <text> --as <name>   : generates the dedup id, prints the
  crossings returned by the post in the same one-JSON-line-per-message format
  listen uses, so the agent sees what it raced with.
- listen --as <name> [<room>...]   : streams; with no room argument uses the
  agent-scoped stream (all rooms), one JSON line per message tagged with room
  and mentioned. Reconnects with backoff, RESUMING at the last seq seen, so no
  gap and no duplicate. Cap the backoff; make the delay injectable so the test
  runs instantly.
- history <room> [--since N]
- join <room> [--as <name>] [--persona <text>] : resolves the workspace
  (nearest ancestor containing .scramble/, else the git root, else cwd),
  reads .scramble/persona.md, scaffolds .scramble/ with a persona stub and an
  empty knowledge/INDEX.md when absent, defaults the name to the workspace
  directory name, and registers with the daemon.
- serve [--bind <addr>] [--token <t>] [--data <dir>]

Config resolution, tested: SCRAMBLE_URL / SCRAMBLE_TOKEN env win over the
workspace .scramble/config.json, which wins over the localhost default.
The listen output format is the contract the whole harness reads: one JSON
object per line, nothing else on stdout.`),

  () => agent(`${COMMON}
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
events message.channels, message.im; socket mode on).`),

  () => agent(`${COMMON}
YOUR UNIT: src/codex.ts + test/codex.test.ts — the codex driver (driver-attach).

Deliver \`createDriver(cfg, spawn)\` where spawn is the INJECTED process seam
(returns {stdout, exitCode}); tests pass a fake that mimics \`codex exec\`
JSON output, so no codex binary and no network.

Behavior (DESIGN.md "Join recipe: codex"):
- Subscribe to the agent-scoped stream for the codex participant's name.
- Per delivered message, run \`codex exec resume <sessionId> --json\` with the
  message as the prompt, SERIALIZED per session (never two turns at once for
  one session; queue them).
- Harvest the last assistant message from the JSON stream and post it to the
  room as that agent.
- Bootstrap: with no session id, the first turn runs plain \`codex exec\` and
  the returned session id is remembered.
- A codex failure (non-zero exit, unparseable output) POSTS an error line to
  the room as that agent — it is never swallowed and never retried silently.
Test: bootstrap, resume, serialization under two rapid messages, and the
failure path posting to the room.`),

  () => agent(`${COMMON}
YOUR UNIT: web/index.html + test/web.test.ts — the human UI.

One self-contained static page, no framework, no build, no CDN. It talks to
the daemon written in src/server.ts: GET /rooms for the room list, GET
/rooms/:room?since=0 for history, GET /rooms/:room/stream for live messages
(read the newline-delimited JSON body incrementally with fetch + a stream
reader), POST /rooms/:room to send. A room list including dm/* rooms (every
room is readable — DM is addressing scope, not secrecy), a message pane
showing from/text/time, and a composer with a name the page remembers in
localStorage. Legible in both light and dark, no horizontal page scroll.

test/web.test.ts asserts the page is served by the handler, that it contains
no external http(s) asset URL, and that the fetch calls it makes match the
server's real routes (parse the HTML for the paths it uses and assert each is
a route the handler answers rather than a 404).`),
])

phase('harness')
await parallel([
  () => agent(`${COMMON}
YOUR UNIT: skills/scramble/{SKILL.md,CONTRACT.md,CODEX.md} + the two hook
scripts .scramble/hooks/{post_gate.ts,stop_backstop.ts} + test/hooks.test.ts.

src/cli.ts exists — read it and use its REAL flags; a command in the skill
that the CLI does not accept is a defect.

ONE skill, one trigger ("join a scramble room"). SKILL.md holds the trigger
and the join procedure; CONTRACT.md holds the seven conversational rules from
DESIGN.md in full and is the SINGLE source — SKILL.md points at it by path
and does not restate the rules; CODEX.md holds the codex recipes. The join
procedure: read .scramble/persona.md and .scramble/knowledge/INDEX.md, catch
up on history, start \`scramble listen\` in the background and arm a monitor on
it, install the two hooks, then greet the room.

The hooks (DESIGN.md "Hooks"), each a bun script reading the hook JSON on
stdin and answering on stdout:
- post_gate.ts (PreToolUse on a \`scramble post\` command): blocks a message
  breaking the speaking rules — status-report shapes, self-reply, a
  mention-free post that adds nothing. Its block message CITES the
  CONTRACT.md path; it never restates the rule.
- stop_backstop.ts (Stop): two checks over the listener cursor —
  (1) pending: delivered seq beyond the last handled seq -> block and
  re-present; (2) unanswered-addressed: a message this turn had
  mentioned=true for this agent and no post from this agent landed in that
  room afterward -> block, naming room and seq.

test/hooks.test.ts is a POSITIVE CONTROL, not a smoke test: run each hook
against known-BAD input and assert it blocks, and against known-GOOD input
and assert it passes. Include the case that must PASS untouched: not
addressed and silent. A hook that never blocks is the failure this test
exists to catch.`),

  () => agent(`${COMMON}
YOUR UNIT: README.md + test/readme.test.ts — the operator documentation.

Cover, from DESIGN.md: what scramble is in three sentences; quickstart
(start the daemon, join a Claude session with the skill, open the web UI);
the Slack setup for both identity tiers plus DMs, pointing at
docs/slack-manifest.yaml; cross-machine setup (SCRAMBLE_URL, the optional
shared token, the ssh -L alternative); the codex recipes; and the layout of a
workspace .scramble/ directory (persona.md, config.json, knowledge/).

Write commands that WORK against the real CLI in src/cli.ts — read it first.
test/readme.test.ts extracts every \`scramble …\` command line from README.md
and asserts each one's verb and flags are accepted by the CLI's parser (call
the parser directly; do not spawn processes). A documented command the CLI
rejects fails the test.`),
])

return { units: 8, workspace: 'laneless shared dir' }
