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
# usage: scripts/land.sh -F - <path> [<path> ...]  <<'MSG' ... MSG   (PREFER THIS)
#        scripts/land.sh -m "<message>" <path> [<path> ...]
#
# PREFER -F WITH A QUOTED HEREDOC. A -m message is a shell argument, so a
# backtick in it runs as a command before this script ever sees it: on
# 2026-08-21 a message mentioning `slack` executed the Slack CLI and pasted its
# help text into the commit. A <<'MSG' heredoc is literal, and it also lets the
# message hold blank lines and quotes without escaping.
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
# `-F -` means stdin, the form a quoted heredoc uses.
[ "$MSG_FILE" != "-" ] || MSG_FILE=/dev/stdin
[ -z "$MSG_FILE" ] || [ -r "$MSG_FILE" ] || fail "cannot read message file $MSG_FILE"

for p in "${PATHS[@]}"; do
  # Valid if it exists in the worktree, OR is tracked, OR exists in HEAD. The
  # last case is a DELETION: `git rm` takes the path out of both the worktree and
  # the index, and a commit that removes a file must still be able to name it.
  [ -e "$p" ] ||
    git ls-files --error-unmatch "$p" >/dev/null 2>&1 ||
    git cat-file -e "HEAD:$p" 2>/dev/null ||
    fail "path is not in the worktree, the index, or HEAD: $p"
done

# 2) THE COMMIT MAY NOT TOUCH A PATH THE CALLER DID NOT NAME. `git commit --
#    <paths>` already guarantees this, so this check is here to catch the case
#    where a named path is a DIRECTORY holding changes the caller did not expect,
#    and to print the diffstat before anything is recorded.
#    A NEW file is invisible to `git diff HEAD` and cannot be named by
#    `git commit -- <path>` at all, so the named paths are staged first. Staging
#    is scoped to exactly what the caller named, which is the invariant this
#    script keeps: the index contributes nothing the caller did not ask for.
#    A path that is absent from the worktree is skipped here: `git rm` has already
#    staged its removal, and `git add` on a path that is in neither the worktree
#    nor the index fails outright.
ADDABLE=()
for p in "${PATHS[@]}"; do [ -e "$p" ] && ADDABLE+=("$p"); done
[ "${#ADDABLE[@]}" -eq 0 ] || git add -A -- "${ADDABLE[@]}" || fail "git add failed for: ${ADDABLE[*]}"
STAGED="$(git diff HEAD --stat -- "${PATHS[@]}")"
[ -n "$STAGED" ] || fail "nothing to commit in: ${PATHS[*]}"
echo "land: committing exactly these:"
echo "$STAGED" | sed 's/^/  /'

# 3) TWO WARNINGS, and the second one is the one that keeps saving me.
#    (a) A net deletion in a NAMED path, the signature of the reverting commit
#        that deleted 297 lines and added 17.
#    (b) A path NOT named that differs from HEAD, which is how a lane merge
#        landing under this checkout announces itself: the worktree copy is
#        older than main, and committing it later would revert the merge. This
#        fired on 2026-08-21 with src/cli.ts at +3 -15 and caught exactly that,
#        minutes after the same class had already cost a restore.
# The PATHS array, not "$@": the arg loop above shifted "$@" empty, and passing
# it meant this block diffed the whole tree while believing it diffed the named
# paths. It warned correctly by accident, which is not a mechanism.
python3 - "${PATHS[@]}" <<'PYEOF' || fail "see the deletion summary above"
import subprocess, sys
paths = list(sys.argv[1:])
if not paths:
    print("land: internal error, the path list reached the checker empty")
    sys.exit(1)
def numstat(args):
    out = subprocess.run(["git", "diff", "HEAD", "--numstat", *args],
                         capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or parts[0] == "-" or parts[1] == "-":
            continue
        rows.append((parts[2], int(parts[0]), int(parts[1])))
    return rows

named = numstat(["--", *paths])
heavy = [(p, a, r) for p, a, r in named if r > a]
if heavy:
    print("land: this commit REMOVES more than it adds in:")
    for path, add, rem in heavy:
        print(f"  {path}: +{add} -{rem}")
    print("land: that is the shape of a stale-index revert. If the deletion is")
    print("land: intended, this is only a notice; if it is not, run")
    print("land: `git diff HEAD -- <path>` and look before committing again.")

# The unnamed paths. A worktree copy that is BEHIND HEAD means a lane merge
# landed under this checkout, and committing that copy later reverts the merge.
others = [(p, a, r) for p, a, r in numstat([]) if p not in paths and r > a]
if others:
    print("land: WARNING, these paths are not in this commit and your worktree copy")
    print("land: is BEHIND HEAD, which is what a lane merge landing here looks like:")
    for path, add, rem in others[:12]:
        print(f"  {path}: +{add} -{rem} versus HEAD")
    print("land: refresh them before you touch them, or a later commit reverts the")
    print("land: merge: git checkout HEAD -- <path>")
sys.exit(0)
PYEOF

# THE COMMIT MESSAGE GOES THROUGH THE SAME RULES A SENT MESSAGE DOES. Four of the
# last eight failed them when this was first run: the antithesis form twice, a
# closer restating the message twice. A commit message is read by everyone who
# reads the history, and it was the one piece of writing here that nothing
# checked (2026-08-25).
# STDIN IS READ ONCE, INTO A FILE. `-F -` and a lint that also reads stdin do not
# share: the lint drained it and git saw an empty message. Caught on the first
# real commit after this check was added.
# THE MESSAGE IS COPIED ONCE, AND BOTH STEPS READ THE COPY. `-F -` becomes
# /dev/stdin above, so the lint drained it and git found an empty message. It
# took two attempts to see, because the first fix still left git pointed at the
# drained stream.
LINT_INPUT="$(mktemp)"
if [ -n "$MSG_FILE" ]; then
  cat "$MSG_FILE" > "$LINT_INPUT"
  MSG_FILE="$LINT_INPUT"
else
  printf '%s\n' "$MSG" > "$LINT_INPUT"
fi
if ! "${SCRAMBLE_BUN:-bun}" "$(git rev-parse --show-toplevel)/src/bin.ts" lint "$LINT_INPUT"; then
  fail "the commit message breaks the language rules above. Rewrite it and run again."
fi

# ONE SENTENCE. The operator, 2026-08-27: "commit message should be 1 SENTENCE".
# Every message in this repo's history was a subject line plus paragraphs of
# reasoning, and `git log` is the wrong place for that: the reasoning belongs in
# the code comment beside the change, where a reader meets it.
#
# The check counts lines with any text on them, and counts sentence ends inside
# the line. A trailing full stop is fine; one in the middle means two sentences.
MSG_LINES="$(grep -c '[^[:space:]]' "$LINT_INPUT" || true)"
[ "$MSG_LINES" -le 1 ] || fail "the commit message must be ONE sentence on one line, and this has $MSG_LINES lines with text."
if grep -Eq '[.!?]["'"'"'\)]*[[:space:]]+[^[:space:]]' "$LINT_INPUT"; then
  fail "the commit message must be ONE sentence, and this carries a sentence end with more text after it."
fi

if [ -n "$MSG_FILE" ]; then
  git -c user.email=victoriacity74@gmail.com -c user.name="Andrew Sun" commit -q -F "$MSG_FILE" -- "${PATHS[@]}" || fail "git commit failed"
else
  git -c user.email=victoriacity74@gmail.com -c user.name="Andrew Sun" commit -q -m "$MSG" -- "${PATHS[@]}" || fail "git commit failed"
fi
echo "land: $(git log --oneline -1)"
