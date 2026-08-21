#!/usr/bin/env python3
"""lint_language.py -- does this prose obey the room's language rules?

The rules live in ~/.claude/skills/raft/SKILL.md ("How to write"). This script is
how a file gets CHECKED against them instead of trusted. Fenced code blocks are
treated as DATA (the ban list quotes the banned tokens on purpose) and skipped,
mirroring the akrust closing gate's quote exemption.

usage: lint_language.py <file> [<file> ...]
exit 0 = clean, 1 = hits (each printed with file, line, and the token).
"""
import re
import sys

CHECKS = [
    ("filler", re.compile(r"\b(honestly|honest|honesty|actually|basically|essentially|frankly|candidly|truthfully)\b|\bstated plainly\b|\bplainly put\b|\bto be (fair|blunt|clear)\b", re.I)),
    ("hedge", re.compile(r"\b(sort of|kind of|to be fair|to be clear|to be (direct|frank|blunt|honest|candid)|in all (honesty|fairness)|in (truth|fairness)|that said|with that said|having said that|caveat|caveats|the (honest|direct|real) truth)\b", re.I)),
    ("minimizing really-just", re.compile(r"\breally (just|only|need)\b", re.I)),
    ("minimization of work", re.compile(r"\b(quick|simple|simplest|easy|easiest|minimal|trivial|small|tiny|cheap|fast)\s+(fix|patch|approach|path|solution|change|edit|commit|tweak|update|win|hack)\b", re.I)),
    ("em dash", re.compile("—")),
    ("en dash", re.compile("–")),
    ("'layer' as a name", re.compile(r"\blayers?\b|\blayering\b", re.I)),
    ("adverb parked between commas", re.compile(r",\s*(honestly|frankly|basically|essentially|actually|candidly|truthfully|plainly|clearly|simply|obviously)\s*,", re.I)),
    # TRAILING ASIDE (operator 2026-08-21, on the heading "the wake path, before
    # you speak"): a qualification tacked on after a comma belongs inside the
    # sentence or in its own sentence. Two precise shapes are checkable.
    ("contrast tail at sentence end", re.compile(r",\s+(not|never|worse|better|only|just|less|more)\b[^.!?\n]{0,30}[.!?]", re.I)),
]


HEADING = re.compile(r"^#{1,6} +(.*)$")


def heading_tail(text: str) -> list[tuple[int, str]]:
    """Headings that append a condition after a comma. A comma INSIDE parentheses
    is a list ("once per agent, per machine"), not a trailing aside, so those
    spans are removed before the check."""
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        m = HEADING.match(line)
        if not m:
            continue
        bare = re.sub(r"\([^)]*\)", "", m.group(1))
        if "," in bare:
            out.append((i, line.strip()))
    return out


def lint(path: str) -> int:
    raw = open(path, encoding="utf-8").read()
    prose = re.sub(r"```.*?```", lambda m: "\n" * m.group(0).count("\n"), raw, flags=re.S)
    hits = 0
    for label, rx in CHECKS:
        for m in rx.finditer(prose):
            line = prose[: m.start()].count("\n") + 1
            print(f"{path}:{line}: [{label}] {m.group(0)!r}")
            hits += 1
    for line_no, text in heading_tail(prose):
        print(f"{path}:{line_no}: [heading with a comma-appended tail] {text!r}")
        hits += 1
    return hits


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return 1
    total = sum(lint(p) for p in sys.argv[1:])
    print(f"lint_language: {total} hit(s)")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
