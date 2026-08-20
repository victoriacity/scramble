#!/usr/bin/env bash
# The ONE dispatch path for scramble units. Exists because a hand-typed launch
# line cannot check its own preconditions: on 2026-08-20 a `source` of the
# systemd-format akari-fix.env failed mid-line, the `nohup akari run` after it
# STILL fired, and the retry left two clients running the same 8-unit workflow
# (postmortem: log/postmortems/2026-08-20-duplicate-dispatch-survived-a-failed-source.md
# in the akrust repo). Every precondition below is a REFUSAL, not a warning.
#
# usage: scripts/dispatch.sh [<workflow.ts>]   (default: scramble.workflow.ts)
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
WORKFLOW="${1:-$REPO/scramble.workflow.ts}"
ENV_FILE=/opt/akari/akrust/scripts/lead/systemd-staging/akari-fix.env
CLI=/opt/akari/akari/akari/packages/dispatch/src/cli.ts
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

fail() { echo "dispatch: REFUSED — $*"; exit 1; }

# 1) SINGLE CLIENT. The duplicate-run defect this script exists for.
live=$(ps ax -o args= | grep "dispatch/src/cli.ts run" | grep -v grep | wc -l)
[ "$live" -eq 0 ] || {
  echo "dispatch: a run is ALREADY live ($live client(s)):"
  ps ax -o pid=,args= | grep "dispatch/src/cli.ts run" | grep -v grep
  fail "refusing to start a second run of the same workflow"
}

# 2) The credential, extracted -- never sourced. The env file is systemd-format:
#    bash dies on its unquoted AKARI_PROVIDER_CHAIN JSON, and its PATH line drops
#    the dir holding the `akari` shim.
[ -r "$ENV_FILE" ] || fail "cannot read $ENV_FILE"
TOKEN="$(grep -m1 '^AKARI_SERVER_CONTROL_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$TOKEN" ] || fail "AKARI_SERVER_CONTROL_TOKEN missing from $ENV_FILE (POST /api/projects would 401)"

# 3) Absolute CLI path, so a rewritten PATH cannot substitute a stale copy from
#    inside a lane worktree (that is what happened on 2026-08-20).
[ -r "$CLI" ] || fail "dispatch CLI not readable at $CLI"
[ -x "$BUN" ] || fail "bun not found (tried PATH and \$HOME/.bun/bin/bun)"

# 4) The structural gate needs this repo's new top-level paths declared, or every
#    worker spends turns teaching the gate about its own deliverable.
[ -r "$REPO/.akari/gate.toml" ] || fail "$REPO/.akari/gate.toml missing"

# 4b) gate.toml SHAPE. akari's parse_gate_toml
#     (lane/crates/akari-lane/src/gate_green/extra_steps.rs:169) is LINE-BASED:
#     it accepts only inline single-line arrays of double-quoted strings. A
#     multi-line array makes the gate fail with `key must be a string at line 1
#     column 2`, and the worker then spends its turns reading akari's Rust
#     parser instead of writing its unit (that happened on 2026-08-20).
python3 - "$REPO/.akari/gate.toml" <<'PYEOF' || fail "see the gate.toml shape error above"
import json, re, sys
path = sys.argv[1]
lines = open(path).read().splitlines()
bad = []
for i, line in enumerate(lines, 1):
    s = line.strip()
    if not s or s.startswith("[") :
        continue
    if s.startswith("#"):
        bad.append(f"line {i}: comment -- the parser surface is line-based, keep this file comment-free: {s}")
        continue
    if "=" not in s:
        bad.append(f"line {i}: not a `key = value` line (a multi-line array continuation?): {s}")
        continue
    val = s.split("=", 1)[1].strip()
    if val.startswith("["):
        if not val.endswith("]"):
            bad.append(f"line {i}: array is not closed on the SAME line (multi-line arrays are rejected): {s}")
        else:
            try:
                parsed = json.loads(val)
                if not all(isinstance(x, str) for x in parsed):
                    bad.append(f"line {i}: array must hold only double-quoted strings: {s}")
            except Exception:
                bad.append(f"line {i}: array is not a valid inline JSON-style array: {s}")
if bad:
    print("dispatch: REFUSED -- .akari/gate.toml would break akari's line-based parser:")
    for b in bad:
        print(f"  {b}")
    sys.exit(1)
sys.exit(0)
PYEOF

[ -r "$WORKFLOW" ] || fail "workflow not readable: $WORKFLOW"

# 5) The daemon must answer before we claim a launch.
health=$(curl -s --max-time 5 http://127.0.0.1:8771/api/health)
case "$health" in
  *'"ok":true'*) : ;;
  *) fail "akari-server /api/health did not report ok: ${health:-<no response>}" ;;
esac

export AKARI_SERVER_CONTROL_TOKEN="$TOKEN"
export AKARI_WORKSPACE_DIR="$REPO"
export AKARI_BASE_URL=http://127.0.0.1:8771
LOG="$REPO/run.log"
nohup "$BUN" run "$CLI" run "$WORKFLOW" > "$LOG" 2>&1 &
pid=$!
echo "dispatch: launched pid $pid  workflow=$WORKFLOW  log=$LOG"
echo "dispatch: preconditions verified — single client, credential present, CLI $CLI, gate.toml present, daemon ok"
