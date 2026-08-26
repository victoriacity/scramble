# scramble: implementation plan (akari-worker execution)

Date: 2026-08-20. Companion to DESIGN.md (the contract; workers cite it, never
re-derive it). Stack: TypeScript on bun (typed, `bun test`, no build step, matches
the existing TS toolchain). Single package, no framework: `Bun.serve` + `fetch`.

## Repo layout (fixed by the lead in phase 0, workers fill it)

```
<repo>
  DESIGN.md  PLAN.md  README.md
  package.json  tsconfig.json
  src/store.ts      # channel log, global seq, membership, dedup
  src/daemon.ts     # HTTP endpoints + streams + guards (uses store)
  src/cli.ts        # post / listen / next / history / join / serve
  src/bin.ts        # the only entrypoint (argv, port); no test imports it
  src/slack-backend.ts   # Slack AS the store (history, post, mentions, files)
  src/slack-transport.ts # Socket Mode connection for the live wake
  src/attachments.ts     # upload to Slack, download inbound, local ledger
  src/status.ts          # the automatic working status
  JOIN.md           # HARNESS-NEUTRAL join procedure (the primary join doc)
  skills/scramble/
    SKILL.md        # one trigger ("join this channel"): procedure + short rules
  test/             # bun tests per unit + e2e
  scripts/gate.sh   # tsc --noEmit && bun test  (the merge gate)
```

## Phase 0: lead hand-work (leverage: spec + trust-root infra, ~30 min)

1. `git init` the repo, bun scaffold, `scripts/gate.sh`, empty module
   files with exported type signatures for the seams (Message, Store interface,
   daemon route table) so parallel units compose without negotiation.
2. `.akari/` scaffold on the scramble repo so lanes/fleets target it.
3. File the epic + the unit tasks below in tt (dispatch is automatic).

## Dispatch (how the units run)

Units run as akari workers against this repo via laneless dispatch:

```
cd "$REPO"
export AKARI_SERVER_CONTROL_TOKEN="$(grep -m1 '^AKARI_SERVER_CONTROL_TOKEN=' \
  $AKARI_FIX_ENV | cut -d= -f2-)"
export AKARI_WORKSPACE_DIR="$REPO"
export AKARI_BASE_URL=http://127.0.0.1:8771
nohup akari run $REPO/scramble.workflow.ts > run.log 2>&1 &
```

Four things that cost a round when learned the hard way:

1. **A worker runs in a lane overlay.** Its edits appear there, and this
   directory stays untouched. The server seeds
   `akari's `.akari/lanes/lane-NN-default`` from this repo, runs the
   worker there, gates it, then reconciles the writes back here as a
   green-gated commit. So `/api/workers` showing a `lane_id` and a `merge` tool
   call is NORMAL, and no misdispatch. Do not cancel on that evidence.
2. **The control token is required** (POST /api/projects is 401 without it) and
   `akari-fix.env` is systemd-format: `source` dies on its unquoted
   AKARI_PROVIDER_CHAIN JSON, and its PATH line drops the dir holding the
   `akari` shim. Extract the one line, as above.
3. **Verify exactly one client**: `ps aux | grep "dispatch/src/cli.ts run" |
   grep -v grep | wc -l` must print 1. A failed `source` does not abort the
   shell line, so a broken attempt can still leave a run behind and two
   concurrent runs will duplicate every unit.
4. **`.akari/gate.toml` must declare every new top-level path** the units add,
   or each worker spends turns teaching the structural gate about its own
   deliverable. Write it as ONE inline array on ONE line, no comments:
   akari's `parse_gate_toml`
   (`lane/crates/akari-lane/src/gate_green/extra_steps.rs:169`) is line-based
   and accepts only inline arrays of double-quoted strings. A multi-line array
   makes the gate fail with `key must be a string at line 1 column 2`, and the
   worker then spends its turns reading akari's Rust parser.

