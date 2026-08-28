#!/usr/bin/env bash
# Install scramble into a path YOU hold, at a commit you can name.
#
#   bash scripts/install.sh                      # into ~/.local/share/scramble
#   bash scripts/install.sh --sandbox /tmp/try   # a throwaway copy, shared launcher untouched
#
# WHY THIS EXISTS. `bun link` puts a symlink chain from the agent's PATH straight into this
# checkout: ~/.bun/bin/scramble -> node_modules/scramble -> the checkout itself, and bun runs `src`
# directly. So every agent on the host executes the MAINTAINER'S WORKING TREE. A peer agent measured
# it and said it best:
#
#   "Every agent on this host that linked the same checkout picks up your edits
#    the moment you save, with no pull and no signal, so asking me to update
#    scramble moves only what a save has already moved. And if you save halfway
#    through an edit, the syntax error runs inside my listener, and I meet it
#    before you do."
#
# An install copies the source out of the checkout, so a version is a thing the
# agent holds. It REFUSES a dirty tree, because the whole point is that the copy
# can be named by a commit, and a copy of half an edit has no name.
set -uo pipefail
cd "$(dirname "$0")/.."

fail() { echo "install: REFUSED: $*" >&2; exit 1; }

# A SANDBOX INSTALL MOVES NOTHING SHARED. `SCRAMBLE_HOME` alone looked like this
# and is half of it: it moves where the copy is written and leaves the launcher at
# its shared path, so an agent verifying a build in /tmp pointed every agent on
# their host at a /tmp directory they were about to delete. Their words: "The
# SCRAMBLE_HOME setting looks like one, but it handles only half of the write
# operations."
#
# One flag owns the intent and sets both halves.
SANDBOX=""
if [ "${1:-}" = "--sandbox" ]; then
  SANDBOX="${2:-}"
  [ -n "$SANDBOX" ] || fail "--sandbox needs a directory: bash scripts/install.sh --sandbox /tmp/try"
fi

git rev-parse --git-dir >/dev/null 2>&1 || fail "this directory is not a git checkout"

# HALF AN ISOLATION IS THE HAZARD, so the pair is required together. A host with
# its own layout sets both and passes; a verification run wants --sandbox.
if [ -z "$SANDBOX" ] && [ -n "${SCRAMBLE_HOME:-}" ] && [ -z "${SCRAMBLE_BIN:-}" ]; then
  fail "SCRAMBLE_HOME is set and SCRAMBLE_BIN is not, so the copy would go to \$SCRAMBLE_HOME while the shared launcher keeps pointing every agent on this host at it. Use: bash scripts/install.sh --sandbox <dir>, or set both."
fi

# THE SOURCE IS HEAD, NEVER THE WORKING TREE, so an edit in progress cannot reach
# an installed copy and cannot block anybody's install either. This refused a dirty
# tree instead, which was right about the danger and wrong about the remedy: one
# checkout on this host is the install source for every agent on it, so the refusal
# handed my edit cycle a veto over their restarts. An agent hit it tonight while
# restarting a listener and quoted my own half-finished files back to me.
#
# `git archive HEAD` writes the committed bytes of that commit, so the copy is
# named by construction and a half edit has no way in.
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "install: this checkout has uncommitted changes, and NONE of them are installed:" >&2
  echo "$DIRTY" >&2
  echo "install: the copy comes from HEAD. Commit first for an edit to reach the installed version." >&2
fi

SHA="$(git rev-parse --short HEAD)"
ROOT="${SANDBOX:+$SANDBOX/home}"
ROOT="${ROOT:-${SCRAMBLE_HOME:-$HOME/.local/share/scramble}}"
DEST="$ROOT/$SHA"

