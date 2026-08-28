#!/usr/bin/env bash
# The merge gate: the coverage threshold is proven to BITE, then types clean,
# every test green, coverage at 100%.
# No pipes through tail/head/grep -- an exit code masked by a pipe is a lie.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

# bun resolution, widest first. An akari worker runs with a different HOME than
# the lead (uid 0, full rootfs), so $HOME/.bun is not a safe single answer. A
# host whose bun is somewhere else sets SCRAMBLE_BUN, since an absolute path from
# one machine does not belong in a shared repo. On failure print EVERY candidate
# tried, and never a summary.
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

# == stage 0: COVERAGE-GATE SELF-TEST == A coverage threshold is a claim about bun's behavior, and a
# config key bun ignores produces no error anywhere -- the only observable difference is an exit
# code. bun 1.3.14 silently ignores `coverageThreshold` written as an inline table and exits 0 at
# partial coverage, so this gate once reported green over 57% coverage (postmortem: akrust
# `log/postmortems/-coverage-gate-was-decorative-ignored-threshold.md`). Before trusting a single
# number below, run the REPO'S OWN bunfig against a fixture with a deliberately untested branch and
# require it to FAIL.
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

# NO MACHINE PATH IN A TRACKED FILE. This repo is bound for GitHub, and it carried six: my home
# directory inside this very script, two akari paths in dispatch.sh, and my checkout's path inside
# the onboarding call to action in the README. A path from one machine is wrong in every clone of
# the repo, and prose review kept missing them. (postmortem: akrust
# `log/postmortems/-shipped-my-own-machine-paths-in-a-public-repo.md`)
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
# The operator to every agent in the channel: "ensure everything you write to files are English
# unless it is explicitly requested as another language". This repo is public and several agents
# commit to it, so the rule holds here, where each agent's memory would hold it unevenly.
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
echo "== every tracked markdown file passes the language check =="
# EVERY TRACKED MARKDOWN FILE, covering the repo an outsider reads: the
# README first, the skills, the joining instructions, the design and plan
# documents, this agent's published persona.
#
# It was scoped to the skills when it was added, and README.md sat outside it.
# The README happened to be clean, which was luck: nothing was keeping it that
# way, and being asked whether it had been linted is what surfaced that. The
# design documents carried 41 hits between them and are fixed.
#
# log/ is excluded: those are dated records of what was said and measured at the
# time, and rewriting them to pass a rule written later would destroy the record.
SKILL_FILES=$(git -C "$REPO" ls-files '*.md' | grep -v '^log/' || true)
if [ -n "$SKILL_FILES" ]; then
  # shellcheck disable=SC2086
  ( cd "$REPO" && "$BUN" src/bin.ts lint $SKILL_FILES )
  skill_rc=$?
else
  echo "no markdown files tracked"
  skill_rc=0
fi

# THE COMMENTS IN THE SOURCE ARE PROSE A PERSON READS. The operator, quoting a banned form out of a
# refusal string and then finding another in a comment I had shipped an hour before: "Clean the
# comments first." The rules covered messages and tracked markdown, and the source comments carried
# 174 hits, measured before the cleanup.
#
# Comment lines only: the rule table's own patterns contain the words it bans.
echo "== every source comment passes the language check =="
COMMENT_FILES=$(git -C "$REPO" ls-files 'src/*.ts')
if [ -n "$COMMENT_FILES" ]; then
  # shellcheck disable=SC2086
  ( cd "$REPO" && "$BUN" src/bin.ts lint --comments $COMMENT_FILES )
  comment_rc=$?
else
  echo "no source files tracked"
  comment_rc=0
fi

# THE SAME RULES OVER THE TESTS, THE SCRIPTS AND THE WORKFLOWS. This stage
# checked one rule when it was added, since these directories held 121 hits of
# the others and a red gate teaches nothing while the backlog sits. The backlog
# is drained, so the stage checks what the source comments are checked for.
echo "== the tests, the scripts and the workflows pass the language check =="
DATE_FILES=$(git -C "$REPO" ls-files 'test/*.ts' 'scripts/*.ts' 'scripts/*.sh' 'workflows/*.workflow.ts')
if [ -n "$DATE_FILES" ]; then
  # shellcheck disable=SC2086
  ( cd "$REPO" && "$BUN" src/bin.ts lint --comments $DATE_FILES )
  dates_rc=$?
else
  echo "no test or script files tracked"
  dates_rc=0
fi

echo "== tsc --noEmit =="
"$BUN" x tsc --noEmit
tsc_rc=$?

