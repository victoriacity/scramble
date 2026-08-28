# !/usr/bin/env bash
# This script is the only way to commit by hand in this checkout.
#
# It exists because a four-line commit to a skill file deleted a committed unit:
# 297 lines across `src/slack-backend.ts`, its tests, and a reproducer. A branch
# merge had advanced the `main` ref while this checkout was active, and the Git
# index still described the previous `HEAD` for every path, so
# `git add <one file>` plus a bare `git commit` recorded the stale index with the
# new file, which reverted the merge for every path that differed. All 324 tests
# passed after the deletion, since the deleted feature took its tests with it.
# The postmortem is documented in
# `log/postmortems/-my-commit-reverted-a-landed-unit-from-a-stale-index.md`.
#
# usage: `scripts/land.sh -F - <path> [<path> ...] <<'MSG' ... MSG` (PREFER THIS)
# `scripts/land.sh -m "<message>" <path> [<path> ...]`
#
#
# Use `-F` with a quoted heredoc. A `-m` message is a shell argument, so a
# backtick in it runs as a command before this script receives it: a message
# mentioning `slack` executed the Slack CLI and pasted its help text into the
# commit. A `<<'MSG'` heredoc is literal, and it also lets the message hold blank
# lines and quotes without escaping.
#
# Every path is required and constitutes the whole of what gets committed: the
# commit uses `git commit -- <paths>`, which builds the tree from `HEAD` plus
# those paths and ignores the index for everything else.
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

# 1) The script creates no commit when the operator provides no paths. This
# script exists to prevent commits whose actual contents were never named by
# the person creating them.
[ "${#PATHS[@]}" -gt 0 ] || fail "name every path to commit (this is the whole point: scripts/land.sh -m msg <path>...)"
[ -n "$MSG" ] || [ -n "$MSG_FILE" ] || fail "give a message with -m or -F"
# The `-F -` flag reads from stdin, which is the form a quoted heredoc uses.
[ "$MSG_FILE" != "-" ] || MSG_FILE=/dev/stdin
[ -z "$MSG_FILE" ] || [ -r "$MSG_FILE" ] || fail "cannot read message file $MSG_FILE"

for p in "${PATHS[@]}"; do
  # A path is valid if it exists in the worktree, is tracked, or exists in HEAD.
  # The last case represents a deletion: `git rm` removes the path from both the
  # worktree and the index, and a commit that removes a file must still be able to
  # name it.
  [ -e "$p" ] ||
    git ls-files --error-unmatch "$p" >/dev/null 2>&1 ||
    git cat-file -e "HEAD:$p" 2>/dev/null ||
    fail "path is not in the worktree, the index, or HEAD: $p"
done

# 2) THE COMMIT MAY NOT TOUCH A PATH THE CALLER DID NOT NAME. `git commit --
# <paths>` already guarantees this rule, so this check catches the case where
# a named path is a directory holding changes the caller did not expect, and
# prints the diffstat before anything is recorded.
#
# A new file is invisible to `git diff HEAD` and `git commit -- <path>` cannot
# name it at all, so the script stages the named paths first. Staging is
# scoped to exactly what the caller named, which is the invariant this script
# keeps: the index contributes nothing the caller did not ask for.
#
# The script skips a path that is absent from the worktree: `git rm` has
# already staged its removal, and `git add` on a path that is in neither the
# worktree nor the index fails outright.
ADDABLE=()
for p in "${PATHS[@]}"; do [ -e "$p" ] && ADDABLE+=("$p"); done
[ "${#ADDABLE[@]}" -eq 0 ] || git add -A -- "${ADDABLE[@]}" || fail "git add failed for: ${ADDABLE[*]}"
STAGED="$(git diff HEAD --stat -- "${PATHS[@]}")"
[ -n "$STAGED" ] || fail "nothing to commit in: ${PATHS[*]}"
echo "land: committing exactly these:"
echo "$STAGED" | sed 's/^/  /'

# 3) TWO WARNINGS, where the second check repeatedly prevents regressions:
# (a) A net deletion in a named path. This signature matches the reverting
# commit that deleted 297 lines and added 17.
# (b) An unnamed path that differs from HEAD. This difference reveals a lane
# merge arriving under this checkout: the worktree copy is older than
# main, and committing it later reverts the merge. This check fired on
# src/cli.ts at +3 -15 and caught that condition, minutes after the same
# class of error had already cost a restore.
#
# The PATHS array carries the paths here. The argument loop above shifts "$@"
# empty, so passing it caused this block to diff the entire tree while expecting
# to diff the named paths. The block warned correctly by accident, which is not a
# dependable mechanism.
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

# The paths remain unnamed. A worktree copy that is BEHIND HEAD means a lane
# merge arrived under this checkout, and committing that copy later reverts
# the merge.
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

# The commit message follows the same rules as a sent message. Four of the last
# eight messages failed them when this check first ran: two used the antithesis
# form, and two used a closer that restated the message. Everyone who reads the
# history reads the commit message, and it was the one piece of writing here that
# nothing checked. The runner reads standard input once into a file. The `-F -`
# flag and a lint tool that also reads standard input do not share the stream;
# the lint tool drained the stream, and git saw an empty message. A committer
# caught this on the first real commit after adding the check. The runner copies
# the message once, and both steps read the copy. The `-F -` flag resolves to
# `/dev/stdin` above, so the lint tool drained it and git found an empty message.
# Finding this took two attempts, because the first fix still left git pointed at
# the drained stream.
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

# Each commit message must consist of a single sentence. Past messages in this
# repository contained a subject line followed by paragraphs of reasoning. That
# reasoning belongs in a code comment beside the change where a reader meets it,
# because `git log` is the wrong place for such explanations.
#
# The check counts lines that contain text, and it counts sentence endings inside
# the line. A trailing full stop is valid, while a full stop in the middle marks
# two sentences.
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

