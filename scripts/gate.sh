#!/usr/bin/env bash
# The merge gate: the coverage threshold is proven to BITE, then types clean,
# every test green, coverage at 100%.
# No pipes through tail/head/grep -- an exit code masked by a pipe is a lie.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

# bun resolution, widest first. An akari worker runs with a different HOME than
# the lead (uid 0, full rootfs), so $HOME/.bun is not a safe single answer. A
# host whose bun is somewhere else sets SCRAMBLE_BUN rather than editing this
# file: an absolute path from one machine does not belong in a shared repo. On failure print EVERY candidate
# tried, not a summary.
BUN=""
for cand in "$(command -v bun 2>/dev/null)" "${SCRAMBLE_BUN:-}" \
            "$HOME/.bun/bin/bun" /usr/local/bin/bun; do
  [ -n "$cand" ] && [ -x "$cand" ] && { BUN="$cand"; break; }
done
[ -n "$BUN" ] || {
  echo "GATE FAIL: bun not found. Tried, in order:"
  echo "  command -v bun -> $(command -v bun 2>/dev/null || echo '<none>')"
  echo "  \$HOME/.bun/bin/bun -> $HOME/.bun/bin/bun"
  echo "  \$SCRAMBLE_BUN -> ${SCRAMBLE_BUN:-<unset>}"
  echo "  /usr/local/bin/bun"
  exit 1
}

# == stage 0: COVERAGE-GATE SELF-TEST ==
# A coverage threshold is a claim about bun's behavior, and a config key bun
# ignores produces no error anywhere -- the only observable difference is an exit
# code. bun 1.3.14 silently ignores `coverageThreshold` written as an inline
# table and exits 0 at partial coverage, so this gate once reported green over
# 57% coverage (postmortem:
# akrust log/postmortems/2026-08-20-coverage-gate-was-decorative-ignored-threshold.md).
# Before trusting a single number below, run the REPO'S OWN bunfig against a
# fixture with a deliberately untested branch and require it to FAIL.
SELF="$(mktemp -d)"
trap 'rm -rf "$SELF"' EXIT
mkdir -p "$SELF/src" "$SELF/test"
cp "$REPO/bunfig.toml" "$SELF/bunfig.toml"
cat > "$SELF/src/probe.ts" <<'PROBE'
export function branchy(n: number): string {
  if (n > 0) {
    return "pos";
  }
  const s = "neg";
  return s;
}
PROBE
cat > "$SELF/test/probe.test.ts" <<'PROBETEST'
import { expect, test } from "bun:test";
import { branchy } from "../src/probe";
test("covers only the positive branch, on purpose", () => {
  expect(branchy(1)).toBe("pos");
});
PROBETEST
echo "== gate self-test: the coverage threshold must FAIL a partial fixture =="
( cd "$SELF" && "$BUN" test --coverage >/dev/null 2>&1 )
self_rc=$?
if [ "$self_rc" -eq 0 ]; then
  echo "GATE SELF-TEST FAILED: the coverage threshold in $REPO/bunfig.toml is NOT enforced."
  echo "A fixture with an untested branch passed (rc=0) under this repo's own bunfig."
  echo "bun ignores coverageThreshold written as an inline table -- use the SCALAR form."
  echo "Fixture kept for inspection is gone with the tempdir; reproduce with:"
  echo "  the src/probe.ts + test/probe.test.ts pair in this script"
  echo "GATE RED"
  exit 1
fi
echo "self-test ok: partial coverage exits $self_rc under this repo's bunfig"

# NO MACHINE PATH IN A TRACKED FILE. This repo is bound for GitHub, and on
# 2026-08-21 it carried six: my home directory inside this very script, two akari
# paths in dispatch.sh, and my checkout's path inside the onboarding call to
# action in the README. A path from one machine is wrong in every clone of the
# repo, and prose review kept missing them.
# (postmortem: akrust log/postmortems/2026-08-21-shipped-my-own-machine-paths-in-a-public-repo.md)
echo "== no machine paths in tracked files =="
python3 - <<'PATHEOF'
import re, subprocess, sys
# A home or install directory belongs to a machine. A doc that must show one
# writes a placeholder (<your-home>, <path-to-scramble>) or $HOME.
FORBIDDEN = re.compile(r"(/home/|/Users/|/opt/|/storage/|/root/)[A-Za-z0-9._-]+")
files = [f for f in subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True).stdout.split("\0") if f]
bad = []
for f in files:
    try:
        text = open(f, encoding="utf-8").read()
    except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
        continue
    for n, line in enumerate(text.splitlines(), 1):
        for m in FORBIDDEN.finditer(line):
            bad.append((f, n, m.group(0), line.strip()[:90]))
