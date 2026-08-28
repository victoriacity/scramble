#!/usr/bin/env bash
# List the installed copies that no process runs and no launcher points at, and
# remove them only when asked.
#
#   bash scripts/prune-installs.sh              # list, delete nothing
#   bash scripts/prune-installs.sh --delete     # remove what the listing named
#   KEEP=20 bash scripts/prune-installs.sh      # keep the newest 20 (default 10)
#
# WHY THIS EXISTS. Every install writes a copy named by its commit and nothing
# removes it. One host reached 187 copies at 72M, another 92, and the count grows by
# roughly 520K per install: a night of restarts adds tens of them.
#
# WHY KEEPING THEM IS THE DEFAULT. A running listener executes out of its own copy,
# so removing that directory breaks a live process. Reproducing a drift advisory
# starts a listener from an old copy, which needs the copy to still be there. This
# script therefore deletes nothing without `--delete`, and even then skips:
#
#   - every root a live process runs from, read from /proc
#   - the root that `current` points at
#   - the newest $KEEP roots by modification time
set -uo pipefail

ROOT="${SCRAMBLE_HOME:-$HOME/.local/share/scramble}"
KEEP="${KEEP:-10}"
DELETE=0
[ "${1:-}" = "--delete" ] && DELETE=1

[ -d "$ROOT" ] || { echo "prune: no install root at $ROOT" >&2; exit 1; }

CURRENT="$(readlink -f "$ROOT/current" 2>/dev/null || true)"

# THE LIVE SET COMES FROM /proc, never from a pattern kill or a name guess: a
# pattern that matches this script's own command line would name it as a user of
# every root it mentions.
# A PROCESS THAT EXITS MID-SCAN IS NORMAL, and its vanished cmdline is no error to
# report: the redirect itself prints "No such file or directory" from the shell, so
# the read is guarded before it happens.
LIVE="$(
  for d in /proc/[0-9]*; do
    [ -r "$d/cmdline" ] || continue
    tr '\0' ' ' < "$d/cmdline" 2>/dev/null | grep -oE "$ROOT/[0-9a-f]+" || true
  done 2>/dev/null | sort -u
)"

ALL="$(find "$ROOT" -maxdepth 1 -type d -name '[0-9a-f]*' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')"
TOTAL="$(printf '%s\n' "$ALL" | grep -c . || true)"
NEWEST="$(printf '%s\n' "$ALL" | head -n "$KEEP")"

CANDIDATES=""
for p in $ALL; do
  printf '%s\n' "$NEWEST" | grep -qxF "$p" && continue
  [ "$p" = "$CURRENT" ] && continue
  printf '%s\n' "$LIVE" | grep -qxF "$p" && continue
  CANDIDATES="$CANDIDATES $p"
done

COUNT="$(printf '%s\n' $CANDIDATES | grep -c . || true)"
SIZE="$(du -sh "$ROOT" 2>/dev/null | cut -f1)"
echo "prune: $TOTAL copy(ies) under $ROOT, $SIZE total"
echo "prune: keeping the newest $KEEP, the copy current points at, and every copy a live process runs from"
printf '%s\n' "$LIVE" | grep . | sed 's/^/prune:   in use: /' || true
echo "prune: $COUNT copy(ies) qualify for removal"

if [ "$COUNT" = "0" ]; then
  exit 0
fi
if [ "$DELETE" = "0" ]; then
  printf '%s\n' $CANDIDATES | sed 's/^/prune:   would remove /'
  echo "prune: nothing was removed. Pass --delete to remove the copies listed above."
  exit 0
fi
for p in $CANDIDATES; do
  case "$p" in
    "$ROOT"/[0-9a-f]*) rm -rf -- "$p" && echo "prune: removed $p" ;;
    *) echo "prune: REFUSED to remove $p, which is outside $ROOT" >&2 ;;
  esac
done
echo "prune: $(du -sh "$ROOT" 2>/dev/null | cut -f1) total after removal"
