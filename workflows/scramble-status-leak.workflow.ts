export const meta = {
  name: 'scramble-status-leak',
  description: "The working status is a Slack message, so a read returns it as conversation",
  phases: [{ title: 'leak' }],
}

phase('leak')
const out = await agent(`You are fixing a defect in "scramble", the repo you are running in,
found by \`bun scripts/live-smoke.ts\` against a real Slack workspace. Read src/status.ts,
src/slack-backend.ts and scripts/live-smoke.ts first.

THE DEFECT. The automatic working status is drawn as a LIVING MESSAGE: outside an assistant
thread, src/status.ts posts a message whose text is "working" with chat.postMessage,
remembers its ts in \`.scramble/status.json\`, and deletes it when the status clears. That
message is a real message in the conversation, so while a status is active every read
returns it as if it were something someone said. From a live run:

    {"seq":10,"ts":"1787309110.093659","channel":"team","from":"akari","text":"working",
     "id":"1787309110.093659","mentions":[],"mentioned":false}

The status design in this repo already states the rule that line breaks: a status is never a
message, carries no seq, is absent from history, and is never delivered to a listener. A
line reading "working" in a transcript is noise a human scrolls past and an agent may
answer.

DELIVER:

1. A message that IS a living status is left out of \`history\` and out of delivery. The
   authority for "this ts is a status" is the ledger the status manager already writes
   (\`.scramble/status.json\` holds the channel, the agent and the living-message ts), so
   read it rather than matching on the text: matching "working" would also hide a human
   saying the word.
2. A status ts that has been cleared or expired is no longer in the ledger, so a message
   that outlives its record stays visible rather than being hidden forever. Say in a comment
   why that direction is the safe one: an undeletable status left in the channel must be
   visible so somebody removes it, while a hidden one is a line nobody can account for.
3. Keep the seams: the ledger path already comes from the status config, and the backend
   must not grow its own notion of where that file lives. If the backend cannot see the
   ledger without a new dependency, pass the known status timestamps in from the caller
   that already builds both, and say which caller that is.

TESTS, behavioral:
- a history read whose conversation contains a message at a ts recorded as a living status
  omits that line and returns every other line;
- with no active status the same read returns every line, including one whose text is
  "working";
- a delivery of a message at a living-status ts reaches no listener;
- a status ts absent from the ledger is NOT hidden.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Do not add a config knob.
Do not change how a status is drawn or cleared, only what a read and a delivery do with it.
The FULL gate must be green: run \`bash scripts/gate.sh\` and paste its summary lines plus
the coverage table. GATE GREEN at 100% coverage is the definition of done.`)
return { out }
