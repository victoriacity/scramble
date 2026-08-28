#!/usr/bin/env bash
# Arm every hook this repository ships, in one setting.
#
#   bash scripts/install_hooks.sh
#
# WHY A SCRIPT. `scripts/no_secrets_precommit.sh` documented this file as its
# installer and this file did not exist, so an agent following that comment armed
# nothing and kept committing with no credential check. The other route the comment
# offered, a symlink into `.git/hooks`, stops being read the moment `core.hooksPath`
# points elsewhere, which is how the pre-push hook is armed.
#
# ONE DIRECTORY HOLDS THE HOOKS and one setting points git at it.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

git config core.hooksPath .githooks
for h in .githooks/*; do
  [ -f "$h" ] || continue
  chmod +x "$h"
  echo "hooks: $(basename "$h") armed from $h"
done
echo "hooks: core.hooksPath is now $(git config core.hooksPath)"
echo "hooks: pre-commit refuses a staged credential; pre-push refuses a commit no green gate covered."
