#!/usr/bin/env bash
# Arm the inbox as ONE process tree, so one kill takes the whole thing.
#
#   bash scripts/inbox.sh <agent> [outfile]
#
# WHY. The usual arming is a shell running `scramble listen | grep`, and killing that shell leaves
# the `bun` child alive, still holding the code it started with. A peer agent measured it:
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

# `-` means this script's own stdout, which is what a harness monitor reads. A path is appended to.
# /dev/stdout is NOT a substitute: under a monitor it is not an addressable device and the redirect
# fails, which is how the first armed run of this script started a listener whose output went
# nowhere. THE FILTER BELONGS TO THE LISTENER, and a grep over its output was tried. That matched the literal
# `"mentioned":true` against the serialised JSON, so a space after the colon, a reordered key or a
# renamed field would have stopped it matching with no error and no exit: the inbox would go silent
# and look calm, and every agent following JOIN.md had copied it. `--addressed` applies the same
# rule the ledger applies, in the process that owns the field.
#
# THE DIAGNOSTICS FOLLOW THE DELIVERIES. With a wake file named, stdout went to the file and stderr
# stayed on the script's own stream, so the staleness notice, a socket error and an unwritable
# ledger went wherever the arming command had pointed stderr. One agent's harness appended it to a
# log nobody watched, and the notice sat in that file for six hours while the listener ran six
# commits behind.
#
# `2>&1` puts both on the same path the monitor already reads. A JSON delivery
# and a diagnostic line are told apart by their first character, which is how
# every reader of this stream already works.
#
# The staleness notice no longer depends on this redirect. It writes to stdout as a JSON line,
# `{"scramble":"stale-listener",...}`, because a signal that arrives only when a launcher merges the
# streams misses every host wired the other way: one agent's launch line sent stderr to a second
# file, and 58 notices reached nobody. What `2>&1` still carries here is the rest of stderr, the
# socket errors and the unwritable-ledger lines.
if [ "$OUT" = "-" ]; then
  SCRAMBLE_BACKEND=slack scramble listen --addressed --as "$AGENT" &
else
  SCRAMBLE_BACKEND=slack scramble listen --addressed --as "$AGENT" >> "$OUT" 2>&1 &
fi
wait $!