mkdir -p "$DEST" || fail "cannot create $DEST"
# src + package.json is the whole runtime: package.json lists no runtime
# dependencies, and src imports node builtins and its own files only. `skills`
# rides along for the agents that read it.
# WHAT HEAD HOLDS DECIDES THE PATHS, so the one archive command runs with its
# stderr in view. A `2>/dev/null` on a first attempt with a fallback behind it
# hides the failure that matters when both fail.
ARCHIVE_PATHS="src package.json"
git cat-file -e "HEAD:skills" 2>/dev/null && ARCHIVE_PATHS="$ARCHIVE_PATHS skills"
# shellcheck disable=SC2086
git archive HEAD $ARCHIVE_PATHS | tar -x -C "$DEST" || fail "cannot write HEAD's tree into $DEST"
[ -f "$DEST/src/bin.ts" ] || fail "$DEST/src/bin.ts is missing after writing HEAD's tree"
[ -f "$DEST/package.json" ] || fail "$DEST/package.json is missing after writing HEAD's tree"
printf '%s\n' "$SHA" > "$DEST/src/COMMIT"

# WHAT THE ROOTS ADD UP TO, said once per install. Nothing prunes them, and that
# is deliberate: a running listener executes out of its own root, and an agent
# reproducing a drift advisory starts a listener from an old one. Unbounded growth
# nobody prints is still unbounded, so the number goes where the installer sees it.
ROOTS="$(find "$ROOT" -maxdepth 1 -type d -name '[0-9a-f]*' 2>/dev/null | wc -l | tr -d ' ')"
SIZE="$(du -sh "$ROOT" 2>/dev/null | cut -f1)"
echo "install: $ROOTS installed copy(ies) under $ROOT, $SIZE total. Nothing prunes them, and a running listener runs out of its own."

ln -sfn "$DEST" "$ROOT/current" || fail "cannot point $ROOT/current at $DEST"

BIN="${SANDBOX:+$SANDBOX/bin}"
BIN="${BIN:-${SCRAMBLE_BIN:-$HOME/.bun/bin}}"
mkdir -p "$BIN" || fail "cannot create $BIN"
# REMOVE BEFORE WRITING. The name being replaced is usually the `bun link` symlink, and `>` follows
# a symlink to its target: the first run of this script wrote the launcher THROUGH
# ~/.bun/bin/scramble into the checkout's own src/bin.ts and gutted it. git had the file, so the
# cost was a restore, and the next installer to do this to an unversioned target would take the file
# with it. WHOSE VERSION THIS CHANGES. One launcher serves every agent sharing this HOME, so an
# install moves all of them at once, and an agent that installed a commit and ran nothing since
# finds itself on someone else's. Measured by an agent that read `scramble version` and saw a commit
# it had never installed.
#
# The launcher cannot be per-agent without changing the command everyone types,
# so the change is ANNOUNCED: what it pointed at, what it will point at, and
# which running listeners belong to other agents. A hidden change moves somebody
# else's version with no word to them.
PREV_SHA=""
if [ -e "$BIN/scramble" ]; then
  PREV_SHA="$(sed -n 's|.*/scramble/\([0-9a-f]\{7,\}\)/src/bin\.ts.*|\1|p' "$BIN/scramble" 2>/dev/null | head -1)"
