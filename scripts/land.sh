#!/usr/bin/env bash
# The ONE way to commit by hand in this checkout.
#
# Exists because on 2026-08-21 a four-line commit to a skill file DELETED a
# landed unit: 297 lines across src/slack-backend.ts, its tests and a
# reproducer. A lane merge had advanced main's ref while I held this checkout,
# and git's index still described the PREVIOUS HEAD for every path, so
# `git add <one file>` plus a bare `git commit` recorded old-index-plus-my-file,
# which is a revert of the merge for every path that differed. The gate stayed
# green at 324 tests because the deleted feature took its tests with it.
# (postmortem: akrust log/postmortems/
#  2026-08-21-my-commit-reverted-a-landed-unit-from-a-stale-index.md)
#
# usage: scripts/land.sh -m "<message>" <path> [<path> ...]
#        scripts/land.sh -F <file>      <path> [<path> ...]
#
# Every path is REQUIRED and is the whole of what gets committed: the commit uses
# `git commit -- <paths>`, which builds the tree from HEAD plus those paths and
# ignores the index for everything else.
set -uo pipefail
cd "$(dirname "$0")/.."

fail() { echo "land: REFUSED — $*" >&2; exit 1; }

MSG=""
MSG_FILE=""
PATHS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -m) MSG="${2:-}"; shift 2 || fail "-m needs a message" ;;
    -F) MSG_FILE="${2:-}"; shift 2 || fail "-F needs a file" ;;
    -*) fail "unknown flag $1" ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

# 1) NO PATHS, NO COMMIT. The defect this script exists for is a commit whose
#    real contents were never named by the person making it.
[ "${#PATHS[@]}" -gt 0 ] || fail "name every path to commit (this is the whole point: scripts/land.sh -m msg <path>...)"
[ -n "$MSG" ] || [ -n "$MSG_FILE" ] || fail "give a message with -m or -F"
[ -z "$MSG_FILE" ] || [ -r "$MSG_FILE" ] || fail "cannot read message file $MSG_FILE"

for p in "${PATHS[@]}"; do
  [ -e "$p" ] || git ls-files --error-unmatch "$p" >/dev/null 2>&1 || fail "path does not exist and is not tracked: $p"
done

# 2) THE COMMIT MAY NOT TOUCH A PATH THE CALLER DID NOT NAME. `git commit --
#    <paths>` already guarantees this, so this check is here to catch the case
#    where a named path is a DIRECTORY holding changes the caller did not expect,
#    and to print the diffstat before anything is recorded.
#    A NEW file is invisible to `git diff HEAD` and cannot be named by
#    `git commit -- <path>` at all, so the named paths are staged first. Staging
#    is scoped to exactly what the caller named, which is the invariant this
#    script keeps: the index contributes nothing the caller did not ask for.
git add -- "${PATHS[@]}" || fail "git add failed for: ${PATHS[*]}"
STAGED="$(git diff HEAD --stat -- "${PATHS[@]}")"
[ -n "$STAGED" ] || fail "nothing to commit in: ${PATHS[*]}"
echo "land: committing exactly these:"
echo "$STAGED" | sed 's/^/  /'

# 3) A NET DELETION IN A PATH IS ANNOUNCED, because that is the signature this
#    script exists for: the reverting commit deleted 297 lines and added 17.
python3 - "$@" <<'PYEOF' || fail "see the deletion summary above"
import subprocess, sys
paths = [a for a in sys.argv[1:] if not a.startswith("-")]
# argv still holds the message and flags; recover the paths the same way the
# shell did, by dropping flag values.
args = sys.argv[1:]
paths, skip = [], False
for i, a in enumerate(args):
    if skip:
        skip = False
        continue
    if a in ("-m", "-F"):
        skip = True
        continue
    if a.startswith("-"):
        continue
    paths.append(a)
out = subprocess.run(["git", "diff", "HEAD", "--numstat", "--", *paths],
                     capture_output=True, text=True).stdout
heavy = []
for line in out.splitlines():
    parts = line.split("\t")
    if len(parts) != 3:
        continue
    add, rem, path = parts
    if add == "-" or rem == "-":
        continue
    if int(rem) > int(add):
        heavy.append((path, int(add), int(rem)))
if heavy:
    print("land: this commit REMOVES more than it adds in:")
    for path, add, rem in heavy:
        print(f"  {path}: +{add} -{rem}")
    print("land: that is the shape of a stale-index revert. If the deletion is")
    print("land: intended, this is only a notice; if it is not, run")
    print("land: `git diff HEAD -- <path>` and look before committing again.")
sys.exit(0)
PYEOF

if [ -n "$MSG_FILE" ]; then
  git -c user.email=victoriacity74@gmail.com -c user.name="Andrew Sun" commit -q -F "$MSG_FILE" -- "${PATHS[@]}" || fail "git commit failed"
else
  git -c user.email=victoriacity74@gmail.com -c user.name="Andrew Sun" commit -q -m "$MSG" -- "${PATHS[@]}" || fail "git commit failed"
fi
echo "land: $(git log --oneline -1)"
