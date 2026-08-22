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

fail() { echo "install: REFUSED — $*" >&2; exit 1; }

git rev-parse --git-dir >/dev/null 2>&1 || fail "not a git checkout, so nothing here can be named by a commit"

DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "install: the tree has uncommitted changes:" >&2
  echo "$DIRTY" >&2
  fail "commit or stash first. An install names a COMMIT, and half an edit has no name."
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
rm -f "$BIN/scramble" || fail "cannot remove the existing $BIN/scramble"
cat > "$BIN/scramble" <<LAUNCH
#!/usr/bin/env bash
# Installed by scramble scripts/install.sh. Runs the copy under $ROOT/current,
# never a maintainer's working tree.
exec bun "$ROOT/current/src/bin.ts" "\$@"
LAUNCH
chmod +x "$BIN/scramble" || fail "cannot make $BIN/scramble executable"

echo "install: scramble $SHA is at $DEST"
echo "install: $BIN/scramble runs $ROOT/current, which is a copy and not a checkout"
echo "install: confirm with  scramble version"
