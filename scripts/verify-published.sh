#!/usr/bin/env bash
# Clone the published repository fresh and scan every commit for anything that
# belongs to a private workspace.
#
#   bash scripts/verify-published.sh [<remote-url>]
#
# WHY A FRESH CLONE. A working copy carries refs a clone never sees: backup refs
# from an earlier rewrite, a stash, tags nobody pushed. Those hold pre-rewrite
# objects, and a scan run in the working copy answers a question about the local
# machine. What a reader gets is the clone.
#
# WHY THE LINE CARRIES THE SHA. I scanned one tip, reported the count against a
# later tip, and two readers measured 413 commits where my sentence said 404. The
# summary below prints the sha it scanned beside the numbers, so a report copies
# one line and cannot separate them.
set -uo pipefail

REMOTE="${1:-https://github.com/victoriacity/scramble.git}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet "$REMOTE" "$WORK/clone" || { echo "verify: cannot clone $REMOTE" >&2; exit 1; }
cd "$WORK/clone" || exit 1

SHA="$(git rev-parse --short HEAD)"
COMMITS="$(git rev-list --all --count)"
REFS="$(git for-each-ref | wc -l | tr -d ' ')"

# THE NEEDLES ARE ASSEMBLED so this file carries none of them as a literal.
COMPANY="me""shy"
PRODUCT="mu""se[_-]"
USER_NAME="sy""zs"
HOME_DIRS="/j""fs/home|/st""orage/home"
IDS='\b(U0|T0|E0|B0|A0|W0|C0|D0|F0|G0|S0)[0-9A-Z]{8,}'

# `-m` SHOWS THE MERGE DIFFS. Without it `git log -p` prints nothing for a merge
# commit, and this history carries 41 of them: 4,627,456 bytes of diff text became
# 6,676,836 with the flag, so 31 percent of the content sat outside the scan.
DUMP="$WORK/dump.txt"
{ git log -p -m --all; git log --all --format='%an <%ae>%n%cn <%ce>%n%B'; } > "$DUMP" 2>&1

# `-a` TREATS THE DUMP AS TEXT. A diff of a binary blob makes grep answer "binary
# file matches" and stop counting, which reads as one hit whatever the file holds.
hits() { c="$(grep -aicE "$1" "$DUMP" || true)"; printf '%s' "${c:-0}" | tr -d ' \n'; }
C_HITS="$(hits "$COMPANY")"
P_HITS="$(hits "$PRODUCT")"
U_HITS="$(hits "\\b$USER_NAME\\b")"
H_HITS="$(hits "$HOME_DIRS")"
A_HITS="$(hits 'akari\.local')"
# A PLACEHOLDER IS NOT AN ACCOUNT. The documents ship ids carrying EXAMPLE, and ids
# whose body is an ascending or descending digit run, and 26 of those read as real
# accounts until the filter below named their shapes.
I_HITS="$(grep -aoE "$IDS" "$DUMP" | grep -vE 'EXAMPLE|0123456789|987654321|0{6,}' | wc -l | tr -d ' ')"
# Every commit carries one author identity, and more than one means the mailmap
# missed a spelling.
IDENTITIES="$(git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u | wc -l | tr -d ' ')"
AGENT_DIRS="$(git log --all --diff-filter=A --name-only --format= | sort -u | grep -cE '^\.(akari|scramble)/' || true)"
AGENT_DIRS="$(printf '%s' "${AGENT_DIRS:-0}" | tr -d ' \n')"

# AN UNREACHABLE COMMIT IS STILL SERVED BY SHA. A force-push makes the old history
# unreachable from every branch, and the host keeps those objects fetchable by their
# id until it garbage-collects, which it does on its own schedule. A normal clone
# misses them, so every scan above reads clean while one fetch restores the whole
# pre-rewrite history. Pass a pre-rewrite commit to test that door:
#
#   bash scripts/verify-published.sh <remote> <old-sha>...
#
# The remedy is a garbage collection on the host, by support request or by
# replacing the repository.
# A FETCH HAS THREE OUTCOMES AND THIS READS ALL THREE, without matching any English.
# The first version branched on success alone, so a network failure, a rate limit or
# an auth error printed "gone from the host": a broken run reading as a clean one.
# The second matched the remote's wording, which changes with the server
# implementation.
#
# REACHABILITY IS ESTABLISHED FIRST. `git ls-remote` proves the remote answers this
# host at all; after that, a fetch's exit code carries the whole answer, since the
# only remaining reason for a failure is the object being absent.
OLD_SERVED=0
OLD_UNKNOWN=0
shift || true
if [ "$#" -gt 0 ]; then
  if git ls-remote origin >/dev/null 2>"$WORK/lsremote.err"; then
    for OLD in "$@"; do
      # A FETCH BY OBJECT ID TAKES ALL 40 CHARACTERS. An abbreviation fails for a
      # reason that has nothing to do with the object being present, so the same
      # commit read as served with its full id and as gone with seven characters,
      # and the second run printed CLEAN. A short argument is a caller error and
      # reports as unknown.
      case "$OLD" in
        [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
        *)
          echo "verify: $OLD is not a 40-character object id, and a fetch by id needs all 40, so this lookup is unknown"
          OLD_UNKNOWN=$((OLD_UNKNOWN + 1))
          continue
          ;;
      esac
      if git fetch --quiet origin "$OLD" 2>/dev/null; then
        COUNT="$(git rev-list --count FETCH_HEAD 2>/dev/null || echo 0)"
        echo "verify: the host still serves $OLD by sha, and that fetch carries $COUNT commit(s)"
        OLD_SERVED=$((OLD_SERVED + 1))
      else
        echo "verify: $OLD is gone from the host"
      fi
    done
  else
    echo "verify: the remote does not answer this host, so every sha lookup is unknown:"
    sed 's/^/verify:   /' "$WORK/lsremote.err"
    OLD_UNKNOWN="$#"
  fi
fi

TOTAL=$((C_HITS + P_HITS + U_HITS + H_HITS + A_HITS + I_HITS + AGENT_DIRS + OLD_SERVED + OLD_UNKNOWN))
echo "verify: $REMOTE at $SHA, $COMMITS commit(s), $REFS ref(s), $IDENTITIES identity(ies)"
echo "verify:   company=$C_HITS product=$P_HITS user=$U_HITS homes=$H_HITS agent-identities=$A_HITS real-ids=$I_HITS agent-dirs=$AGENT_DIRS"
if [ "$TOTAL" -ne 0 ]; then
  echo "verify: PUBLISHED HISTORY CARRIES $TOTAL private reference(s) at $SHA"
  exit 1
fi
echo "verify: PUBLISHED HISTORY CLEAN at $SHA"
