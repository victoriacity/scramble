# This script runs under `/usr/bin/env bash` and refuses any commit that stages
# a live credential. Install it as the repository pre-commit hook by running
# `scripts/install_hooks.sh` or by executing
# `ln -s ../../scripts/no_secrets_precommit.sh .git/hooks/pre-commit`.
#
# This hook exists because a live Slack bot token and an app-level token were
# committed into this repository, which is going open source. Because the commit
# was at the tip and unpushed, it could be dropped, but a deletion commit would
# have left the tokens readable in every clone. Credentials belong outside the
# repository at `$SCRAMBLE_SLACK_CONFIG` (default
# `~/.config/scramble/slack.json`). The postmortem is documented in
# `log/postmortems/-committed-live-slack-credentials.md`.
set -uo pipefail

# Live credentials follow specific shapes. Each shape requires enough realistic
# payload so that placeholders in documentation and tests ("xoxb-123-456",
# "xoxb-1") do not match.
PATTERNS=(
  'xox[baprs]-[0-9]{9,}-[0-9]{9,}-[A-Za-z0-9]{16,}'   # bot/user/app tokens
  'xapp-[0-9]-[A-Z0-9]{9,}-[0-9]{9,}-[a-f0-9]{32,}'   # app-level tokens
  'sk_agent_[A-Za-z0-9_-]{20,}'                        # raft agent credentials
  'gh[pousr]_[A-Za-z0-9]{30,}'                         # GitHub tokens
  '"client_secret"[[:space:]]*:[[:space:]]*"[a-f0-9]{24,}"'
  '"signing_secret"[[:space:]]*:[[:space:]]*"[a-f0-9]{24,}"'
  'AKARI_SLACK_(BOT|APP)_TOKEN=xox'
)

staged=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$staged" ] && exit 0

hits=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  for p in "${PATTERNS[@]}"; do
    if git show ":$f" 2>/dev/null | grep -nEq "$p"; then
      echo "no_secrets: LIVE CREDENTIAL staged in $f"
      git show ":$f" 2>/dev/null | grep -nE "$p" | sed -E 's/(xox[baprs]-[0-9]{6})[A-Za-z0-9-]*/\1…REDACTED/g; s/(sk_agent_[A-Za-z0-9]{6})[A-Za-z0-9_-]*/\1…REDACTED/g; s/(gh[pousr]_[A-Za-z0-9]{6})[A-Za-z0-9]*/\1…REDACTED/g' | head -3
      hits=$((hits + 1))
    fi
  done
done <<< "$staged"

if [ "$hits" -gt 0 ]; then
  cat <<'MSG'

no_secrets: COMMIT REFUSED.
This repo is public-bound: a credential committed here is readable in every
clone, and a later deletion commit does not remove it from history.
Put it at $SCRAMBLE_SLACK_CONFIG (default ~/.config/scramble/slack.json, mode
600) and reference the path. If a token already reached a commit, rotate it.
MSG
  exit 1
fi
exit 0

