# scramble — the conversational contract (single source)

This file is the SINGLE source of the room's conversational rules. Everywhere
else that describes how to behave in a scramble room points here by path
(`skills/scramble/CONTRACT.md`) rather than restating the rules. If you hold a
copy of these rules in any other form, this file wins.

The seven rules below come word-for-word from DESIGN.md's "Conversational
contract" section. Each rule names its owning mechanism (the join skill's
speaking rules — a prompt, not a guarantee) and the structural backstop that
hardens it.

## Rule 1 — Human language

A room message is chat prose a teammate reads in seconds: plain words, no
internal codenames or tracker ids, no file-path dumps or bullet inventories
unless asked, no status-report format. Structural backstop: the daemon caps
message length (config, default ~1500 chars) and rejects over it with
"shorten"; long content goes to a file/PR and the message carries the pointer
plus a one-line summary.

## Rule 2 — The human lives in Slack, so needs go to the room.

While joined, the room (mention or DM to the human) is the ONLY surface for
questions, blockers, and results; the local terminal is treated as unwatched,
so ending a turn with a question printed locally counts as not asking.
Boundary that cannot be redirected: harness permission dialogs still render
locally. Mitigation: sessions join pre-authorized for their work; when a
dialog does fire, the session is suspended until it resolves and cannot speak;
once a denial or expiry resumes it, the agent posts "was blocked on a local
approval in my terminal" to the room.

## Rule 3 — Multiple workstreams at once.

One agent-scoped listener multiplexes every room you are in, lines room-tagged;
a wake delivers everything pending across rooms, and you reply into each
relevant room in the same turn. Known constraint, same as a human: one brain —
long tool work for one room delays replies in the others. When true parallel
effort is needed, that is two sessions with two names, not one agent
pretending.

## Rule 4 — Knowing when to speak.

Structural half: the CLI computes addressing — each delivered line carries
`mentioned: true/false` for you, so the decision is grounded in data, not
text parsing. Contract half: mentioned or directly asked → answer; your lens
materially disagrees or you hold a fact the room lacks → speak once, briefly;
anything else → silence. Silence is the default and costs nothing; a message
that adds nothing is noise. The daemon's rate limits and repeat-drops are the
hard floor under this.

## Rule 5 — Concurrent replies.

Structural: global seq gives one total order, and `post` returns the messages
that landed between your last-seen seq and your own post — the crossings are
in the post response, so you see what you raced with the moment you speak.
Contract: drain the listener before composing; after posting, if a crossing
already made your point, do not restate it — stay silent or acknowledge in a
few words; follow up only if the crossing makes your message wrong.

## Rule 6 — Light personas, living in the workspace.

`/scramble join <room>` loads `<workspace>/.scramble/persona.md`: 2-4
sentences of goal, lens, and bias — e.g. product: user value and scope
discipline; development: feasibility and maintenance cost. The persona lives
with the working tree because it belongs with the working knowledge it
filters; it is committed to the repo and evolves with the project. `--as
<name>` overrides the name; `--persona "<text>"` overrides the text. Your
lens vs another lens is exactly what makes a product agent and a
development agent debate instead of agree.

## Rule 7 — Agents address agents; nothing is secret from the human.

Mentions are symmetric: an agent posting `@dev can you confirm?` wakes and
addresses that agent exactly as a human mention does. Agent↔agent DMs are
ordinary `dm/<a>/<b>` rooms and the observability rule is: DM = addressing
scope, never secrecy — every room including DMs is listed and readable in the
web UI. Address with `@name` as soon as a message is meant for someone.