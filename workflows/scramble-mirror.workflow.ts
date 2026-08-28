export const meta = {
  name: 'scramble-raft-mirror',
  description: 'Mirror raft CLI grammar in scramble so an agent learns one command set',
  phases: [{ title: 'mirror' }],
}

phase('mirror')
const out = await agent(`You are making "scramble" speak the SAME command grammar as the
raft CLI, so an agent that learned one knows the other. Read PLAN.md's section "The
raft-mirrored surface (one grammar for both tools)" first: it is the authoritative
mapping table and the three differences that stay. Also read src/cli.ts, src/raft.ts,
skills/scramble/SKILL.md and PLAN.md's "The CLI contract".

WHY: agents on this host already learn raft's grammar from a global skill. Two grammars
for one job is a tax paid on every session. The mapping is nearly one to one, so the
mirrored verbs are a parsing change, not a new feature.

DELIVER, in src/cli.ts (keep every existing verb working as an alias, and keep the
stdout contract of one JSON line per message):

1. \`scramble message send --target '<room>'\` reading the message from STDIN, matching
   \`raft message send\`. Keep \`scramble post <room> <text>\` as the alias.
2. \`scramble message check\` — drain what is pending for this agent and advance a
   cursor, matching \`raft message check\`. scramble's store keeps no per-agent delivery
   cursor, so hold it client-side in \`.scramble/cursor.json\` keyed by agent name, read
   it on entry, write the highest seq drained on exit. Non-blocking: print what is
   pending and exit 0, print nothing and exit 0 when nothing is pending.
3. \`scramble message read --target '<room>' [--after N]\` matching
   \`raft message read\`. Keep \`scramble history <room> --since N\` as the alias, and let
   the mirrored verb accept both \`--after\` and \`--since\`.
4. \`scramble profile show\` printing this agent's name and persona, and
   \`scramble profile update --description "<text>"\` writing
   \`.scramble/persona.md\` and registering it, matching \`raft profile\`.
5. \`scramble channel join --target '<room>'\` matching \`raft channel join\`, with
   \`scramble join <room>\` kept as the alias.

RULES:
- \`--target\` takes a room name with NO leading '#'. A scramble room may contain '/'
  (that is how dm/<a>/<b> works), so a sigil would be ambiguous. Reject a target that
  starts with '#' and say why.
- Every mirrored verb works under all three backends (local, slack, raft) exactly as its
  alias does, since the backend switch sits below the verb parsing.
- An unknown verb or a missing --target REPORTS what it saw and exits nonzero.

Then update skills/scramble/SKILL.md to teach the mirrored grammar as primary, keeping
the aliases in one short table, and re-lint it with
\`python3 skills/scramble/lint_language.py skills/scramble/SKILL.md\` until it reports 0
hits. The skill's language rules apply to the skill itself.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Do not change the line
format the hooks read. The FULL gate must be green: run \`bash scripts/gate.sh\` and paste
its summary lines plus the coverage table. GATE GREEN at 100% coverage is done.`)
return { out }
