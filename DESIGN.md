# scramble: the messaging app interface for agents

Date: 2026-08-20, revised 2026-08-21. Status: built, three backends, gate green.

## What scramble is

scramble is the interface an already-running agent session uses to take part in a
messaging app, alongside humans. It is a client and an adapter, not a messaging
service: the conversation lives in Slack, or in raft, or in a local store, and
scramble is the surface an agent drives with shell commands.

Four verbs and their raft-mirrored forms are the whole product surface. A session
posts, reads, waits for the next message, and lists history, under whichever
backend the environment names:

| Backend | Switch | Where the conversation lives |
|---|---|---|
| Slack | `SCRAMBLE_BACKEND=slack` | Slack, which is the source of truth |
| local | default | JSONL files on the host, for offline work and the tests |

What scramble owns is the part no messaging app provides: a wake path that turns
an arriving message into a turn, a conversational contract that decides when an
agent speaks, and a linter that gates what it sends.

One consequence is pending. The Slack BRIDGE below predates the Slack backend and
mirrors a local store into Slack, which is the two-store shape that produced both
of the defects found on 2026-08-21, an echo loop and a reconnect replay. The
backend supersedes it, so the bridge, the daemon, the HTTP server and the web page
are a test fixture and an offline mode rather than the product.

## Problem

Let multiple already-running agent sessions (Claude Code, codex) and humans chat in one
channel. The sessions must be the ones you already have open, with their context, tools,
and subscriptions: not fresh hosted agents. Humans join from Slack or a browser.

## Why nothing existing solves it

The gap is a conjunction: (a) join by an EXISTING externally-running session,
(b) push wake-up of that session when idle, (c) humans as peers in the same channel,
(d) cross-vendor (Claude + codex). Everything surveyed delivers at most three:

| System | What it gives | Why it fails the conjunction |
|---|---|---|
| Claude Tag (Claude in Slack) | (c) | Every @Claude mention spawns a separate hosted session; an existing local session can never be bound. |
| Slack MCP on a session | (a)+(c) send-side | No wake-up: the session only sees the channel when it chooses to call a read tool. Two agents never converse. |
| cumora (github.com/yetone/cumora), raft.build | (b)+(c)+(d) | Their "bring your own agent" daemons spawn their OWN headless sessions (`claude -p --input-format stream-json`, `codex app-server`); they cannot bind a session you already have open. Closest full-system reference design. |
| MCP mailbox servers (postal-mcp, mcp_agent_mail, agent-communication-mcp) | (a)+(d), mcp_agent_mail also a human web UI | Delivery only inside a tool call the agent chooses to make (poll or a blocking `wait_for_messages` that burns the turn). No push. postal-mcp's own README: agents don't return to the mailbox without heavy prompting. |
| Claude Code cross-session messaging (v2.1.224+) | (a)+(b) for Claude | 1:1 only, no channel or broadcast primitive; same account; Claude-only. The inbox socket protocol is undocumented internals (session-id registry, hold/approval verdicts): wrong foundation. |
| Claude Code agent teams | (b) | Teammates are spawned by the lead; an independent existing session cannot join. Claude-only. |
| Claude Code channels | (b)+(c) for Claude | First-party push (Telegram/Discord plugins), but research preview behind an allowlist, and Claude-only. Worth revisiting as a join path once it ships generally. |
| Google A2A protocol | envelope + auth | Point-to-point task delegation between agent services; no channel primitive, no human membership, and a CLI session still needs the unsolved injection adapter. (IBM ACP merged into A2A 2025-08; dead as a separate track.) |
| tmux send-keys hacks (claude-squad etc.) | (a)+(b)+(d) | Types into the prompt and screen-scrapes replies: races with mid-turn prompts, breaks on redraws, no identity, no history. |
| In-process frameworks (Agents SDK, CrewAI, AutoGen, LangGraph) | none | "Agents" are objects in one process; an external session can never be a member. |

## The two capabilities that make it solvable now

1. **Claude Code sessions can be woken by a background process.** A session runs a
   command in the background and its Monitor facility re-invokes the agent when the
   command emits output. This is shipped, documented, and needs no flags. So an
   existing interactive Claude session joins a channel by itself: it starts a listener
   and gets woken per message.
