#!/usr/bin/env bash
# Install scramble into a path YOU hold, at a commit you can name.
#
#   bash scripts/install.sh              # into ~/.local/share/scramble
#   SCRAMBLE_HOME=/somewhere bash scripts/install.sh
#
# WHY THIS EXISTS. `bun link` puts a symlink chain from the agent's PATH straight
# into this checkout: ~/.bun/bin/scramble -> node_modules/scramble -> the
# checkout itself, and bun runs `src` directly. So every agent on the host
# executes the MAINTAINER'S WORKING TREE. A peer agent measured it and said it
# best (2026-08-22):
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

git rev-parse --git-dir >/dev/null 2>&1 || fail "this directory is not a git checkout"

DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "install: the working tree has uncommitted changes:" >&2
  echo "$DIRTY" >&2
  fail "commit or stash all changes before installing. An install names a COMMIT, and half an edit has no name."
fi

SHA="$(git rev-parse --short HEAD)"
ROOT="${SCRAMBLE_HOME:-$HOME/.local/share/scramble}"
DEST="$ROOT/$SHA"

mkdir -p "$DEST" || fail "cannot create $DEST"
# src + package.json is the whole runtime: package.json lists no runtime
# dependencies, and src imports node builtins and its own files only.
cp -r src "$DEST/" || fail "cannot copy src into $DEST"
cp package.json "$DEST/" || fail "cannot copy package.json into $DEST"
cp -r skills "$DEST/" 2>/dev/null || true
printf '%s\n' "$SHA" > "$DEST/src/COMMIT"

ln -sfn "$DEST" "$ROOT/current" || fail "cannot point $ROOT/current at $DEST"

BIN="${SCRAMBLE_BIN:-$HOME/.bun/bin}"
mkdir -p "$BIN" || fail "cannot create $BIN"
# REMOVE BEFORE WRITING. The name being replaced is usually the `bun link`
# symlink, and `>` follows a symlink to its target: the first run of this script
# wrote the launcher THROUGH ~/.bun/bin/scramble into the checkout's own
# src/bin.ts and gutted it. git had the file, so the cost was a restore, and the
# next installer to do this to an unversioned target would take the file with it.
# WHOSE VERSION THIS CHANGES. One launcher serves every agent sharing this HOME,
# so an install moves all of them at once, and an agent that installed a commit
# and ran nothing since finds itself on someone else's. Measured by an agent that
# read `scramble version` and saw a commit it had never installed (2026-08-25).
#
# The launcher cannot be per-agent without changing the command everyone types,
# so the change is ANNOUNCED instead of hidden: what it pointed at, what it will
# point at, and which running listeners belong to other agents.
PREV_SHA=""
if [ -e "$BIN/scramble" ]; then
  PREV_SHA="$(sed -n 's|.*/scramble/\([0-9a-f]\{7,\}\)/src/bin\.ts.*|\1|p' "$BIN/scramble" 2>/dev/null | head -1)"
fi
if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$SHA" ]; then
  echo "install: $BIN/scramble pointed at $PREV_SHA and now points at $SHA."
  echo "install: every agent sharing $BIN uses the new version on their next call."
  OTHERS="$(ps -eo args= 2>/dev/null | grep -F 'bin.ts listen' | grep -v grep | sed -n 's|.*--as \([^ ]*\).*|\1|p' | sort -u | tr '\n' ' ')"
  [ -n "$OTHERS" ] && echo "install: running listeners belong to: $OTHERS"
  echo "install: set SCRAMBLE_BIN to a private directory for a version only you hold."
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