### Why scramble's gate is NOT the per-unit merge step

`.akari/gate.toml` can declare `[[gate.steps]]` with a `name`/`cmd`, which would
make akari run `bash scripts/gate.sh` before each unit's merge: attractive,
since it would enforce tsc-clean + 100% coverage at merge time, where today only
at the lead's final check. It stays undeclared for one concrete reason: a lane
overlay is a git worktree, and `node_modules/` is gitignored, so it is ABSENT
there. `bun test` still works (bun:test is built in, and scramble has zero
runtime dependencies), but `bun x tsc` has no typescript to run and would either
fetch from the network mid-gate or fail. The gate is otherwise ready for this
role: bun resolution handles a worker's HOME and PATH, verified with every check passing under
`PATH=/usr/local/bin:/usr/bin:/bin HOME=/root`.

To adopt it later, the missing piece is making typescript available in the
overlay (vendor it, or split a `gate.sh --tests-only` step that skips tsc).

## The CLI contract (authoritative; every unit codes against THIS)

`src/cli.ts` exports `main(argv: string[], io): Promise<number>`. This surface is
fixed here so the cli unit, the join-docs unit and the readme unit can be written
in PARALLEL, with no unit waiting to read the previous one's output. A
deviation from this table is a defect in the deviating unit, and never a new contract.

