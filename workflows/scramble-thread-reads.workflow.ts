export const meta = {
  name: 'scramble-thread-reads',
  description: "A read must return thread replies, which conversations.history omits",
  phases: [{ title: 'history' }],
}

phase('history')
const out = await agent(`You are fixing a defect in "scramble", the repo you are running in,
found by \`bun scripts/live-smoke.ts\` against a real Slack workspace. Read
scripts/live-smoke.ts and src/slack-backend.ts first. Work in src/slack-backend.ts and its
tests: another unit is editing src/cli.ts and src/status.ts right now, so leave those alone.

THE DEFECT. The smoke posts a root message, replies to it with \`--thread\`, and then reads
the channel back:

    PASS  thread/reply: exit 0
    PASS  thread/inSlack: 2 message(s) under the root in Slack
    FAIL  thread/onLine: read line carries thread=(absent)

So the reply reached Slack and sits under the root, and \`message read\` does not return it
at all. The line is not merely missing its \`thread\` field: the whole reply is absent from
the read.

THE CAUSE. \`conversations.history\` returns only top-level messages. A threaded reply lives
under \`conversations.replies\` and appears in history only when someone broadcasts it back
to the channel. \`history\` in src/slack-backend.ts reads conversations.history alone, so
every threaded reply is invisible to \`message read\` and to \`message history\`. Verified
live: conversations.replies on the root returned both messages while conversations.history
returned only the root.

This is the read half of a feature whose write half works: \`--thread\` posts into the right
thread, and nothing can read the answer back. An agent asked a question in a thread cannot
see the reply.

DELIVER:

1. \`history\` returns thread replies alongside top-level messages. A history row that has
   replies is marked by Slack with \`reply_count\` above zero (and its \`thread_ts\` equals its
   own \`ts\`); for such a row, read \`conversations.replies\` for that root and include the
   replies. The root itself must not be duplicated: conversations.replies returns the root
   as its first entry, so drop the entry whose \`ts\` equals the root's.
2. Each reply carries \`thread\` naming the root, by the rule already in the ingest path: a
   message whose \`thread_ts\` differs from its own \`ts\` is a reply. A root that merely HAS
   replies is not a reply and carries no \`thread\`.
3. ORDER stays the order the rest of the read uses, so a caller can keep its cursor. State
   in a comment which order that is and why the merged replies land where they do.
4. BOUND THE FAN-OUT and say so out loud. One extra request per threaded root is the cost;
   an unbounded fan-out on a busy channel is not acceptable. Cap the number of roots
   expanded per read, take the most recent ones, and when the cap drops a root, REPORT it
   through the same problems channel the backend already uses for a partial read, naming
   how many roots went unexpanded. A silently truncated read is the defect this repo keeps
   finding, so a dropped root must never look like an empty thread.
5. A replies request that fails does not fail the whole read: keep the top-level messages,
   report the problem, carry on.

TESTS, behavioral, with an injected fetch:
- a history row with reply_count > 0 produces its replies in the read, each carrying
  \`thread\` equal to the root ts, and the root appears exactly once with no \`thread\`;
- a history row with no replies triggers no conversations.replies request at all, proven by
  counting requests;
- more threaded roots than the cap: the newest are expanded, and the problems list names
  the number dropped;
- a conversations.replies answering ok:false leaves the top-level messages intact and
  reports the problem;
- the existing attachment (\`files\`) and mention behavior on a read is unchanged.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Keep the public signature
of \`history\` and the shape of a line. The FULL gate must be green: run
\`bash scripts/gate.sh\` and paste its summary lines plus the coverage table. GATE GREEN at
100% coverage is the definition of done.`)
return { out }
