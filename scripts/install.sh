# !/usr/bin/env bash
# Install scramble into a path the operator controls, at a named commit.
#
# bash scripts/install.sh # into ~/.local/share/scramble
# bash scripts/install.sh --sandbox /tmp/try # a throwaway copy, shared launcher
# untouched
#
# WHY THIS EXISTS. `bun link` creates a symlink chain from the agent's PATH
# directly into the checkout: ~/.bun/bin/scramble -> node_modules/scramble -> the
# checkout itself, and bun runs `src` directly. Therefore, every agent on the host
# executes the maintainer's working tree. Every agent on the host that links this
# checkout receives edits immediately upon saving without pulling or signaling, so
# updating scramble moves only what a save has already applied. If an edit is
# saved mid-way, the syntax error runs inside the listener before the author meets
# it.
#
# An install copies the source out of the checkout, so the agent holds an isolated
# version. The installer refuses a dirty tree, because each copy must map to a
# named commit, and a partial edit has no name.
set -uo pipefail
cd "$(dirname "$0")/.."

fail() { echo "install: REFUSED: $*" >&2; exit 1; }

# A sandbox install relocates no shared resources. The `SCRAMBLE_HOME` variable
# covers only half of the setup: it redirects where the copy is written and
# leaves the launcher at its shared path, so an agent verifying a build in `/tmp`
# pointed every agent on their host at a `/tmp` directory they were about to
# delete because `SCRAMBLE_HOME` handles only half of the write operations.
#
# One flag controls this intent and configures both halves.
SANDBOX=""
if [ "${1:-}" = "--sandbox" ]; then
  SANDBOX="${2:-}"
  [ -n "$SANDBOX" ] || fail "--sandbox needs a directory: bash scripts/install.sh --sandbox /tmp/try"
fi

git rev-parse --git-dir >/dev/null 2>&1 || fail "this directory is not a git checkout"

# Partial isolation creates a hazard, so the configuration requires both settings
# together. A host with its own layout sets both and passes. A verification run
# wants --sandbox.
if [ -z "$SANDBOX" ] && [ -n "${SCRAMBLE_HOME:-}" ] && [ -z "${SCRAMBLE_BIN:-}" ]; then
  fail "SCRAMBLE_HOME is set and SCRAMBLE_BIN is not, so the copy would go to \$SCRAMBLE_HOME while the shared launcher keeps pointing every agent on this host at it. Use: bash scripts/install.sh --sandbox <dir>, or set both."
fi

# The installation process sources from `HEAD`. An in-progress edit cannot reach
# an installed copy and cannot block an install. An earlier check refused dirty
# working trees, identifying the danger correctly while using the wrong remedy:
# one checkout on this host serves as the install source for every local agent,
# so that refusal allowed an active edit cycle to block agent restarts. An agent
# hit this failure while restarting a listener and received half-finished files.
#
# `git archive HEAD` writes the committed bytes of that commit, so the copy is
# named by construction and an incomplete edit cannot enter.
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
# The full runtime consists of `src` and `package.json`. The `package.json` file
# lists no runtime dependencies, and `src` imports only Node built-in modules and
# its own files. The `skills` directory is included for the agents that read it.
#
# The contents of HEAD determine the paths, so the single archive command runs
# with its stderr visible. Running `2>/dev/null` on a first attempt with a fallback
# behind it hides the failure that matters when both attempts fail.
ARCHIVE_PATHS="src package.json"
git cat-file -e "HEAD:skills" 2>/dev/null && ARCHIVE_PATHS="$ARCHIVE_PATHS skills"
# The directive disables `SC2086` in `shellcheck`.
git archive HEAD $ARCHIVE_PATHS | tar -x -C "$DEST" || fail "cannot write HEAD's tree into $DEST"
[ -f "$DEST/src/bin.ts" ] || fail "$DEST/src/bin.ts is missing after writing HEAD's tree"
[ -f "$DEST/package.json" ] || fail "$DEST/package.json is missing after writing HEAD's tree"
printf '%s\n' "$SHA" > "$DEST/src/COMMIT"

# The installer reports the combined size of the roots once per install. Nothing
# prunes these roots, and that is deliberate because a running listener executes
# out of its own root, and an agent reproducing a drift advisory starts a listener
# from an old root. Unbounded growth that nobody prints remains unbounded, so the
# installer displays this number to the operator.
ROOTS="$(find "$ROOT" -maxdepth 1 -type d -name '[0-9a-f]*' 2>/dev/null | wc -l | tr -d ' ')"
SIZE="$(du -sh "$ROOT" 2>/dev/null | cut -f1)"
echo "install: $ROOTS installed copy(ies) under $ROOT, $SIZE total. Nothing prunes them, and a running listener runs out of its own."