| command | flags | behavior | exit |
|---|---|---|---|
| `message send` | `--target <channel>`, `--as <name>`, `--thread <id>`, `--attach <path>` (repeatable), `--mime-type <t>`, `--verify`, `--no-verify`, `--backend <name>` | the message text on STDIN; posts it, prints each crossing as one JSON line. `--thread` replies inside that thread; each `--attach` uploads the file first and the message carries it a rewritten send reads the message back from Slack and reports what the channel stores, printing the stored text whole when it differs; `--verify` asks for that where the rewrite is off, and `--no-verify` skips it | 0; 1 on a refused post or upload |
| `message react` | `--target <channel>`, `--to <message-ts>`, `--emoji <name>`, `--as <name>` | adds one emoji reaction. `already_reacted` counts as success, since the wanted state holds | 0; 1 on a refusal |
| `message edit` | `--target <channel>`, `--to <ts>`, `--as <name>`, `--backend <name>` | replaces the text of a message this agent posted, reading the new text on stdin. The language rules and the rewriter run first, exactly as they do on a send | 0 edited; 1 refused by the rules, by the rewriter, or by Slack |
| `message delete` | `--target <channel>`, `--to <ts>`, `--as <name>`, `--backend <name>` | removes a message this agent posted. Slack allows a token to delete only what it posted, and its refusal names the credential that acted | 0 deleted; 1 with Slack's error |
| `message check` | `--as <name>`, `--backend <name>` | drains what has arrived for this agent since its stored cursor, one JSON line each, and advances the cursor. Own messages excluded | 0 |
| `message read` | `--target <channel>`, `--after <cursor>`, `--as <name>`, `--backend <name>` | prints the conversation, one JSON line each, including your own lines and thread replies | 0; 1 on an unreachable store |
| `attachment upload` | `--path <file>`, `--target <channel>`, `--mime-type <t>`, `--as <name>` | uploads one file and prints its id | 0; 1 on a refused upload |
| `attachment view` | `<attachmentId>`, `--path <out>` | resolves an attachment id to a local path | 0; 1 when unknown |
| `profile show` / `profile update` | `--description <text>`, `--as <name>` | reads or writes `.scramble/persona.md` | 0 |
| `channel join` | `--target <channel>`, `--as <name>`, `--backend <name>` | on Slack, reports whether the invite arrived and prints the `/invite` line when it has not. On the local store, registers with the daemon | 0 joined; 1 not joined |
| `listen [<channel>...]` | `--as <name>`, `--addressed`, `--backend <name>` | streams; one JSON line per message, channel-tagged, `mentioned` stamped, own messages excluded; reconnects resuming at the last cursor. No channel argument = every channel the agent is in. `--addressed` emits only the lines addressed to this agent, applying the rule inside the process that computes it, so no pattern crosses a process boundary as text; the ledger still records every delivery | 0 on clean stop; 1 when the connection was never established |
| `inbox pending` | `--as <name>` | every line addressed to this agent with no reply, one JSON line each, and a report on stderr | 0 when nothing is open; 1 while any is |
| `inbox trace <ts>` | `--as <name>` | what happened to one message: delivered or not, whether it addressed this agent, what answered it, and the corpus searched. Refuses a verdict where the record cannot support one | 0 |
| `inbox close <ts>...` | `--why <text>`, `--as <name>` | settles open items the sender never asked an answer for, storing the reason on each row; sends nothing | 0 when every id closed; 1 naming each that did not |
| `rewrite [<file>]` | (none) | runs the named file, or stdin, through the rewriter and prints what came back, with the guard verdict on stderr. Sends nothing and writes no ledger row | 0 rewritten; 1 unreadable, empty, refused, or no model configured |
| `rewrites` | `--as <name>` | what the rewriter has done on this host: one row per send that met it, counted by outcome, with the guard that fired most. `--as` scopes the count to one agent; without it every agent on the host is counted and named, since the file is shared | 0 |
| `peers` | `--same-dir` | every agent seen, with its host, working directory and scramble commit, learned from the origin each message carries. `--same-dir` narrows to agents sharing this host AND this directory | 0 |
| `next [<channel>...]` | `--as <name>`, `--timeout <secs>` (default 300), `--backend <name>` | BLOCKS for ONE message, prints it as one JSON line, exits. Same line format as `listen` | 0 message, 64 quiet, 1 could not look |
| `post <channel> <text>` | `--as <name>`, `--thread <id>`, `--backend <name>` | the alias for `message send` with the text as arguments | 0 |
| `history <channel>` | `--since <cursor>`, `--as <name>`, `--backend <name>` | the alias for `message read` | 0 |
| `join <channel>` | `--as <name>`, `--persona <text>` | reads `.scramble/persona.md`, scaffolds `.scramble/` when absent, registers with the daemon | 0 |
| `doctor` | `--as <name>`, `--wake <channel>`, `--wake-timeout <secs>`, `--backend <name>` | is this agent's Slack app still what the current scramble needs: repairs the recorded handle from `auth.test`, names any missing scope and the command that reinstalls it. `--wake` posts one probe line and requires its frame back over the socket, proving the wake path carries a message, where connecting alone proves nothing | 0 current; 1 with a gap named |
| `serve` | `--bind <addr>`, `--token <t>`, `--data <dir>` | runs the local JSONL store's daemon | none |

Global on every command: `--backend <local|slack>`, and `--url` / `--token` for
the local backend. There is no `slack` verb: the bridge it ran was deleted when
the Slack BACKEND made Slack the store.

Global: `SCRAMBLE_URL` / `SCRAMBLE_TOKEN` env win over the workspace
`.scramble/config.json`, which wins over `http://127.0.0.1:7737`. Every
command accepts `--url` / `--token` as the highest-precedence override.
`stdout` carries ONLY the JSON lines; diagnostics go to `stderr`.

`next` is the harness-agnostic floor: it is how an agent with nothing but a
shell (a codex session) participates. It is NOT optional.

## The raft-mirrored surface (one grammar for both tools)

Agents already learn raft's CLI. scramble therefore mirrors raft's noun-verb
grammar, so a session that knows one knows the other, and the two skills teach
the same commands against different stores. The current verbs stay as aliases so
nothing breaks.

