export const meta = {
  name: 'scramble-local-peers',
  description: 'Several agents in one directory: distinct identities, per-agent personas, and peer discovery',
  phases: [{ title: 'peers' }],
}

phase('peers')
const out = await agent(`You are fixing identity for SEVERAL AGENTS SHARING ONE WORKING
DIRECTORY in "scramble", the repo you are running in. Read src/cli.ts (especially
defaultName, nameFor, the join and profile verbs), src/types.ts and
skills/scramble/SKILL.md first.

THREE FACTS, verified in the code today:
1. \`defaultName()\` returns \`basename(cwd)\`, so two agents started in the same directory
   take the SAME name unless each passes --as. Identity collides silently: both post as
   the directory, and each one's messages look like the other's.
2. \`.scramble/persona.md\` is one file per directory, so two agents share one lens.
3. Nothing records where an agent runs. The store keeps no directory and no pid, so no
   agent can find out who else is working beside it.

All three are client-side, so the fix works the same under the local, slack and raft
backends.

DELIVER:

1. A LOCAL AGENT REGISTRY. On \`join\` (and on \`channel join\`), write
   \`.scramble/agents/<name>.json\` holding: name, pid, the backend in use, the channels
   joined, and an ISO start time. Rewrite it on each join by the same name. Nothing else
   in the product may depend on this file being present, since an agent may be started
   without join.

2. \`scramble agents\` (new verb, mirroring nothing in raft because raft has no
   equivalent): print one JSON line per LIVE peer in this directory, own entry included
   and marked \`self: true\`. Liveness is a pid check through an injected seam, the same
   \`alive\` seam the bridge lock used. A dead entry is PRUNED from disk when it is
   noticed, so the listing never reports a peer that exited.

3. MAKE THE COLLISION NON-CONSTRUCTIBLE. When \`--as\` is absent and the directory name is
   already held by a LIVE peer, derive \`<dir>-2\`, \`<dir>-3\` and so on, taking the first
   free one, and print the chosen name to stderr so the operator sees which identity this
   session took. Never silently reuse a live peer's name.

4. PER-AGENT PERSONA. \`.scramble/persona.<name>.md\` wins over \`.scramble/persona.md\`,
   which stays the shared default. \`profile update --description\` writes the per-agent
   file when the agent has a name that differs from the directory default, so two agents
   in one directory stop overwriting each other's lens.

5. skills/scramble/SKILL.md: a short section for this case. Reading it, an agent learns
   to pass --as when peers share the directory, to read its own persona file, and to run
   \`scramble agents\` to see who else is here. Re-lint with
   \`python3 skills/scramble/lint_language.py skills/scramble/SKILL.md\` until 0 hits.

TESTS, behavioral, with pid liveness injected so nothing depends on real processes:
- two joins in one directory with no --as take distinct names, the second reporting the
  derived one;
- a name whose registry entry has a DEAD pid is reused rather than suffixed, and the
  stale file is pruned;
- \`agents\` lists live peers with self marked, and omits a peer whose pid is gone;
- \`persona.<name>.md\` wins over \`persona.md\`, and \`profile update\` writes the
  per-agent file for a non-default name;
- an agent that never joined still posts and reads normally, with no registry present.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Do not change the
message line shape. The FULL gate must be green: run \`bash scripts/gate.sh\` and paste its
summary lines plus the coverage table. GATE GREEN at 100% coverage is the definition of
done.`)
return { out }
