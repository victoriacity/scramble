#!/usr/bin/env bash
# Arm the inbox as ONE process tree, so one kill takes the whole thing.
#
#   bash scripts/inbox.sh <agent> [outfile]
#
# WHY. The usual arming is a shell running `scramble listen | grep`, and killing
# that shell leaves the `bun` child alive, still holding the code it started
# with. A peer agent measured it (2026-08-22):
#
#   "killing the wrapper leaves the bun child alive holding the old code, which
#    is how I briefly had three listeners with two of them on the checkout."
#
# A stale listener is invisible in every place anyone looks: `git log` shows the
# code, the tests show the tests, and neither knows what a process started before
# any of that. `scramble doctor` names them, and this script keeps them from
# happening: the trap kills the whole process GROUP on the way out, so stopping
# the parent stops the listener and its filter together.
set -uo pipefail

AGENT="${1:-}"
OUT="${2:-/tmp/scramble-wake-${AGENT}.jsonl}"
[ -n "$AGENT" ] || { echo "usage: bash scripts/inbox.sh <agent> [outfile]" >&2; exit 1; }

command -v scramble >/dev/null 2>&1 || {
  echo "inbox: no \`scramble\` on PATH. Install one you hold: bash scripts/install.sh" >&2
  exit 1
}

# WHICH COPY IS ABOUT TO RUN, said before it runs, because a listener that has
# been up for hours is exactly where nobody looks for a version.
scramble version >&2 || echo "inbox: arming anyway, with the version unknown" >&2

cleanup() {
  trap - TERM INT EXIT
  # The whole group: the listener, its filter, and anything they spawned.
  kill -- "-$$" 2>/dev/null
}
trap cleanup TERM INT EXIT

# `-` means this script's own stdout, which is what a harness monitor reads. A
# path is appended to. /dev/stdout is NOT a substitute: under a monitor it is not
# an addressable device and the redirect fails, which is how the first armed run
# of this script started a listener whose output went nowhere.
FILTER='"mentioned":true|^slack: |invalid_auth|account_inactive|not_in_channel|inbox ledger not'
if [ "$OUT" = "-" ]; then
  SCRAMBLE_BACKEND=slack scramble listen --as "$AGENT" | grep -E --line-buffered "$FILTER" &
else
  SCRAMBLE_BACKEND=slack scramble listen --as "$AGENT" | grep -E --line-buffered "$FILTER" >> "$OUT" &
fi
wait $!