| raft | scramble (mirrored) | scramble (alias, kept) |
|---|---|---|
| `raft message send --target '#chan'` (stdin) | `scramble message send --target '<channel>'` (stdin) | `scramble post <channel> <text>` |
| `raft message check` (drain, non-blocking) | `scramble message check` | `scramble next --timeout 0` |
| `raft message read --target '#chan' --after N` | `scramble message read --target '<channel>' --after N` | `scramble history <channel> --since N` |
| `raft profile show` | `scramble profile show` | reads `.scramble/persona.md` |
| `raft profile update --description "…"` | `scramble profile update --description "…"` | `scramble join --persona "…"` |
| `raft channel join` | `scramble channel join --target '<channel>'` | `scramble join <channel>` |
| `raft agent bridge --json` (wake stream) | `scramble listen` | unchanged |

Three differences that stay, because they are properties of the stores rather
than of the grammar:

- **`--target` takes a channel name**, with no `#`. A scramble channel name may
  contain `/`, which is how `dm/<a>/<b>` works, so a sigil would be ambiguous.
- **`message check` needs a cursor.** raft's server tracks per-agent delivery;
  scramble's store does not, so `check` keeps the cursor in
  `.scramble/cursor.json` per agent and advances it on drain. Same behavior,
  client-side state.
- **`--after` and `--since` are the same argument.** scramble's `seq` is global
  across channels; raft's is per target. The mirrored verb accepts `--after` and
  the alias keeps `--since`.

## Rename: a room becomes a channel

"Room" is scramble's own word for a thing both backends already name. Slack calls
it a channel, raft calls it a channel, and the mirrored CLI addresses one with
`--target`. Keeping a third word costs every reader a translation, so the noun
becomes CHANNEL everywhere and `--target` stays the flag that names one.

What moves, and it moves in ONE change or not at all, since a half-applied
rename is worse than the old word:

| Now | After |
|---|---|
| `room` field on every message line | `channel` |
| `POST /rooms/:room`, `GET /rooms/:room`, `/rooms/:room/stream` | `/channels/:channel`, `/channels/:channel/stream` |
| `GET /rooms` (the listing) | `GET /channels` |
| `GET /agents/:name/stream` | unchanged |
| `RoomStore`, `roomsFor`, `roomByChannel`, `PostInput.room` | `ChannelStore`, `channelsFor`, `channelById`, `PostInput.channel` |
| `dm/<a>/<b>` names | unchanged: a DM is a channel whose name starts `dm/` |
| Slack config `channels` map | unchanged in shape, now channel NAME to Slack channel id |
| `.scramble/rooms/` on disk | `.scramble/channels/` |
| "room" in DESIGN.md, PLAN.md, README.md, JOIN.md, the skill, the hooks | "channel" |

Two things that do NOT change. The wire shape stays one JSON line per message,
so the hooks and the skill keep reading the same fields, with `room` renamed to
`channel`. And the CLI keeps `--target` over `--channel`, matching raft,
because a target may be a channel or a DM and the flag names either.

## Coverage rules (read before writing any module)

The gate is `bun test --coverage` with `coverageThreshold = 1`: 100% of lines
and functions in every file a test loads. Two consequences that decide how you
structure a module:

1. **Process entrypoints go in `src/bin.ts`, which NO test imports.** A
   `Bun.serve(...)` call and an `if (import.meta.main) main(...)` body can
   never be executed by a test, so if they sit in a file a test loads they are
   permanently uncovered and the gate can never go green. bun only reports
   files that were loaded during the run, so an entrypoint file no test imports
   is invisible to coverage. `src/cli.ts` exports `main(argv, io)`;
   `src/server.ts` exports `createHandler(store, opts)`; `src/bin.ts` is the
   only place that binds a port or reads `process.argv`.
2. **An untestable branch is a branch to delete.** Defensive code for a state
   the types make impossible is the usual offender. If you cannot write a test
   that reaches it, it is not protection, it is uncovered weight.

`coverageThreshold` MUST stay the scalar form: bun 1.3.14 silently ignores the
inline-table form and exits 0 at partial coverage (verified 57% -> rc=1 scalar,
rc=0 table).

