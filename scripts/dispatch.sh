#!/usr/bin/env bash
# The ONE dispatch path for scramble units. Exists because a hand-typed launch line cannot check its
# own preconditions: a `source` of the systemd-format akari-fix.env failed mid-line, the `nohup
# akari run` after it STILL fired, and the retry left two clients running the same 8-unit workflow
# (postmortem: `log/postmortems/-duplicate-dispatch-survived-a-failed-source.md` in the akrust
# repo). Every precondition below is a REFUSAL, not a warning.
#
# usage: scripts/dispatch.sh [<workflow.ts>]   (default: scramble.workflow.ts)
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
WORKFLOW="${1:-$REPO/scramble.workflow.ts}"
# WHERE AKARI LIVES IS THIS MACHINE'S BUSINESS, not the repo's. Both paths come
# from the environment, and an unset one is a refusal naming the variable, so no
# checkout carries one developer's directory layout.
ENV_FILE="${AKARI_FIX_ENV:-}"
CLI="${AKARI_DISPATCH_CLI:-}"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

fail() { echo "dispatch: REFUSED — $*"; exit 1; }

# 1) NO DUPLICATE OF *THIS* WORKFLOW. The defect this script exists for is two
#    clients running the SAME workflow file, which duplicates every unit. A run
#    of a DIFFERENT workflow is parallelism, which is wanted: units with no
#    dependency on each other should be in flight at the same time, bounded by
#    the lane pool, not by this script.
same=$(ps ax -o args= | grep "dispatch/src/cli.ts run" | grep -v grep | grep -c -- "$WORKFLOW")
[ "$same" -eq 0 ] || {
  echo "dispatch: this workflow is ALREADY live ($same client(s)):"
  ps ax -o pid=,args= | grep "dispatch/src/cli.ts run" | grep -v grep | grep -- "$WORKFLOW"
  fail "refusing to duplicate the units of $WORKFLOW"
}
others=$(ps ax -o args= | grep "dispatch/src/cli.ts run" | grep -v grep | grep -vc -- "$WORKFLOW")
[ "$others" -eq 0 ] && echo "dispatch: no other workflow live" || echo "dispatch: $others other workflow(s) live — running alongside them (intended parallelism)"

# 2) The credential, extracted -- never sourced. The env file is systemd-format:
#    bash dies on its unquoted AKARI_PROVIDER_CHAIN JSON, and its PATH line drops
#    the dir holding the `akari` shim.
[ -n "$ENV_FILE" ] || fail "set AKARI_FIX_ENV to the akari env file holding AKARI_SERVER_CONTROL_TOKEN"
[ -n "$CLI" ] || fail "set AKARI_DISPATCH_CLI to akari's packages/dispatch/src/cli.ts"
[ -r "$ENV_FILE" ] || fail "cannot read $ENV_FILE (from AKARI_FIX_ENV)"
TOKEN="$(grep -m1 '^AKARI_SERVER_CONTROL_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$TOKEN" ] || fail "AKARI_SERVER_CONTROL_TOKEN missing from $ENV_FILE (POST /api/projects would 401)"

# 3) Absolute CLI path, so a rewritten PATH cannot substitute a stale copy from
#    inside a lane worktree, which is what happened.
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
#     parser and never wrote its unit, which happened.
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
        # The parser skips comment lines (extra_steps.rs: `line.starts_with('#')
        # { continue }`), so a comment is fine. Only the ARRAY shape matters.
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

# 4c) BACKEND SCOPE. On I built a raft backend inside scramble, 249
#     lines plus 433 of tests, for a product the operator considers scramble's
#     parallel alternative; it became deleted work. A boundary that lives only in
#     my judgment gets crossed again, so DESIGN.md's backend table is the
#     authority: a workflow naming a backend the table does not list is refused.
#     Postmortem: akrust `log/postmortems/2026-08-21-built-a-backend-for-a-parallel-product.md`
python3 - "$WORKFLOW" "$REPO/DESIGN.md" <<'PYEOF' || fail "see the backend-scope error above"
import re, sys
wf, design = open(sys.argv[1]).read(), open(sys.argv[2]).read()
wanted = set(re.findall(r"SCRAMBLE_BACKEND=([A-Za-z0-9_-]+)", wf))
listed = set(re.findall(r"SCRAMBLE_BACKEND=([A-Za-z0-9_-]+)", design)) | {"local", "default"}
unlisted = sorted(w for w in wanted if w not in listed)
if unlisted:
    print("dispatch: REFUSED -- this workflow names a backend DESIGN.md does not list:")
    for u in unlisted:
        print(f"  {u}")
    print(f"listed backends: {', '.join(sorted(listed))}")
    print("Add the backend to DESIGN.md's table as a design decision first, or drop it from the workflow.")
    sys.exit(1)