if bad:
    print("GATE FAIL: a tracked file carries a machine path:")
    for f, n, hit, line in bad:
        print(f"  {f}:{n}: {hit}   in: {line}")
    print("Use a placeholder or $HOME. A path from one machine is wrong in every clone.")
    sys.exit(1)
print("no machine paths in tracked files")
sys.exit(0)
PATHEOF
paths_rc=$?

echo "== tracked files are written in English =="
python3 - <<'LANGEOF'
import re, subprocess, sys
# The operator to every agent in the channel, 2026-08-22: "ensure everything you
# write to files are English unless it is explicitly requested as another
# language". This repo is public and several agents commit to it, so the rule
# holds here rather than in each agent's memory.
#
# CJK, Hiragana, Katakana, Hangul, Cyrillic, Arabic, Hebrew, Thai, Devanagari.
# Latin-1 punctuation is NOT flagged: an em dash is typography, and the language
# rules deal with it separately.
SCRIPTS = re.compile(
    "[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    "\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0590-\u05ff"
    "\u0e00-\u0e7f\u0900-\u097f]"
)
files = [f for f in subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True).stdout.split("\0") if f]
bad = []
for f in files:
    try:
        text = open(f, encoding="utf-8").read()
    except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
        continue
    for n, line in enumerate(text.splitlines(), 1):
        if SCRIPTS.search(line):
            bad.append((f, n, line.strip()[:90]))
if bad:
    print("GATE FAIL: a tracked file is not written in English:")
    for f, n, line in bad:
        print(f"  {f}:{n}: {line}")
    print("Write files in English. A name from another script belongs in a variable, never in prose.")
    sys.exit(1)
print("tracked files are written in English")
sys.exit(0)
LANGEOF
lang_rc=$?

# EVERY SKILL AND EVERY MARKDOWN FILE AN AGENT READS GOES THROUGH THE SAME RULES
# THE SEND APPLIES. A skill telling agents how to write, written in the prose
# those rules forbid, teaches the opposite of what it says. Asked for directly
# after the communication skill shipped, and it belongs in the gate because a
# rule anybody has to remember is one that holds until they are busy.
echo "== every skill file passes the language check =="
# SCOPED TO WHAT AN AGENT READS AS INSTRUCTIONS: the skills, the joining
# instructions handed to every new agent, and the persona this agent publishes
# about itself. The design documents are prose about the build and carry 39 hits
# today; widening this stage to them is a separate piece of work, and naming this
# stage for what it actually checks keeps the summary honest.
SKILL_FILES=$(git -C "$REPO" ls-files 'skills/*.md' 'JOIN.md' '.scramble/persona.md' || true)
if [ -n "$SKILL_FILES" ]; then
  # shellcheck disable=SC2086
  ( cd "$REPO" && "$BUN" src/bin.ts lint $SKILL_FILES )
  skill_rc=$?
else
  echo "no markdown files tracked"
  skill_rc=0
fi

echo "== tsc --noEmit =="
"$BUN" x tsc --noEmit
tsc_rc=$?

echo "== bun test --coverage =="
"$BUN" test --coverage
test_rc=$?

echo "== gate summary =="
echo "self_test_rc=$self_rc (nonzero required) paths_rc=$paths_rc lang_rc=$lang_rc skill_rc=$skill_rc tsc_rc=$tsc_rc test_rc=$test_rc"
if [ "$paths_rc" -ne 0 ] || [ "$lang_rc" -ne 0 ] || [ "$skill_rc" -ne 0 ] || [ "$tsc_rc" -ne 0 ] || [ "$test_rc" -ne 0 ]; then
  echo "GATE RED"
  exit 1
fi
echo "GATE GREEN"
