export const meta = {
  name: 'scramble-raft-backend',
  description: 'scramble becomes the skill layer over raft: a raft backend behind the same two verbs',
  phases: [{ title: 'raft' }],
}

phase('raft')
const out = await agent(`You are adding a RAFT BACKEND to "scramble", the repo you are
running in. Read DESIGN.md, PLAN.md ("The CLI contract", "Coverage rules"), src/cli.ts
and src/types.ts first.

THE DIRECTION (from the operator): raft becomes the transport and scramble becomes the
light skill layer between a custom agent and raft. The join recipe (JOIN.md), the
conversational rules (skills/scramble/CONTRACT.md) and the two hooks must keep working
UNCHANGED against either transport. That is the whole point of the design: the agent's
commands and etiquette stay the same; only the backend differs.

THE RAFT CLI IS INSTALLED. Facts verified this session with --help (do not re-derive,
and do not invent flags):
- binary: raft, version 0.0.17, needs node >= 20 (present at /opt/akari/node24/bin).
- credential: \`raft --profile <slug> <verb>\` (or RAFT_PROFILE=<slug>) selects a saved
  profile; profiles are created by \`raft agent login\` (device-code, human-approved).
- POST:  \`raft message send --target '#channel'\` with the message piped on STDIN.
  --content is explicitly unsupported ("Pipe message content to stdin instead").
  Targets: '#channel', 'dm:@peer', '#channel:threadId', 'dm:@peer:threadId'.
- READ:  \`raft message check\` — "Drain the agent inbox (non-blocking). Acks delivered
  seqs before returning." It is AGENT-SCOPED (all targets), takes no flags, and there
  is NO blocking read command.
- history: \`raft message read\`, search: \`raft message search\`, join: \`raft channel\`.

DELIVER:

1. src/raft.ts — the raft backend, with the process seam INJECTED (a run(cmd, args,
   stdin) function) so tests pass a fake and need no raft binary, no network, and no
   credential. Implement, against the same shapes in src/types.ts that the local
   backend uses:
   - post(room, text): maps a scramble room name to a raft target ('#room', and a
     scramble 'dm/<a>/<b>' room to 'dm:@peer'), pipes the text on stdin, and surfaces a
     non-zero exit or an error payload as a FAILURE with what raft printed. Never
     swallow it.
   - drain(): runs \`raft message check\` and parses its output into the same
     one-JSON-line-per-message Delivery shape the local backend emits, including a
     \`mentioned\` flag computed for this agent and the room the message came from.
     Parse defensively: raft's output shape is not in our contract, so a line that does
     not parse is REPORTED, not dropped.
   - next(timeoutSecs): the blocking read scramble's contract promises, built on the
     non-blocking drain: poll drain() on an interval until a message arrives or the
     timeout expires (exit 64 semantics preserved). Make the interval and the clock
     injectable so tests run instantly.

2. Wire it behind the EXISTING verbs in src/cli.ts, selected by one switch:
   \`SCRAMBLE_BACKEND=raft\` (env) or \`--backend raft\`, defaulting to the local
   daemon backend so nothing currently working changes. \`post\`, \`next\`, \`listen\`
   and \`history\` must behave identically from the agent's point of view under either
   backend — same stdout line format, same exit codes. \`listen\` under the raft backend
   is the poll loop emitting lines as they arrive.

3. Tests: test/raft.test.ts covering both backends' equivalence — the same sequence of
   fake transport responses produces the same stdout lines and exit codes as the local
   backend does for the same conversation. Include: a post that maps a dm/ room to a
   dm: target, a failure exit surfaced rather than swallowed, an unparseable line
   reported, next() returning on the first message, and next() hitting the timeout with
   exit 64.

4. Update JOIN.md with a SHORT "raft transport" note: same commands, add
   \`SCRAMBLE_BACKEND=raft\` and a profile via \`raft agent login\`; state that the
   room's rules and the hooks are unchanged. Do not restate the CLI contract table or
   the conversational rules (single-source rule).

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies (shell out to the raft
binary; do not import any raft package). Nothing in src/ names an agent vendor. The FULL
gate must be green: run \`bash scripts/gate.sh\` and paste its summary lines plus the
coverage table in your report. GATE GREEN at 100% coverage is the definition of done.`)
return { out }
