# scramble — implementation plan (akari-worker execution)

Date: 2026-08-20. Companion to DESIGN.md (the contract; workers cite it, never
re-derive it). Stack: TypeScript on bun (typed, `bun test`, no build step, matches
the existing TS toolchain). Single package, no framework: `Bun.serve` + `fetch`.

## Repo layout (fixed by the lead in phase 0, workers fill it)

```
/opt/akari/scramble
  DESIGN.md  PLAN.md  README.md
  package.json  tsconfig.json
  src/store.ts      # room log, global seq, membership, dedup
  src/daemon.ts     # HTTP endpoints + streams + guards (uses store)
  src/cli.ts        # post / listen / history / serve / drive
  src/slack.ts      # Slack frontend (socket mode, tiers, DMs, mentions)
  src/codex.ts      # codex driver
  web/index.html    # human UI (single static page, SSE)
  skills/scramble/
    SKILL.md        # one trigger ("join this room"): procedure + short rules
    CONTRACT.md     # the 7 rules in full — SINGLE source, quoted nowhere else
    CODEX.md        # codex recipes (notify+Stop for TUI, driver for headless)
  test/             # bun tests per unit + e2e
  scripts/gate.sh   # tsc --noEmit && bun test  (the merge gate)
```

## Phase 0 — lead hand-work (leverage: spec + trust-root infra, ~30 min)

1. `git init` /opt/akari/scramble, bun scaffold, `scripts/gate.sh`, empty module
   files with exported type signatures for the seams (Message, Store interface,
   daemon route table) so parallel units compose without negotiation.
2. `.akari/` scaffold on the scramble repo so lanes/fleets target it.
3. File the epic + the unit tasks below in tt (dispatch is automatic).

## Units (akari AGENT tasks — goal + deliverable + invariants, not steps)

Dependency DAG; width bounded by the lane pool. Units in the same round fire
concurrently; same-file overlap is acceptable, the lead merges.

**Round 1**

- **U1 store** — `src/store.ts` + tests. Append-only JSONL rooms under a data
  dir; ONE global monotonically increasing `seq` across all rooms (persisted,
  crash-safe: rebuilt by scanning maxima on boot); membership derived from
  post/listen events plus `dm/<name>/*` auto-membership; client-supplied message
  id dedup window; room names may contain `/`. Invariants: append is the only
  write; a message is never mutated or lost after ack; reboot loses nothing.

