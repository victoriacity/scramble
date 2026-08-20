export const meta = {
  name: 'scramble-bindfix',
  description: 'Fix serve --bind host:port and add the end-to-end smoke that would have caught it',
  phases: [{ title: 'bindfix' }],
}

phase('bindfix')
const out = await agent(`You are fixing a CONFIRMED defect in "scramble", the repo you are
running in. Read DESIGN.md and PLAN.md ("The CLI contract", "Coverage rules") first.

THE DEFECT, reproduced from the real binary this turn:

  $ bun src/bin.ts serve --bind 127.0.0.1:7799 --data /tmp/x
  error: Failed to start server. Is port 7737 in use?  (EADDRINUSE)

Nothing was listening on 7737. Root cause: \`serve()\` in src/server.ts:239 uses
\`hostname: opts.bind ?? "127.0.0.1"\` and \`port: opts.port ?? DEFAULTS.port\`, and
cmdServe in src/cli.ts passes the whole \`--bind\` string as \`opts.bind\`. So
"127.0.0.1:7799" became the HOSTNAME, the port stayed 7737, and \`serve --bind\`
cannot start at all. 132 tests pass over this: they call createHandler directly
and never exercise the wiring, and src/bin.ts is excluded from coverage by design.

DELIVER BOTH:

1. THE FIX. \`--bind\` accepts "host:port", a bare port ("7799"), and a bare host
   ("0.0.0.0"). ONE place interprets the string — the CLI owns flag parsing, so
   parse it there into a typed hostname + port and keep src/server.ts's serve()
   taking typed fields. Do not add a second interpretation site. Unit-test the
   parse: host:port, bare port, bare host, and a malformed value (which must be
   REPORTED, not silently defaulted).

2. THE STRUCTURAL FIX — test/e2e.test.ts, an end-to-end smoke that runs the REAL
   entrypoint the way an operator does, so the whole class (bin.ts wiring that
   unit tests cannot see) is covered from now on. Spawn \`bun src/bin.ts serve\`
   with a --bind on an EPHEMERAL port and a temp --data dir, wait for it to
   accept connections (poll, do not sleep blindly), then drive the real CLI
   against it as child processes and assert:
     - \`join\` registers a name+persona that GET /agents reports;
     - \`post\` computes mentions, and a second poster's crossings include the
       first message;
     - \`next --as <name> --timeout N\` returns the pending message and exits 0,
       and exits 64 when nothing arrives before the timeout;
     - \`listen\` prints a message posted WHILE it is streaming;
     - GET / serves the web page;
     - the --bind port from the defect above is the port actually listened on.
   Kill the daemon in a finally/afterAll so no process leaks. A spawned
   process's files are not counted by bun's coverage, so this test must not
   lower the 100% numbers.

INVARIANTS: TypeScript on bun, strict, zero runtime dependencies, no vendor named
in src/. Touch ONLY src/cli.ts, src/server.ts, src/bin.ts (if needed),
test/cli.test.ts, test/server.test.ts and the new test/e2e.test.ts. The FULL gate
must be green when you are done — run \`bash scripts/gate.sh\` and paste its
summary lines (self_test_rc, tsc_rc, test_rc, and the coverage table) in your
report. GATE GREEN with 100% coverage is the definition of done here.`)
return { out }