# EVERY SHIPPED SOURCE FILE IS IN THE COVERAGE REPORT. bun reports the files its tests LOAD, so a
# source file nothing imports is absent from the table entirely and the 100% threshold passes over
# it in silence. src/rewrite.ts shipped that way for an hour: 189 lines, no test, and a green gate.
# NO CREDENTIAL-SHAPED STRING IN A TRACKED FILE. This repo is PUBLIC and five agents commit to it,
# and a key was about to be placed in the checkout by hand. The cost of a leak is a rotation across
# every agent on two hosts, so this runs on every gate, where memory would hold it unevenly.
echo "== no credential-shaped string in a tracked file =="
# A PLACEHOLDER IS NOT A LEAK. The setup document shows the shape of a config
# with `xapp-1-A0EXAMPLE001-...` in it, and a scan that cannot tell that from a
# key is one people learn to wave through. A run of zeros or an ellipsis inside
# the match is a placeholder; a real credential has neither.
LEAKS="$(git -C "$REPO" grep -InE 'xox[bpasre]-[A-Za-z0-9-]{12,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|xapp-[0-9]-[A-Za-z0-9-]{12,}' -- . ':(exclude)scripts/gate.sh' 2>/dev/null | grep -vE '\.\.\.|0{6,}|EXAMPLE|<[a-z-]+>' || true)"
if [ -n "$LEAKS" ]; then
  echo "GATE FAIL: a tracked file carries something shaped like a credential:"
  echo "$LEAKS"
  echo "Remove it, rotate the credential, and keep keys out of the checkout."
  leak_rc=1
else
  echo "no credential-shaped strings in tracked files"
  leak_rc=0
fi

# NOTHING FROM THE PRIVATE WORKSPACE IN A PUBLIC FILE. This repository is
# published, and the names carrying the company, its products, its hosts and its
# people's Slack accounts were spread across tests, fixtures, comments and one
# calibration table. A scrub with no gate behind it comes back the next time
# somebody quotes a channel message into a comment, which is how most of them
# arrived.
echo "== no private-workspace reference in a tracked file =="
# THE PATTERN IS ASSEMBLED FROM FRAGMENTS so this file carries no machine path of
# its own, which the paths stage above would flag.
HOME_DIRS="/j""fs/home|/st""orage/home"
USER_NAME="sy""zs"
# EVERY NEEDLE IS ASSEMBLED FROM FRAGMENTS, and no literal appears here. The
# history rewrite replaced the company name inside this very pattern, which left
# the detector searching for its own replacement and matching every placeholder.
COMPANY="me""shy"
PRODUCT="mu""se[_-]"
PRIVATE="$(git -C "$REPO" grep -IniE "$COMPANY|$PRODUCT|$HOME_DIRS|$USER_NAME|4090" -- . ':(exclude)scripts/gate.sh' 2>/dev/null || true)"
# A REAL SLACK ACCOUNT ID identifies a person, and the fixtures now carry ids with
# EXAMPLE in them so the shape stays testable.
IDS="$(git -C "$REPO" grep -InE '\b(U0|T0|E0|B0|A0|W0)[0-9A-Z]{8,}' -- . ':(exclude)scripts/gate.sh' 2>/dev/null | grep -vE 'EXAMPLE|0{6,}' || true)"
if [ -n "$PRIVATE" ] || [ -n "$IDS" ]; then
  echo "GATE FAIL: a tracked file names the private workspace or a real Slack account:"
  [ -n "$PRIVATE" ] && echo "$PRIVATE"
  [ -n "$IDS" ] && echo "$IDS"
  echo "Use a neutral name. An example id carries EXAMPLE so this scan can tell it from a real one."
  private_rc=1
else
  echo "no private-workspace references and no real account ids in tracked files"
  private_rc=0
fi

echo "== every src file reaches the coverage report =="
COVERED=$("$BUN" test --coverage 2>&1 | grep -oE 'src/[a-z-]+\.ts' | sort -u)
MISSING=""
for f in $(git -C "$REPO" ls-files 'src/*.ts'); do
  case "$f" in
    src/types.ts|src/bin.ts) continue ;;  # types carry no code; bin.ts is the entrypoint no test imports
  esac
  echo "$COVERED" | grep -qx "$f" || MISSING="$MISSING $f"
done
if [ -n "$MISSING" ]; then
  echo "GATE FAIL: shipped source absent from the coverage report:$MISSING"
  echo "Nothing imports these, so the 100% threshold never looked at them. Write a test."
  cover_rc=1
else
  echo "every src file is in the coverage report"
  cover_rc=0
fi

echo "== bun test --coverage =="
"$BUN" test --coverage
test_rc=$?

echo "== gate summary =="
echo "self_test_rc=$self_rc (nonzero required) paths_rc=$paths_rc lang_rc=$lang_rc skill_rc=$skill_rc comment_rc=$comment_rc dates_rc=$dates_rc leak_rc=$leak_rc private_rc=$private_rc cover_rc=$cover_rc tsc_rc=$tsc_rc test_rc=$test_rc"
if [ "$paths_rc" -ne 0 ] || [ "$lang_rc" -ne 0 ] || [ "$skill_rc" -ne 0 ] || [ "$comment_rc" -ne 0 ] || [ "$dates_rc" -ne 0 ] || [ "$leak_rc" -ne 0 ] || [ "$private_rc" -ne 0 ] || [ "$cover_rc" -ne 0 ] || [ "$tsc_rc" -ne 0 ] || [ "$test_rc" -ne 0 ]; then
  echo "GATE RED"
  exit 1
fi
echo "GATE GREEN"