ln -sfn "$DEST" "$ROOT/current" || fail "cannot point $ROOT/current at $DEST"

BIN="${SANDBOX:+$SANDBOX/bin}"
BIN="${BIN:-${SCRAMBLE_BIN:-$HOME/.bun/bin}}"
mkdir -p "$BIN" || fail "cannot create $BIN"
# The script removes the destination path before writing. The path being replaced
# is usually a symlink created by `bun link`, and `>` follows symlinks to their
# targets. The first execution of this script wrote the launcher through
# `~/.bun/bin/scramble` into `src/bin.ts` inside the checkout and emptied it.
# Because git tracked the file, the cost was a restore, but a subsequent install
# targeting an unversioned file would destroy it. One launcher serves every agent
# sharing this `HOME`, so an install moves all of them at once, and an agent that
# installed a commit and ran nothing since finds itself running someone else's
# commit. An agent measured this outcome when it ran `scramble version` and saw a
# commit it had never installed.
#
# The launcher cannot be per-agent without changing the command everyone types,
# so the script announces the change: what the launcher pointed at, what it will
# point at, and which running listeners belong to other agents. A hidden change
# moves someone else's version without notifying them.
PREV_SHA=""
if [ -e "$BIN/scramble" ]; then
  PREV_SHA="$(sed -n 's|.*/scramble/\([0-9a-f]\{7,\}\)/src/bin\.ts.*|\1|p' "$BIN/scramble" 2>/dev/null | head -1)"
fi
if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$SHA" ]; then
  echo "install: $BIN/scramble pointed at $PREV_SHA and now points at $SHA."
  echo "install: every agent sharing $BIN uses the new version on their next call."
  # WHAT CHANGED, DERIVED FROM GIT. An install moves every agent on this HOME, and
  # nothing told them what moved. A heartbeat line added to `message check` broke the
  # output guard on two hosts at once, and both agents debugged their own watcher
  # before either knew a line had been added. The subjects come from the commit log
  # between the two installed commits, so there is no second list to maintain and no
  # way for it to disagree with the code.
  if git cat-file -e "$PREV_SHA^{commit}" 2>/dev/null; then
    COUNT="$(git rev-list --count "$PREV_SHA..$SHA" 2>/dev/null || echo 0)"
    if [ "$COUNT" != "0" ]; then
      echo "install: $COUNT commit(s) between them, oldest first:"
      git log --reverse --format='install:   %h %s' "$PREV_SHA..$SHA"
      echo "install: a line added to any command's output can break a guard you wrote against it."
      # Other agents on this home never see the lines above. A single launcher serves
      # all of them, so an install by one agent provides a new build to the rest, and
      # the only notice they receive is a drift advisory containing two commit hashes.
      # One agent examined three `git log` ranges by hand today to decide whether its
      # listener was running code that mattered. Commit subjects are placed beside
      # COMMIT, where drift tools read them from the installed copy without requiring
      # their own checkout.
      { printf 'from %s\n' "$PREV_SHA"; git log --reverse --format='%h %s' "$PREV_SHA..$SHA"; } > "$DEST/src/CHANGES"
    fi
  else
    echo "install: $PREV_SHA is not a commit in this checkout, so what changed cannot be listed here."
  fi
  OTHERS="$(ps -eo args= 2>/dev/null | grep -F 'bin.ts listen' | grep -v grep | sed -n 's|.*--as \([^ ]*\).*|\1|p' | sort -u | tr '\n' ' ')"
  [ -n "$OTHERS" ] && echo "install: running listeners belong to: $OTHERS"
  # The system uses the shared launcher, so this line no longer offers a private
  # launcher. The line previously directed the user to set `SCRAMBLE_BIN` to a
  # private directory for an isolated version. An agent applied that configuration,
  # but each machine maintains one scramble version so every agent picks up the
  # same update. That agent deleted its private launcher and returned to the shared
  # launcher. The operator must restart the process, which is the only thing left
  # holding an old copy.
  echo "install: restart your listener to move it too; every other agent restarts their own."
fi
rm -f "$BIN/scramble" || fail "cannot remove the existing $BIN/scramble"
# The file is written without substitution. An unquoted heredoc runs command
# substitution on its own body, so the shell executes backticks inside a comment.
# The first version printed "current: command not found" three times because a
# comment named that symlink in backticks, and the generated launcher lacked
# those words. This same issue once ran the Slack CLI from a commit message.
# `printf` takes the single variable value as an argument, so the shell
# interprets nothing in the text.
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
# The launcher names the commit directory. This line previously stated that the
# launcher ran `current`, which is the symlink it deliberately avoids. An agent
# quoted that line back while reporting a version that had moved under it.
echo "install: $BIN/scramble runs $DEST, a copy of commit $SHA"
echo "install: confirm with  scramble version"

