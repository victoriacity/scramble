#!/usr/bin/env bash
# Run a command and append its output to a draft as a fenced block.
#
#   bash scripts/quote-output.sh draft.md du -a /some/dir
#   bash scripts/quote-output.sh draft.md scramble rewrites --near --as dev
#
# WHY THIS EXISTS. A message carrying numbers is worth what its numbers are worth. I
# typed six directory sizes into a draft from memory, ran the command in the same
# breath, and posted the draft: three of the six were wrong by 10 to 20 percent. The
# same shape produced a commit count from a stale scan and a line count read off a
# sequence id earlier in the session.
#
# The fix is mechanical. A figure reaches a draft by being appended from the command
# that produced it, so no transcription step exists to get wrong.
#
# The exit code of the command is preserved in the block, since a number from a
# failed run is worth nothing and a reader has to see that.
set -uo pipefail

DRAFT="${1:-}"
shift || true
[ -n "$DRAFT" ] && [ "$#" -gt 0 ] || {
  echo "usage: bash scripts/quote-output.sh <draft-file> <command>..." >&2
  exit 1
}

OUT="$("$@" 2>&1)"
RC=$?

{
  printf '\n```\n'
  printf '%s\n' "$OUT"
  [ "$RC" != "0" ] && printf 'exit %s\n' "$RC"
  printf '```\n'
} >> "$DRAFT"

echo "quoted: $* -> $DRAFT (exit $RC, $(printf '%s\n' "$OUT" | wc -l) line(s))"
exit "$RC"
