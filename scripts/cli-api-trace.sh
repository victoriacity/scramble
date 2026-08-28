# Run a vendor CLI through this script to determine which API calls it makes.
# Vendor documentation can suggest that an API does not exist.
#
# scripts/cli-api-trace.sh slack app install --team T012345 --force
#
# This tool exists because documentation previously asserted that Slack has "no
# API to create or install an app", so onboarding each agent required a human in a
# browser. The Slack CLI creates and installs apps, and its debug log names the
# endpoints it calls. `apps.manifest.create` and `apps.developerInstall` are
# public methods, and passing the WORKSPACE team_id to them converts an
# admin-approval wall into ok:true plus the tokens. (postmortem:
# `log/postmortems/-said-no-api-exists-while-the-cli-on-this-box-called-it.md`)
#
# This encodes the rule that a capability verdict about a vendor cites the
# endpoints its own tool called. Published documentation is a claim about those
# endpoints.
set -uo pipefail

[ $# -gt 0 ] || { echo "usage: $0 <cli> [args...]   (example: $0 slack app install --force)" >&2; exit 2; }

LOGDIR="${SLACK_CLI_LOG_DIR:-$HOME/.slack/logs}"
STAMP="$(date +%Y%m%d)"
LOG="$LOGDIR/slack-debug-$STAMP.log"
BEFORE=0
[ -f "$LOG" ] && BEFORE=$(wc -l < "$LOG")

echo "trace: running: $*"
"$@" --verbose 2>&1 | tail -25 || true

[ -f "$LOG" ] || { echo "trace: no debug log at $LOG; this tracer knows the Slack CLI's log only." >&2; exit 1; }

echo
echo "trace: API methods this invocation called, in order, with what each answered:"
tail -n "+$((BEFORE + 1))" "$LOG" | python3 -c '
import re, sys
method = None
for line in sys.stdin:
    m = re.search(r"HTTP Request: [A-Z]+ https://[^/]+/api/([A-Za-z0-9._]+)", line)
    if m:
        method = m.group(1)
        print(f"  -> {method}")
        continue
    r = re.search(r"\{\"ok\":(true|false)(\"error\":\"([^\"]+)\")?", line)
    if r and method:
        err = r.group(3) or "(no error field)"
        verdict = "ok" if r.group(1) == "true" else "FAILED " + err
        print(f"     {verdict}")
        method = None
'
echo
echo "trace: a claim that some capability has no API must contradict this list, not the docs."

