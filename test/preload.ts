// The suite runs with rewriting disabled, regardless of what the machine holds.
//
// `bun` loads `.env` from the project directory into every process it starts.
// Because a key was placed in this checkout, the test runner inherited it, the
// end-to-end tests sent their fixtures through a live model, and one test
// asserted on `@beta hi from ana` while the channel held
// `@beta Ana is reaching out to you.`.
//
// A test that reads a credential from the machine it runs on produces a result
// that depends on who runs it.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("SCRAMBLE_REWRITE_")) delete process.env[name];
}

