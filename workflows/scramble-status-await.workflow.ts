export const meta = {
  name: 'scramble-status-await',
  description: "Finish the status work a short-lived verb starts, and make message check drain",
  phases: [{ title: 'cli' }],
}

phase('cli')
const out = await agent(`You are fixing two defects in "scramble", the repo you are running
in, both found by \`bun scripts/live-smoke.ts\`, which runs the real CLI against a real Slack
workspace. Read scripts/live-smoke.ts, src/cli.ts and src/status.ts first. Work in
src/cli.ts, src/status.ts and their tests: another unit is editing src/slack-backend.ts
right now, so leave that file alone.

DEFECT 1: THE STATUS NEVER CLEARS ON A REPLY.

The smoke reports:

    PASS  status/set: a status is active for team after delivery
    FAIL  status/clearedOnReply: the reply cleared the status: 1 entry(ies) left
    PASS  status/livingGone: the living status message was removed from Slack: true

Read those three together: the reply DID delete the living message in Slack and did NOT
drop the record from \`.scramble/status.json\`. The work was cut in half.

The cause is that every status call in src/cli.ts is launched and abandoned:

    void status?.clearExpired();
    void status.setOn(m.channel, agent);
    void status.clearOn(channel, agent);

\`clearOn\` awaits Slack's chat.delete and only then saves the ledger, so when a short-lived
verb like \`message send\` posts and returns, the process exits with that promise in flight:
the delete had gone out, the save had not. It appeared to work in \`listen\` because that
process keeps running. A floating promise in a process that is about to exit is a coin
flip, and the ledger it fails to write is what the NEXT invocation reads.

DELIVER: every status call is awaited, so a verb finishes the status work it started before
its process exits. Keep the property that makes this safe: a failing status must never fail
the work it brackets, so each awaited call catches its own error, reports it on stderr, and
the verb exits as it would have. Check every site, including the top-level
\`clearExpired\` that runs before each verb, and the delivery hook. \`listen\` keeps its
expiry ticker.

DEFECT 2: \`message check\` REPORTS NOTHING WITHOUT CHECKING.

The smoke reports:

    FAIL  check/drains: message check returned the waiting mention: (nothing)

with a mention of the reading agent sitting in the channel, posted two seconds earlier.
\`messageCheckSlack\` in src/cli.ts builds the backend, ignores its flags, and returns 0. Its
comment argues that Slack holds no per-agent inbox, which is true and does not license
exit 0 with no output: that is indistinguishable from "nothing is waiting for you", so an
agent sweeping with \`message check\` stays silent forever while it is being addressed.

DELIVER: \`message check\` under the Slack backend drains the same way the local one does.
The cursor is already client-side in \`.scramble/cursor.json\` keyed by agent (see
\`messageCheckLocal\`, \`readCursor\`, \`writeCursor\`), and the Slack backend already reads a
conversation from a cursor. So: read each configured channel from the agent's stored
cursor, print one JSON line per message the same shape \`listen\` prints, set the status for
delivered lines exactly as the local path does, advance the cursor to the newest line seen
per channel, exit 0. A Slack cursor is a conversation \`ts\` rather than a global integer, so
store it per channel; do not force it into an integer.

TESTS, behavioral, with injected seams so no token is needed:
- a short-lived verb that clears a status writes the ledger before it returns, proven by
  reading \`.scramble/status.json\` after the call rather than by inspecting a promise;
- a Slack status call answering {"ok":false} is reported on stderr and the verb still
  exits with the code the underlying work earned;
- \`message check\` with a waiting message prints it and advances the cursor;
- a second \`message check\` right after prints nothing, because the cursor moved;
- \`message check\` sets the status for a message addressed to the reading agent, and sets
  nothing for one that is not;
- the existing \`attachment\`, \`thread\` and \`listen\` behavior is unchanged.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. The FULL gate must be
green: run \`bash scripts/gate.sh\` and paste its summary lines plus the coverage table. GATE
GREEN at 100% coverage is the definition of done. When you are done, say which smoke stages
you expect to flip, without running the smoke: it needs a real workspace token that is not
in your sandbox.`)
return { out }
