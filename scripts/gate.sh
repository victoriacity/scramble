#!/usr/bin/env bash
# The merge gate: the coverage threshold is proven to BITE, then types clean,
# every test green, coverage at 100%.
# No pipes through tail/head/grep -- an exit code masked by a pipe is a lie.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

# bun resolution, widest first. An akari worker runs with a different HOME than
# the lead (uid 0, full rootfs), so $HOME/.bun is not a safe single answer; the
# last candidate is this host's install path. On failure print EVERY candidate
# tried, not a summary.
BUN=""
for cand in "$(command -v bun 2>/dev/null)" "$HOME/.bun/bin/bun" \
            /home/agent/.bun/bin/bun /usr/local/bin/bun; do
  [ -n "$cand" ] && [ -x "$cand" ] && { BUN="$cand"; break; }
done
[ -n "$BUN" ] || {
  echo "GATE FAIL: bun not found. Tried, in order:"
  echo "  command -v bun -> $(command -v bun 2>/dev/null || echo '<none>')"
  echo "  \$HOME/.bun/bin/bun -> $HOME/.bun/bin/bun"
  echo "  /home/agent/.bun/bin/bun"
  echo "  /usr/local/bin/bun"
  exit 1
}

# == stage 0: COVERAGE-GATE SELF-TEST ==
# A coverage threshold is a claim about bun's behavior, and a config key bun
# ignores produces no error anywhere -- the only observable difference is an exit
# code. bun 1.3.14 silently ignores `coverageThreshold` written as an inline
# table and exits 0 at partial coverage, so this gate once reported green over
# 57% coverage (postmortem:
# akrust log/postmortems/2026-08-20-coverage-gate-was-decorative-ignored-threshold.md).
# Before trusting a single number below, run the REPO'S OWN bunfig against a
# fixture with a deliberately untested branch and require it to FAIL.
SELF="$(mktemp -d)"
trap 'rm -rf "$SELF"' EXIT
mkdir -p "$SELF/src" "$SELF/test"
cp "$REPO/bunfig.toml" "$SELF/bunfig.toml"
cat > "$SELF/src/probe.ts" <<'PROBE'
export function branchy(n: number): string {
  if (n > 0) {
    return "pos";
  }
  const s = "neg";
  return s;
}
PROBE
cat > "$SELF/test/probe.test.ts" <<'PROBETEST'
import { expect, test } from "bun:test";
import { branchy } from "../src/probe";
test("covers only the positive branch, on purpose", () => {
  expect(branchy(1)).toBe("pos");
});
PROBETEST
echo "== gate self-test: the coverage threshold must FAIL a partial fixture =="
( cd "$SELF" && "$BUN" test --coverage >/dev/null 2>&1 )
self_rc=$?
if [ "$self_rc" -eq 0 ]; then
  echo "GATE SELF-TEST FAILED: the coverage threshold in $REPO/bunfig.toml is NOT enforced."
  echo "A fixture with an untested branch passed (rc=0) under this repo's own bunfig."
  echo "bun ignores coverageThreshold written as an inline table -- use the SCALAR form."
  echo "Fixture kept for inspection is gone with the tempdir; reproduce with:"
  echo "  the src/probe.ts + test/probe.test.ts pair in this script"
  echo "GATE RED"
  exit 1
fi
echo "self-test ok: partial coverage exits $self_rc under this repo's bunfig"

echo "== tsc --noEmit =="
"$BUN" x tsc --noEmit
tsc_rc=$?

echo "== bun test --coverage =="
"$BUN" test --coverage
test_rc=$?

echo "== gate summary =="
echo "self_test_rc=$self_rc (nonzero required) tsc_rc=$tsc_rc test_rc=$test_rc"
if [ "$tsc_rc" -ne 0 ] || [ "$test_rc" -ne 0 ]; then
  echo "GATE RED"
  exit 1
fi
echo "GATE GREEN"
