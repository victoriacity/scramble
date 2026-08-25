// THE SUITE RUNS WITH THE REWRITE OFF, whatever the machine holds.
//
// bun loads `.env` from the project directory into every process it starts, so
// the moment a key was placed in this checkout the test runner inherited it, the
// e2e tests sent their fixtures through a live model, and one of them asserted
// on `@beta hi from ana` while the channel held `@beta Ana is reaching out to
// you.` (2026-08-25).
//
// A test that reads a credential from the machine it runs on is a test whose
// result depends on who is running it.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("SCRAMBLE_REWRITE_")) delete process.env[name];
}