sys.exit(0)
PYEOF

# 4d) CROSS-WORKFLOW FILE CONFLICT. On I ran four units at once. One
#     deleted src/slack.ts and src/raft.ts while another was writing the thread
#     feature INTO those files, so the merge cliffed the feature: the spec commits
#     survived and the implementation did not. Prose in a prompt ("port before
#     deleting") did not hold. A workflow that DELETES a path may not run while a
#     live workflow names that same path.
#     Postmortem: akrust `log/postmortems/2026-08-21-parallel-delete-cliffed-a-feature.md`
python3 - "$WORKFLOW" <<'PYEOF' || fail "see the cross-workflow conflict above"
import re, subprocess, sys
new = open(sys.argv[1]).read()
def paths(text):
    return set(re.findall(r"src/[A-Za-z0-9_-]+\.ts", text))
def deleted(text):
    # A DELETE heading sits on its own line with the paths BELOW it, so a
    # line-scoped scan found nothing and let a conflicting dispatch through on the
    # first attempt. Coarse and safe instead: a workflow that speaks of deleting
    # treats every src path it names as a deletion candidate. A false refusal
    # costs a wait; a false pass costs another unit's work.
    return paths(text) if re.search(r"(?i)\bdelet", text) else set()
ps = subprocess.run(["ps", "ax", "-o", "args="], capture_output=True, text=True).stdout
live = [ln.split(" run ")[-1].strip() for ln in ps.splitlines()
        if "dispatch/src/cli.ts run" in ln and ".workflow.ts" in ln]
live = [f for f in live if f.endswith(".workflow.ts") and f != sys.argv[1]]
conflicts = []
for f in live:
    try:
        other = open(f).read()
    except OSError:
        continue
    for p in (deleted(new) & paths(other)) | (deleted(other) & paths(new)):
        conflicts.append((p, f))
if conflicts:
    print("dispatch: REFUSED -- a live workflow names a path this one deletes (or the reverse):")
    for p, f in sorted(set(conflicts)):
        print(f"  {p}  also named by {f}")
    print("Run the deletion alone, or let the live unit finish first: a concurrent")
    print("delete-versus-add drops the added work and keeps only the spec commit.")
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
# One log PER WORKFLOW: concurrent runs are intended, and a shared log means two
# clients interleaving into one file, so a failure record can be clobbered.
LOG="$REPO/run-$(basename "$WORKFLOW" .workflow.ts).log"
nohup "$BUN" run "$CLI" run "$WORKFLOW" > "$LOG" 2>&1 &
pid=$!

# 6) THE LAUNCH ITSELF IS VERIFIED. A workflow whose meta held an
#    escaped apostrophe ('a peer agent\'s') failed the client's pure-object-literal
#    parse and the client exited in under a second, while this script had already
#    printed "launched pid" and "preconditions verified". I read that as a live
#    unit and dispatched a second one alongside a corpse. A script that claims a
#    launch must READ the launch: the pid must still be alive and the log must not
#    hold a client-side refusal.
sleep 3
if ! kill -0 "$pid" 2>/dev/null; then
  echo "dispatch: the client EXITED within 3s of launch. Its whole log:"
  cat "$LOG"
  fail "no unit is running (log: $LOG)"
fi
case "$(cat "$LOG")" in
  *'"ok":false'*)
    echo "dispatch: the client reported a refusal. Its whole log:"
    cat "$LOG"
    fail "the workflow was rejected by the client (log: $LOG)"
    ;;
esac
echo "dispatch: launched pid $pid  workflow=$WORKFLOW  log=$LOG"
echo "dispatch: preconditions verified — single client, credential present, CLI $CLI, gate.toml present, daemon ok, client alive 3s after launch"