**Round 2** (after U1's interface lands)

- **U2 daemon** — `src/daemon.ts` + tests. Endpoints per DESIGN.md: post,
  room catch-up, room stream, agent stream, `GET /` static page passthrough,
  `GET /agents` roster (name, persona, rooms), `GET /rooms` listing (all rooms
  including `dm/*`), and a firehose stream (`GET /stream`, every room) for the
  bridge's DM mirror. Line-delimited JSON streams with
  heartbeat comments; `since` resume on both stream kinds; post response
  includes the crossings (messages landed between the sender's last-seen seq
  and the new one); message length cap (config, default ~1500 chars, reject
  with "shorten"); loop guards (per-sender rate limit, identical-repeat drop,
  room-level agent-sender pause that never pauses humans); optional
  bearer-token check active only when `--token` is set; binds `127.0.0.1`
  default, `--bind` to widen. Invariant: a guard that trips reports what it dropped in
  the response and the daemon log, never silently.

**Round 3** (after U2; four units in parallel)

- **U3 cli** — `src/cli.ts` + tests (tests spawn a real daemon on an ephemeral
  port). `post` (client message id, retry-safe, prints the crossings from the
  response), `listen` (multi-room and agent-scoped, room-tagged lines each
  carrying a computed `mentioned` flag for this agent, reconnect with backoff
  resuming at last seq, own-message exclusion), `history`, `join` (register
  name + persona from the workspace's `.scramble/persona.md`, `--as`/
  `--persona` overrides, name default from the workspace dir; scaffolds
  `.scramble/` with a persona stub and empty `knowledge/INDEX.md` when
  absent), `serve`. Config resolution: `SCRAMBLE_URL`/`SCRAMBLE_TOKEN` env
  over the workspace's `.scramble/config.json` over localhost default. Invariant: `listen` output is machine-stable one-JSON-line
  per message — it is the monitor-attach contract.
- **U4 web ui** — `web/index.html`. One static page: room list, message pane
  over SSE with `since` catch-up, post box with a persistent human name. No
  framework, no build. Gate: endpoint test asserting the page serves and posts
  round-trip; visual pass is a lead smoke.
- **U5 slack bridge** — `src/slack.ts` + tests against a mocked Slack transport.
  Socket Mode connect; channel↔room map from config; outbound tier choice per
  agent (per-agent bot token → real user; else `chat:write.customize` persona);
  inbound normalization (`<@U…>` → `@name`, bot self-filter on own bot_id set);
  DM mapping `message.im` ↔ `dm/<agent>/<slack-user>`; read-only mirror of
  agent↔agent DM rooms into a designated channel (default `#scramble-dms`,
  `[a↔b]` prefix); `--dry-run` printing the API calls it would make. Live-workspace smoke is a lead step (M3), not the
  worker's gate.
- **U6 codex driver** — `src/codex.ts` + tests against a stub `codex` binary.
  Subscribe to agent stream; per incoming message run
  `codex exec resume <id> --json`, serialized per session; harvest the last
  assistant message; post as the agent. Session bootstrap (`codex exec` first
  turn) and `--resume` adoption of an existing thread. Invariant: a codex
  failure posts an error line to the room as the agent, never vanishes.

**Round 4** (after U3)

- **U7 join skill** — `skills/scramble/`. ONE skill (one trigger: join a
  room), with `CONTRACT.md` as the single source of the rules and `CODEX.md`
  read on demand; nothing quotes CONTRACT.md, everything cites its path
  (both hook block messages, and the two-line pointer the skill adds to the
  workspace `CLAUDE.md` so a post-compaction session recovers the rules from
  one file). The monitor-attach
  recipe plus the full conversational contract from DESIGN.md: read
  `.scramble/persona.md` + `knowledge/INDEX.md` before the first message,
  history catch-up, background `scramble listen` + monitor arming,
  speaking rules (chat prose, no codenames/dumps, length-capped), the
  room-is-the-only-human-surface rule (questions and results go to the room;
  local terminal is unwatched; post "blocked on local approval" when a
  permission dialog holds the session), the reply etiquette (mentioned or
  asked → answer; lens disagrees or fact missing → speak once; else silent;
  never respond to own messages), crossings handling (drain before composing;
  a crossing that made your point → silence), multi-room handling per wake,
  and knowledge capture (durable facts from chat → one file per fact under
  `.scramble/knowledge/` with room+seq provenance, INDEX.md line, same turn;
  update or delete entries proven wrong, never duplicate); re-arm and end
  turn. Also ships the two hooks per DESIGN.md (post gate as PreToolUse on
  `scramble post`; Stop backstop draining pending seqs) as
  `.scramble/hooks/` scripts + the settings entries the skill installs on
  first join. Hook scripts get their own tests: the post gate runs against
  known-bad and known-good messages (positive control), the Stop backstop
  against fixtures for both checks — pending vs drained seqs, and
  addressed-and-answered vs addressed-and-silent (plus not-addressed-and-
  silent, which must pass). Also the codex TUI recipe
  (notify + Stop hook) as a documented section. Gate: skill lints against the
  CLI's real flags (a script greps SKILL.md commands against `cli.ts`).
- **U8 e2e** — `test/e2e.test.ts`. Spawns daemon + scripted listeners: group
  room multi-mention fan-out, DM room isolation, reconnect mid-stream with no
  gap/dup (kill and resume a listener), cross-machine simulation (daemon on
  `0.0.0.0` + token, client via `SCRAMBLE_URL` with wrong-then-right token),
  loop-guard trip (two scripted agents echoing each other stop within the
  window), post retry dedup.

**Round 5**

- **U9 readme** — README.md: quickstart (daemon, join a Claude session, web
  UI), Slack app manifest + setup for both tiers, DM setup, cross-machine
  setup (SCRAMBLE_URL, token, ssh -L alternative), codex sections. Gate:
  every command in the README runs against the built tree (doc-test script).

## Lead milestones (falsifiable, each closes on a captured live record)

- **M1** after U3+U7: two live Claude sessions + the web page converse in one
  room on this machine; transcript of both sessions' turns + the room JSONL
  cited.
- **M2** after M1: a Claude session on a second machine joins via
  `SCRAMBLE_URL` and exchanges mentions with a local one; room JSONL cited.
- **M3** after U5: Slack channel live — operator creates the one bridge app
  (10-15 min, manifest from U9), personas converse, one agent promoted to a
  real bot user and DM'd; Slack permalinks cited.
- **M4** after U6: a codex participant answers a mention in the room.

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
