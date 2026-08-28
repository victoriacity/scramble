# The script runs the inbox as a single process tree so that one kill signal
# terminates the whole process tree.
#
# bash scripts/inbox.sh <agent> [outfile]
#
# Standard execution runs a shell executing `scramble listen | grep`, and killing
# that shell leaves the child `bun` process alive while holding the code it
# started with. Terminating the wrapper leaves the `bun` child process alive
# holding the original code, creating three active listeners with two of them
# running checkout code.
#
# A stale listener is invisible across inspection tools: `git log` shows the
# code, the tests show test results, and neither tool detects a process started
# before those checks. `scramble doctor` names stale listeners, and this script
# prevents them from occurring. An exit trap kills the entire process group, so
# stopping the parent stops the listener and its filter together.
set -uo pipefail

AGENT="${1:-}"
OUT="${2:-/tmp/scramble-wake-${AGENT}.jsonl}"
[ -n "$AGENT" ] || { echo "usage: bash scripts/inbox.sh <agent> [outfile]" >&2; exit 1; }

command -v scramble >/dev/null 2>&1 || {
  echo "inbox: no \`scramble\` on PATH. Install one you hold: bash scripts/install.sh" >&2
  exit 1
}

# The process reports which copy is about to run before it runs, because nobody
# looks for a version in a listener that has been up for hours.
scramble version >&2 || echo "inbox: arming anyway, with the version unknown" >&2

cleanup() {
  trap - TERM INT EXIT
  # The whole group includes the listener, its filter, and anything they spawned.
  kill -- "-$$" 2>/dev/null
}
trap cleanup TERM INT EXIT

# The argument `-` designates this script's own stdout, which a harness monitor
# reads. The script appends output when given a file path. The path /dev/stdout
# cannot serve as a substitute because it is not an addressable device under a
# monitor, which causes the redirect to fail; this failure caused the first armed
# run of this script to start a listener whose output went nowhere. The listener
# performs its own filtering. A previous attempt ran grep over listener output to
# match the literal `"mentioned":true` against serialized JSON. A space after the
# colon, a reordered key, or a renamed field would have prevented matching
# without generating an error or an exit; the inbox would then fall silent while
# appearing normal, and every agent following JOIN.md had copied that pattern.
# The flag `--addressed` applies the same rule that the ledger applies, operating
# within the process that owns the field.
#
# Diagnostics accompany deliveries. When a configuration named a wake file,
# stdout went to the file while stderr remained on the script's own stream;
# therefore, the staleness notice, a socket error, and an unwritable ledger routed
# to wherever the arming command directed stderr. One agent's harness appended
# that stream to an unmonitored log, where the notice remained for six hours while
# the listener ran six commits behind.
#
# The operator `2>&1` routes both streams to the path that the monitor already
# reads. Consumers distinguish a JSON delivery from a diagnostic line by the
# first character, which is how every reader of this stream already operates.
#
# The staleness notice no longer depends on this redirect. It writes directly to
# stdout as a JSON line, `{"scramble":"stale-listener",...}`, because a signal
# that arrives only when a launcher merges streams misses every host configured
# otherwise; one agent's launch command routed stderr to a separate file, and 58
# notices reached nobody. The redirection `2>&1` still conveys the remainder of
# stderr, including socket errors and unwritable-ledger lines.
if [ "$OUT" = "-" ]; then
  SCRAMBLE_BACKEND=slack scramble listen --addressed --as "$AGENT" &
else
  SCRAMBLE_BACKEND=slack scramble listen --addressed --as "$AGENT" >> "$OUT" 2>&1 &
fi
wait $!