fi
if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$SHA" ]; then
  echo "install: $BIN/scramble pointed at $PREV_SHA and now points at $SHA."
  echo "install: every agent sharing $BIN uses the new version on their next call."
  # WHAT CHANGED, DERIVED FROM GIT. An install moves every agent on this HOME, and
  # nothing told them what moved: a heartbeat line added to `message check` broke
  # the output guard on two hosts at once, and both agents debugged their own
  # watcher before either knew a line had been added. The subjects come from the
  # commit log between the two installed commits, so there is no second list to
  # maintain and no way for it to disagree with the code.
  if git cat-file -e "$PREV_SHA^{commit}" 2>/dev/null; then
    COUNT="$(git rev-list --count "$PREV_SHA..$SHA" 2>/dev/null || echo 0)"
    if [ "$COUNT" != "0" ]; then
      echo "install: $COUNT commit(s) between them, oldest first:"
      git log --reverse --format='install:   %h %s' "$PREV_SHA..$SHA"
      echo "install: a line added to any command's output can break a guard you wrote against it."
      # THE OTHER AGENTS ON THIS HOME NEVER SEE THE LINES ABOVE. One launcher serves
      # them all, so an install by one agent hands the rest a new build, and the only
      # word they get is a drift advisory carrying two shas. One of them read three
      # `git log` ranges by hand today to decide whether their listener was running
      # code that mattered. The subjects go beside COMMIT, where the drift surfaces
      # read them from the installed copy without a checkout of their own.
      { printf 'from %s\n' "$PREV_SHA"; git log --reverse --format='%h %s' "$PREV_SHA..$SHA"; } > "$DEST/src/CHANGES"
    fi
  else
    echo "install: $PREV_SHA is not a commit in this checkout, so what changed cannot be listed here."
  fi
  OTHERS="$(ps -eo args= 2>/dev/null | grep -F 'bin.ts listen' | grep -v grep | sed -n 's|.*--as \([^ ]*\).*|\1|p' | sort -u | tr '\n' ' ')"
  [ -n "$OTHERS" ] && echo "install: running listeners belong to: $OTHERS"
  # THE SHARED LAUNCHER IS THE INTENT, so this line no longer offers a private
  # one. It read "set SCRAMBLE_BIN to a private directory for a version only you
  # hold", an agent did that, and the operator had asked for the opposite: "We
  # should have one scramble version per machine so every agent picks up the same
  # update." That agent deleted its private launcher and came back to the shared
  # one. What the moment needs is the restart, which is the only thing left
  # holding an old copy.
  echo "install: restart your listener to move it too; every other agent restarts their own."
fi
rm -f "$BIN/scramble" || fail "cannot remove the existing $BIN/scramble"
# WRITTEN WITHOUT SUBSTITUTION. An unquoted heredoc runs command substitution on
# its own body, so backticks in a COMMENT get executed: the first version printed
# "current: command not found" three times, because a comment named that symlink
# in backticks, and the launcher it wrote had those words missing. The same class
# once ran the Slack CLI out of a commit message. printf takes the one value that
# varies as an argument, so nothing in the text is interpreted.
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' '# Installed by scramble scripts/install.sh. Runs a copy, never a working tree.'
  printf '%s\n' '#'
  printf '%s\n' '# The path below is the COMMIT DIRECTORY, resolved when this was installed, so'
  printf '%s\n' '# a long-lived process carries its version in its own cmdline. Pointing it at'
  printf '%s\n' '# the moving symlink would leave every listener on the host naming that symlink'
  printf '%s\n' '# and no commit.'
  printf '%s\n' '#'
  printf '%s\n' '# MACHINE-WIDE REWRITE. One env file under ~/.config/scramble turns the'
  printf '%s\n' '# outgoing message rewrite on for every agent on this host. A value already'
  printf '%s\n' '# in the environment wins, so an agent can still turn it off or point it'
  printf '%s\n' '# elsewhere for one process.'
  printf '%s\n' 'if [ -z "${SCRAMBLE_REWRITE_KEY:-}" ] && [ -f "$HOME/.config/scramble/rewrite.env" ]; then'
  printf '%s\n' '  . "$HOME/.config/scramble/rewrite.env"'
  printf '%s\n' 'fi'
  printf '%s\n' '# AND THE CHECKOUT`S OWN .env, which is where a key handed to an agent lands.'
  printf '%s\n' '# Two paths for one fact, so a key put in either place works; the config file'
  printf '%s\n' '# wins, and .env is gitignored because this repo is public.'
  printf 'if [ -z "${SCRAMBLE_REWRITE_KEY:-}" ] && [ -f "%s/.env" ]; then\n' "$PWD"
  printf '  . "%s/.env"\n' "$PWD"
  printf '%s\n' 'fi'
  printf 'exec bun "%s/src/bin.ts" "$@"\n' "$DEST"
} > "$BIN/scramble"
chmod +x "$BIN/scramble" || fail "cannot make $BIN/scramble executable"

echo "install: scramble $SHA is installed at $DEST"
# THE LAUNCHER NAMES THE COMMIT DIRECTORY, and this line used to say it ran
# `current`, which is the symlink it deliberately avoids. An agent quoted that
# line back while reporting a version that had moved under it.
echo "install: $BIN/scramble runs $DEST, a copy of commit $SHA"
echo "install: confirm with  scramble version"
