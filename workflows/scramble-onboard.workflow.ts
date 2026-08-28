export const meta = {
  name: 'scramble-onboard',
  description: 'Make JOIN.md the ONE agent-facing onboarding doc, and have join print where to look next',
  phases: [{ title: 'onboard' }],
}

phase('onboard')
const out = await agent(`You are improving onboarding in "scramble", the repo you are
running in. Read DESIGN.md, PLAN.md ("The CLI contract", "Coverage rules"), JOIN.md,
README.md and skills/scramble/SKILL.md first.

THE PROBLEM: an agent that wants to join has to assemble three documents. README.md
holds how to get the CLI, JOIN.md holds the join procedure but assumes the binary
already exists and never says how to check the daemon is reachable, and
skills/scramble/CONTRACT.md holds the rules. There is no single entry point, so
"here is the one file, read it and join" cannot be said today.

DELIVER, without duplicating anything (the single-source rule in DESIGN.md is
binding — CONTRACT.md stays the ONLY copy of the seven conversational rules, and
you must not restate the CLI contract table that lives in PLAN.md):

1. JOIN.md becomes the ONE agent-facing onboarding document, self-sufficient from
   nothing installed to conversing. Add, ahead of the existing steps, a short
   numbered "get the CLI and reach the daemon" section:
     - install: from the repo, \`bun install && bun link\` puts \`scramble\` on PATH
       (the bin entry is src/bin.ts). Note the alternative for an agent that
       cannot install globally: run it in place with \`bun /path/to/repo/src/bin.ts <verb>\`.
     - reach the daemon: unset env means http://127.0.0.1:7737; otherwise
       SCRAMBLE_URL / SCRAMBLE_TOKEN, or --url/--token per command.
     - VERIFY before joining, with a command whose output proves it:
       \`scramble history <room>\` (or a GET of the rooms listing) — if that fails,
       the daemon is not up or not reachable, and joining will not help. Say what
       the failure means.
   Keep the rest of JOIN.md's flow (persona + knowledge index, catch up, attach,
   etiquette, wrappers). Keep it SHORT — trim any sentence that the new section
   or CONTRACT.md already covers. It must stay readable in one sitting.
2. README.md and skills/scramble/SKILL.md each get ONE line at the top naming
   JOIN.md as the single agent onboarding doc ("an agent joining a room needs
   only JOIN.md"). Do not move operator material (serve, Slack, cross-machine)
   out of README.md, and do not copy JOIN.md's content into either file.
3. \`scramble join\` prints, to STDERR (stdout stays JSON-only per the CLI
   contract), a two-line pointer after a successful join: the path to JOIN.md
   for the procedure and the path to skills/scramble/CONTRACT.md for the rules,
   so an agent that ran join is told where to look without hunting. Cover the new
   behavior with a test asserting the pointer goes to stderr and that stdout is
   unchanged.

INVARIANTS: TypeScript on bun, strict, zero runtime dependencies, no vendor named
in src/. Touch ONLY JOIN.md, README.md, skills/scramble/SKILL.md, src/cli.ts and
its tests. The FULL gate must be green — run \`bash scripts/gate.sh\` and paste its
summary lines (self_test_rc, tsc_rc, test_rc) plus the coverage table in your
report. GATE GREEN at 100% coverage is the definition of done.`)
return { out }
