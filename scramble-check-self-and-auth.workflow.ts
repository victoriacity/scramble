export const meta = {
  name: 'scramble-check-self-and-auth',
  description: "message check delivers your own lines, and next reports bad credentials as silence",
  phases: [{ title: 'cli' }],
}

phase('cli')
const out = await agent(`You are fixing two defects in "scramble", the repo you are running
in, both found by running the real CLI against a real Slack workspace with a MINIMAL config
(a bot token, one channel, one agent, and no app-level token). Read src/cli.ts,
src/slack-backend.ts and scripts/live-smoke.ts first. Work in src/cli.ts and its tests.

DEFECT 1: \`message check\` HANDS YOU YOUR OWN MESSAGES.

    $ printf 'self-delivery probe from akari' | scramble message send --target team --as akari
    $ scramble message check --as akari
    {"from":"akari","mentioned":false,"text":"self-delivery probe from akari", ...}

\`message check\` is a DELIVERY verb: it drains what has arrived FOR the reading agent, and
the agent's own post has not arrived for anybody. \`listen\` and \`next\` already exclude the
reading agent, and \`message read\` deliberately returns every line because a transcript
must be complete, so this is the one path that took history's completeness into a delivery.
An agent sweeping with \`message check\` reads its own last message as new traffic, and the
"never reply to your own message" rule in skills/scramble/SKILL.md is the only thing
standing between that and a self-reply loop. Make it structural: the drain in
\`messageCheckSlack\` leaves out lines whose resolved sender is the draining agent, by the
same name comparison \`listen\` and \`next\` use. The cursor must still advance past a skipped
own-line, or every sweep re-reads it forever.

DEFECT 2: A BROKEN CREDENTIAL IS REPORTED AS SILENCE.

With no app-level token in the config (Socket Mode needs one; the one-shot verbs do not):

    $ scramble next team --as akari --timeout 12
    slack: invalid_auth
    (exit 64)

Exit 64 is scramble's documented "nothing to report, park again" code, and the whole point
of \`next\` is that a harness with no background process parks a turn on it and retries on
64. So a wrong or missing credential presents as a quiet channel, forever, and the stderr
line scrolls past unread in an unattended loop. A failure that cannot be told from silence
is the failure mode this repo keeps finding.

DELIVER: \`next\` distinguishes them. Timing out with a live connection stays 64. Failing to
establish the connection at all, which is what \`invalid_auth\` on apps.connections.open is,
exits NONZERO and NOT 64, with a message naming the Slack error and the config key that
supplies the credential (\`appToken\`, the app-level \`xapp-\` token). Do the same for
\`listen\`, which today would spin its reconnect loop against the same refusal: a connection
that has never once succeeded must fail out rather than retry silently, while a connection
that dropped after working keeps its existing backoff.

Pick the exit code by this rule and state it in a comment: 64 means the channel was quiet,
1 means scramble could not look.

TESTS, behavioral, with injected seams so no token is needed:
- \`message check\` drains a peer's line and does NOT drain a line from the draining agent;
- the cursor advances past a skipped own-line, proven by a second check returning nothing
  and a third call after a new peer line returning only that line;
- \`next\` whose socket open answers {"ok":false,"error":"invalid_auth"} exits nonzero, not
  64, and the message names both \`invalid_auth\` and \`appToken\`;
- \`next\` whose socket opens and then times out still exits 64;
- \`listen\` whose FIRST socket open is refused exits nonzero instead of retrying, and one
  that opens and later drops still reconnects.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Do not change what
\`message read\` returns: a transcript stays complete, including your own lines. The FULL
gate must be green: run \`bash scripts/gate.sh\` and paste its summary lines plus the
coverage table. GATE GREEN at 100% coverage is the definition of done.`)
return { out }