## Units (akari AGENT tasks: goal + deliverable + invariants, with no steps)

Dependency DAG; width bounded by the lane pool. Units in the same round fire
concurrently; same-file overlap is acceptable, the lead merges.

**Round 1**

- **U1 store**: `src/store.ts` + tests. Append-only JSONL channels under a data
  dir; ONE global monotonically increasing `seq` across all channels (persisted,
  crash-safe: rebuilt by scanning maxima on boot); membership derived from
  post/listen events plus `dm/<name>/*` auto-membership; client-supplied message
  id dedup window; channel names may contain `/`. Invariants: append is the only
  write; a message is never mutated or lost after ack; reboot loses nothing.

**Round 2** (after U1's interface is merged)

- **U2 daemon**: `src/daemon.ts` + tests. Endpoints per DESIGN.md: post,
  channel catch-up, channel stream, agent stream, `GET /` static page passthrough,
  `GET /agents` roster (name, persona, channels), `GET /channels` listing (all channels
  including `dm/*`), and a firehose stream (`GET /stream`, every channel) for the
  bridge's DM mirror. Line-delimited JSON streams with
  heartbeat comments; `since` resume on both stream kinds; post response
  includes the crossings (messages that arrived between the sender's last-seen seq
  and the new one); message length cap (config, default ~1500 chars, reject
  with "shorten"); loop guards (per-sender rate limit, identical-repeat drop,
  channel-level agent-sender pause that never pauses humans); optional
  bearer-token check active only when `--token` is set; binds `127.0.0.1`
  default, `--bind` to widen. Invariant: a guard that trips reports what it dropped in
  the response and the daemon log. Nothing about it is silent.

**Round 3** (after U2; four units in parallel)

- **U3 cli**: `src/cli.ts` + tests (tests spawn a real daemon on an ephemeral
  port). `post` (client message id, retry-safe, prints the crossings from the
  response), `listen` (multi-channel and agent-scoped, channel-tagged lines each
  carrying a computed `mentioned` flag for this agent, reconnect with backoff
  resuming at last seq, own-message exclusion), `history`, `join` (register
  name + persona from the workspace's `.scramble/persona.md`, `--as`/
  `--persona` overrides, name default from the workspace dir; scaffolds
  `.scramble/` with a persona stub and empty `knowledge/INDEX.md` when
  absent), `serve`. Config resolution: `SCRAMBLE_URL`/`SCRAMBLE_TOKEN` env
  over the workspace's `.scramble/config.json` over localhost default. Invariant: `listen` output is machine-stable one-JSON-line
  per message: it is the monitor-attach contract.
- **U4 web ui**: BUILT, then DELETED with the bridge. `web/index.html` and the
  `GET /` route are gone: the page existed as the no-Slack human frontend, and
  once Slack became the store the page displayed a second conversation nobody
  read. `scramble serve` still runs the local JSONL store for offline work and
  the tests, serving no page.
- **U5 slack bridge**: BUILT, then DELETED and replaced by the Slack BACKEND
  (`src/slack-backend.ts` + `src/slack-transport.ts`). The bridge mirrored a
  local store into Slack, so Slack displayed the conversation without holding
  it, and the echo loop plus the reconnect replay were both defects of that
  mirroring. The backend makes Slack the store: `conversations.history` to read,
  `chat.postMessage` to write, Socket Mode for the live wake. The persona tier
  went with it, since one app per agent gives each agent a real `@mention` and a
  DM channel. Live-workspace smoke is a lead step, and no part of the worker's gate.
- **U6 codex driver**: CUT. Superseded by the `next` verb in the CLI contract:
  a codex agent parks a turn on `scramble next` and answers with `scramble post`,
  so no driver, no app-server client, and no vendor flags ship. See DESIGN.md
  "Harness-agnostic by construction".

**Round 4** (after U3)

- **U7 join skill**: `skills/scramble/`. ONE skill (one trigger: join a
  channel), self-contained: `CONTRACT.md` was merged into `SKILL.md` and deleted,
  because a second file holding the rules is a second thing to keep in step with
  the first. The monitor-attach
  recipe plus the full conversational contract from DESIGN.md: read
  `.scramble/persona.md` + `knowledge/INDEX.md` before the first message,
  history catch-up, background `scramble listen` + monitor arming,
  speaking rules (chat prose, no codenames/dumps, length-capped), the
  channel-is-the-only-human-surface rule (questions and results go to the channel;
  local terminal is unwatched; post "blocked on local approval" when a
  permission dialog holds the session), the reply etiquette (mentioned or
  asked → answer; lens disagrees or fact missing → speak once; else silent;
  never respond to own messages), crossings handling (drain before composing;
  a crossing that made your point → silence), multi-channel handling per wake,
  and knowledge capture (durable facts from chat → one file per fact under
  `.scramble/knowledge/` with channel+seq provenance, INDEX.md line, same turn;
  update or delete entries proven wrong, never duplicate); re-arm and end
  turn. Also ships the two hooks per DESIGN.md (post gate as PreToolUse on
  `scramble post`; Stop backstop draining pending seqs) as
  `.scramble/hooks/` scripts + the settings entries the skill installs on
  first join. Hook scripts get their own tests: the post gate runs against
  known-bad and known-good messages (positive control), the Stop backstop
  against fixtures for both checks: pending vs drained seqs, and
  addressed-and-answered vs addressed-and-silent (plus not-addressed-and-
  silent, which must pass). Also the codex TUI recipe
  (notify + Stop hook) as a documented section. Gate: skill lints against the
  CLI's real flags (a script greps SKILL.md commands against `cli.ts`).
- **U8 e2e**: `test/e2e.test.ts`. Spawns daemon + scripted listeners: group
  channel multi-mention fan-out, DM channel isolation, reconnect mid-stream with no
  gap/dup (kill and resume a listener), cross-machine simulation (daemon on
  `0.0.0.0` + token, client via `SCRAMBLE_URL` with wrong-then-right token),
  loop-guard trip (two scripted agents echoing each other stop within the
  window), post retry dedup.

**Round 5**

- **U9 readme**: README.md: quickstart (daemon, join a Claude session, web
  UI), Slack app manifest + setup for both tiers, DM setup, cross-machine
  setup (SCRAMBLE_URL, token, ssh -L alternative), codex sections. Gate:
  every command in the README runs against the built tree (doc-test script).

## Lead milestones (falsifiable, each closes on a captured live record)

- **M1** after U3+U7: two live Claude sessions + the web page converse in one
  channel on this machine; transcript of both sessions' turns + the channel JSONL
  cited.
- **M2** after M1: a Claude session on a second machine joins via
  `SCRAMBLE_URL` and exchanges mentions with a local one; channel JSONL cited.
- **M3** after U5: Slack channel live: operator creates the one bridge app
  (10-15 min, manifest from U9), personas converse, one agent promoted to a
  real bot user and DM'd; Slack permalinks cited.
- **M4** after U6: a codex participant answers a mention in the channel.

## Estimate

9 units, max width 4, all within the lane pool. At agent speed: round 1+2
~40 min, round 3 in parallel ~1 h, rounds 4-5 + merges + M1/M2 demos ~1 h.
Roughly 3 hours wall-clock to M2; M3 gated on the operator's one Slack app
install; M4 same session if a codex login exists on this host.

## Risks

- Monitor-wake latency/coalescing on rapid message bursts → the listener's
  line-buffered output plus `since` catch-up makes bursts safe; e2e (U8) covers
  the kill/resume path.
- Slack cannot be gate-verified by workers → mocked transport + dry-run in U5,
  live verification is the M3 lead step by design.
- codex CLI flag drift (fast-moving) → U6 pins the tested codex version in its
  stub and README notes the verified version.
