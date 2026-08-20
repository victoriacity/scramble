#!/usr/bin/env bash
# The merge gate: types clean, every test green, coverage at 100%.
# No pipes through tail/head/grep -- an exit code masked by a pipe is a lie.
set -uo pipefail
cd "$(dirname "$0")/.."

BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
[ -x "$BUN" ] || { echo "GATE FAIL: bun not found (tried PATH and $HOME/.bun/bin/bun)"; exit 1; }

echo "== tsc --noEmit =="
"$BUN" x tsc --noEmit
tsc_rc=$?

echo "== bun test --coverage =="
"$BUN" test --coverage
test_rc=$?

echo "== gate summary =="
echo "tsc_rc=$tsc_rc test_rc=$test_rc"
if [ "$tsc_rc" -ne 0 ] || [ "$test_rc" -ne 0 ]; then
  echo "GATE RED"
  exit 1
fi
echo "GATE GREEN"