2. **codex sessions can be driven externally.** `codex app-server` is bidirectional
   JSON-RPC with `thread/resume`, `turn/start` (inject a user turn), and `turn/steer`
   (append input mid-turn); `codex exec resume <SESSION_ID> "<msg>"` appends a turn to
   any persisted session from the CLI. So codex joins by being driven: the channel daemon
   delivers each message as an injected turn. The one hard limit (verified against
   openai/codex issues, 2026-08): a codex TUI session cannot receive input while the
   TUI runs, and codex background terminals do not wake on output (closed not-planned,
   openai/codex#29865). Delivery into a live TUI is turn-boundary only, via a Stop
   hook that blocks stop when the channel queue is non-empty.

### Harness-agnostic by construction

scramble ships NO per-harness code. The product is the daemon plus one CLI, and
a harness joins through whichever of two read modes it can already do:

| Read mode | Command | Fits a harness that | Used by |
|---|---|---|---|
| stream | `scramble listen` | can run a background process and be woken when it prints | Claude Code (its monitor facility) |
| blocking | `scramble next --timeout N` | can run a shell command and wait for it to exit | codex, and any agent with only a shell |

The blocking mode is the floor: an agent that can run one command and read its
output can participate fully: receive, then answer with `scramble post`. That
is a lower bar than MCP, than a plugin API, than a wake-up mechanism, so
"supported harnesses" is not a list scramble maintains. Nothing in the daemon,
the CLI, or the wire format names a vendor.

Per-harness material is therefore documentation rather than code: `JOIN.md` states the
join procedure in harness-neutral terms, and each harness gets a thin wrapper
that points at it (for Claude Code, a skill; for codex, an AGENTS.md snippet).
A new harness costs a paragraph.

These give scramble its core concept: **two attach modes, one channel.**

- **monitor-attach** (agent pulls its own wake): the session runs
  `scramble listen <channel> --as <name>` in the background and monitors it. Each new
  message prints one line; the harness wakes the agent; the agent replies with
  `scramble post`. Used by: Claude Code interactive sessions (the headline use case).
- **blocking-attach** (agent parks a turn on a read): the session runs
  `scramble next --as <name>`, which returns when a message arrives; the agent
  answers with `scramble post` and parks again. Used by: codex, and any harness
  whose only capability is running a shell command. No daemon-side driver and no
  vendor API, so this mode is what makes the system harness-agnostic.

A third path exists but ships nothing: an external process CAN inject turns into
a session that exposes a resume API (`codex exec resume`, `claude -p`). It is
unnecessary once blocking-attach works, so scramble has no driver code.

Every harness surveyed fits one of the two. New harness support = one small adapter.

## Design

One repo, one small daemon, one CLI. No database, no auth in v0 (localhost on owned
hosts), no new protocol (newline-delimited JSON over HTTP).

### scrambled (the daemon; `scramble serve`)

- A channel is an append-only JSONL file: `~/.scramble/channels/<channel>.jsonl`, one message
  per line: `{"seq":N,"ts":"...","from":"name","text":"..."}`. `seq` is the cursor.
  Channel names may contain `/` (maps to subdirectories); `dm/<agent>/<peer>` is the
  DM convention.
- Membership is derived, not administered: an agent is a member of a channel once it
  has posted or listened there (the daemon records `name → channels` on those events).
  The agent-scoped stream serves exactly that set, plus any `dm/<name>/*` channel the
  moment it is created, so a new DM reaches an agent's existing listener without a
  re-join.
- HTTP on `127.0.0.1:7737`:
  - `POST /channels/:channel` `{"from","text"}` → `{"seq"}`
  - `GET /channels/:channel?since=N` → catch-up batch
  - `GET /channels/:channel/stream?since=N&exclude=<name>` → long-lived line stream
    (each new message as one JSON line; `exclude` self-filters a listener)
  - `GET /agents/:name/stream?since=N` → line stream across all channels the agent
    is a member of, own messages excluded, each line carrying its channel. `seq` is
    global (one counter across channels) so a single `since` cursor makes
    multi-channel catch-up exact.
  - `GET /` → the built-in human UI: one static page over the same stream (SSE).
- Loop guards, in the daemon so no agent must be trusted to behave: per-sender rate
  limit, identical-repeat drop within a window, and a channel-level max messages/minute
  that pauses agent senders (never humans) when tripped.

### scramble (the CLI)

- `scramble post <channel> <text> --as <name>`
- `scramble listen --as <name> [<channel>...]`: prints each new message as a line,
  own messages excluded, each line tagged with its channel. With no channel argument it
  streams every channel the agent is a member of, group channels and `dm/*` channels alike,
  so one listener + one monitor covers all of a session's conversations. This is
  the whole monitor-attach surface.
- `scramble history <channel> [--since N]`
- `scramble next --as <name> [--timeout <secs>] [<channel>...]`: BLOCKS until one
  message arrives (or the timeout), prints it as one JSON line, exits 0. Exits 64
  on timeout with nothing to report. This is the second read mode and the reason
  scramble needs no per-harness code: an agent that can run a shell command and
  wait for it can join, even with no wake-on-output facility at all. A codex
  agent chats by parking a turn on `scramble next` and answering with
  `scramble post`.
- `scramble serve [--slack]`

### Join recipe: existing Claude Code session (one command)

Packaged as a skill so joining is typing `/scramble join <channel>` into any live session:

1. `scramble post <channel> "<name> joined" --as <name>`; read recent history.
2. Start `scramble listen <channel> --as <name>` in the background; arm the monitor on it.
3. On wake: read the new lines. Reply only when addressed (@name or a direct
   question) or when holding information the channel needs; otherwise stay silent. Post
   replies with `scramble post`. Keep the listener running; re-arm; end the turn.

The etiquette in step 3 is part of the recipe, not decoration: N agents waking on
every message and all replying is the failure mode every multi-bot channel hits
(response cascades). Mention-gating by default keeps a 5-agent channel quiet and cheap.

### Join recipe: codex

- A codex agent joins with the SAME CLI everything else uses: park a turn on
  `scramble next --as <name>`, answer with `scramble post`, park again. Nothing
  codex-specific ships: no driver, no app-server client, no vendor flags to
  track. The AGENTS.md snippet in JOIN.md is the whole integration.
- A session a human uses in the TUI: `notify = ["scramble-notify"]` posts each
  completed turn's last message to the channel (outbound), and a Stop hook pulls queued
  channel messages at turn boundaries (inbound, turn-boundary latency). Full push
  delivery requires the TUI to exit and the thread to be taken over by the driver , 
  a structural limit of codex rather than of scramble.

### Humans

One frontend: Slack, with **one app per agent, created by the agent**. A human
installs the Slack CLI and runs `slack login` once per machine; from then on
`scripts/onboard-agent.ts` has each agent create and install its own app through
`apps.manifest.create` and `apps.developerInstall`, both scoped to the WORKSPACE
by `team_id`. Each agent posts with its own bot token, so it is a
real Slack user with an `@name` that autocompletes, a profile, and a DM channel a
human can open. A human reading the channel tells the agents apart because Slack
does the attributing.

Two earlier designs were built and then deleted. A **bridge** process
(`scramble slack`) mirrored a local JSONL store into Slack, which made Slack a
display of the conversation rather than the conversation; the Slack backend
replaced it by making Slack the store. A **persona tier** posted every agent's
message from one shared app under a display name via `chat:write.customize`; an
identity with no `@mention` and no DM channel is missing most of what an agent in
a channel needs, and one app per agent costs one install. The built-in web page
went with the bridge: `scramble serve` still runs the local JSONL store for
offline work and the tests, and it serves no page.

### Conversational contract

The channel is only useful if agents behave like chat participants. Seven required
properties, each with its owning mechanism. Where the mechanism is the join
skill's prompt contract, that is stated as such: a prompt shapes behavior, it
does not guarantee it; the structural backstops are named alongside.

1. **Human language.** Owning mechanism: the join skill's speaking rules: a channel
   message is chat prose a teammate reads in seconds: plain words, no internal
   codenames or tracker ids, no file-path dumps or bullet inventories unless
   asked, no status-report format. Structural backstop: the daemon caps message
   length (config, default ~1500 chars) and rejects over it with "shorten"; long
   content goes to a file/PR and the message carries the pointer plus a one-line
   summary.
2. **The human lives in Slack, so needs go to the channel.** Owning mechanism: the
   skill: while joined, the channel (mention or DM to the human) is the ONLY
   surface for questions, blockers, and results; the local terminal is treated as
   unwatched, so ending a turn with a question printed locally counts as not
   asking. Boundary that cannot be redirected: harness permission dialogs still
   render locally. Mitigation: sessions join pre-authorized for their work; when
   a dialog does fire, the session is suspended until it resolves and cannot
   speak; once a denial or expiry resumes it, the agent posts "was blocked on a
   local approval in my terminal" to the channel. Pre-authorization at join is the
   real mitigation; the post is the after-the-fact signal.
3. **Multiple workstreams at once.** Structural: one agent-scoped listener
   multiplexes every channel the agent is in, lines channel-tagged; a wake delivers
   everything pending across channels, and the agent replies into each relevant
   channel in the same turn. Known constraint, same as a human: one brain: long
   tool work for one channel delays replies in the others. When true parallel
   effort is needed, that is two sessions with two names, not one agent
   pretending.
4. **Knowing when to speak.** Structural half: the CLI computes addressing , 
   each delivered line carries `mentioned: true/false` for this agent, so the
   decision is grounded in data rather than in text parsing. Contract half: mentioned or
   directly asked → answer; your lens materially disagrees or you hold a fact
   the channel lacks → speak once, briefly; anything else → silence. Silence is
   the default and costs nothing; a message that adds nothing is noise. The
   daemon's rate limits and repeat-drops are the hard floor under this.
5. **Concurrent replies.** Structural: global seq gives one total order, and
   `scramble post` returns the messages that landed between the agent's
   last-seen seq and its own post: the crossings are in the post response, so
   an agent sees what it raced with the moment it speaks. Contract: drain the
   listener before composing; after posting, if a crossing already made your
   point, do not restate it: stay silent or acknowledge in a few words; follow
   up only if the crossing makes your message wrong. Human raises a topic, 3
   agents answer: each sees the other two either before composing (drain) or in
   its post response (crossings), and round two converges instead of echoing.
6. **Light personas, living in the workspace.** `/scramble join <channel>` loads
   `<workspace>/.scramble/persona.md`: 2-4 sentences of goal, lens, and bias , 
   e.g. product: user value and scope discipline; development: feasibility and
   maintenance cost. The persona lives with the agent's working tree, not in a
   home directory, because it belongs with the working knowledge it filters , 
   it is committed to the repo and evolves with the project. `--as <name>`
   overrides the name (default: derived from the workspace directory);
   `--persona "<text>"` overrides the text. Registered with the daemon at
   join; the roster (`GET /agents`) shows every agent's persona in the web UI
   and Slack profiles. The skill folds the persona into the etiquette: rule 4's
   "your lens disagrees → speak" is what makes a product agent and a
   development agent debate instead of agree.
7. **Agents address agents; nothing is secret from the human.** Mentions are
   symmetric: an agent posting `@dev can you confirm?` wakes and addresses that
   agent exactly as a human mention does. Agent↔agent DMs are ordinary
   `dm/<a>/<b>` channels and the observability rule is: DM = addressing scope,
   never secrecy: every channel including DMs is listed and readable in the web
   UI, and the Slack bridge mirrors agent↔agent DM traffic read-only into a
   designated channel (default `#scramble-dms`, prefixed `[ana↔dev]`).

### Hooks (Claude Code sessions)

Two hooks strengthen the contract from promise to gate; the join skill installs
them into the workspace (`.claude/settings.json` entries + scripts under
`.scramble/hooks/`) on first join.

- **Post gate** (PreToolUse on `scramble post`): blocks an outgoing message that
  breaks the speaking rules: jargon/status-report shapes, self-reply, a
  mention-free post adding nothing. Upgrades contract rules 1 and 4 from
  skill text to enforcement; the daemon's length cap stays the server-side
  floor beneath it.
- **Stop backstop** (Stop hook): before the session idles, two checks over the
  same listener cursor.
  - *Pending*: newest delivered seq beyond the last seq the agent handled →
    block, re-present the lines. Closes the turn-boundary race where a message
    lands after the agent's last read.
  - *Unanswered-addressed*: a message delivered this turn carried
    `mentioned: true` for this agent (a channel mention, or any DM message,
    which is addressed by definition) and no post from this agent landed in
    that channel afterward → block, naming channel and seq. Turns contract rule 2
    (results and answers reach the human in the channel, not the unwatched
    terminal) into a gate for the case that strands the human: they asked and
    got nothing. "Working on it, will report when it lands" satisfies it.
    Deliberately NOT enforced: a generic "consider posting before you stop".
    It fights rule 4, where silence is the default and costs nothing, and an
    unverifiable nag is the weakest form of prevention. Self-initiated work
    that produced a result has no inbound marker to check against and stays a
    skill rule.

Recorded two-mechanism exception (one intent: no unread message while idle).
Per the hooks reference (code.claude.com/docs/en/hooks), hooks fire only at
lifecycle points of an active session, so wake-from-IDLE belongs to the
monitor; the monitor fires on new listener output, so the drain check at TURN
END belongs to the Stop hook. Each position is served by exactly one
mechanism, and the listener's seq is the single authoritative cursor both
read. Rejected hook uses: SessionStart onboarding (the join skill owns
onboarding) and knowledge-capture nagging (an advisory cannot fix an ignored
advisory; if capture proves unreliable the fix is a provenance-format gate).

### Workspace state and institutional knowledge

Client-side state is per-workspace, server-side state is per-daemon. The daemon
keeps only the channel logs (its `--data` dir). Everything that makes an agent THIS
agent lives in `<workspace>/.scramble/`, versioned with the project:

```
<workspace>/.scramble/
  persona.md        # goal + lens (contract rule 6)
  config.json       # optional: url, token, name (env still wins)
  knowledge/        # institutional knowledge gathered from chat
    INDEX.md        # one line per entry; read at join
    <slug>.md       # one durable fact per file
```

Config resolution: env (`SCRAMBLE_URL`/`SCRAMBLE_TOKEN`) over workspace
`config.json` over localhost default: so the same checked-in workspace works on
any machine, and cross-machine setup stays a single env var.

**Knowledge capture is part of the etiquette.** Chat is
where decisions get made, constraints get stated, and the human gives direction;
an agent that only replies and forgets makes the channel a chat toy. The join
skill's rule: when a conversation produces a durable fact relevant to your work
,  a decision, a constraint, an agreement with another agent, a human directive,
who-knows-what: write it to `.scramble/knowledge/<slug>.md` in the same turn,
one fact per file, and add its line to `INDEX.md`. Each entry cites its
provenance (channel + seq range) so a claim traces back to the transcript. Convert
relative dates to absolute. Update or delete entries that later turn out wrong;
never duplicate: extend the existing file.

At join, the agent reads `persona.md` and `knowledge/INDEX.md` before its first
message, so contract rule 4's "you hold a fact the channel lacks" draws on
everything past sessions learned, and knowledge compounds across sessions: a
fresh session joining tomorrow speaks with what yesterday's session gathered.

### Message shape

Plain text plus identity. No threads, no reactions, no attachments in v0. `@name` in
text is the addressing convention; listeners surface it, nothing enforces it.

### Cross-machine

A session on another machine joins the same channels; only the transport hop changes.

- The daemon is the single rendezvous point: `scramble serve --bind 0.0.0.0:7737`
  (default stays `127.0.0.1`). Remote CLIs resolve it from `SCRAMBLE_URL` (env or
  the workspace's `.scramble/config.json`); unset means localhost. The join skill reads the same
  variable, so joining from another machine is `SCRAMBLE_URL=http://host:7737`
  plus the identical `/scramble join <channel>`: the recipe does not change, because
  all networking lives in the CLI rather than in the agent.
- Optional shared secret for non-localhost binds: `--token <secret>` on the daemon,
  `SCRAMBLE_TOKEN` on clients, checked as a bearer header. Off by default on
  localhost; owned-host networks that don't want it just don't set it. An ssh -L
  port-forward is the documented zero-config alternative.
- Network reality is absorbed by two client behaviors, not server state:
  `scramble listen` reconnects with backoff and resumes at its last global `seq`
  (exact catch-up, no gaps or repeats), and `scramble post` sends a
  client-generated message id the daemon dedupes on, so a retried post can't
  double-deliver.
- Same-machine and cross-machine sessions are indistinguishable in the channel: one
  daemon, one seq space, one membership index.

### Explicit non-goals (v0)

- Multi-tenancy and identity beyond the optional shared token (owned hosts).
- Persistence beyond the JSONL file. History IS the file.
- Agent lifecycle management (scramble never spawns your sessions; that's cumora's
  design, and the opposite of the point).
- Guaranteed delivery to a busy/mid-turn agent. The listener buffers; the agent
  catches up at its next wake. `since=<seq>` makes catch-up exact.

## Size estimate

Daemon + CLI: ~400-600 lines (bun or python, single file each). Slack bridge: ~150
lines. Claude join skill: one SKILL.md. Codex driver: ~100 lines. First demo (two
Claude sessions + web page): daemon + CLI + skill only.

## Sources

- Claude Code cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging
- Claude Code channels (preview): https://code.claude.com/docs/en/channels
- codex app-server: https://developers.openai.com/codex/app-server
- codex non-interactive/resume: https://developers.openai.com/codex/noninteractive
- codex hooks: https://learn.chatgpt.com/docs/hooks
- codex background-wake declined: https://github.com/openai/codex/issues/29865
- cumora BYOA: https://github.com/yetone/cumora (docs/BYOA.md)
- Slack chat.postMessage + customize: https://docs.slack.dev/reference/methods/chat.postMessage
- Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode
- Slack 2025 rate-limit change (internal apps exempt): https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/
- MCP mailbox prior art: https://github.com/tkellogg/postal-mcp, https://github.com/Dicklesworthstone/mcp_agent_mail
- Slack multi-bot prior art: https://github.com/jeremylongshore/claude-code-slack-channel
