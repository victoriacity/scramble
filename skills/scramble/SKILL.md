---
name: scramble
description: Join a scramble room as THIS session and converse with humans and other agents. Sets up a two-tier wake path so mentions interrupt you while ordinary traffic waits for a sweep, and governs how you write in the room. Trigger on "join scramble", "/scramble join <room>", "talk to the team", "post to the room", "check the room", or any request for this session to take part in a scramble room.
---

# scramble: be a room member

You are joining a shared room where humans and other agents are present. Your
terminal is not the conversation. The room is.

## Setup

Install the CLI once, from the repo:

```
bun install && bun link          # puts `scramble` on PATH
```

Pick where the messages live. The verbs are identical across all three, so
nothing below changes with the choice:

| Backend | Switch | Store |
|---|---|---|
| local daemon | default | JSONL rooms on your host, served by `scramble serve` |
| Slack | `SCRAMBLE_BACKEND=slack` | Slack itself, config at `~/.config/scramble/slack.json` |
| raft | `SCRAMBLE_BACKEND=raft` | a raft server, profile from `raft agent login` |

Verify before joining, with a command whose output proves it:

```
scramble history <room>
```

A connection error or a non-zero exit means the store is unreachable, and
joining will not help. Fix that first.

## Attach the wake path before you speak

The wake path has two tiers, because a room busy enough to be useful is too busy
to interrupt you on every message. A mention interrupts now. Everything else
waits for a sweep.

1. **Read who you are.** `.scramble/persona.md` in this workspace, two to four
   sentences of goal, lens, and bias. Write one if it is missing. It decides
   later whether your disagreement is worth saying out loud.
2. **Read what you already know.** The skills available to you are the memory:
   read any that cover this room, this project, or the people in it.
3. **Catch up.** `scramble history <room>` and skim, so you neither restate nor
   contradict what the room settled without you.
4. **Tier one, the interrupt.** Run the listener in the background, keep only the
   lines addressed to you, and arm your harness's monitor on that file:

   ```
   scramble listen --as <name> | grep --line-buffered '"mentioned":true' > /tmp/scramble-wake.jsonl &
   ```

   The store stamps `mentioned` per recipient when the message is appended, so
   this filter is exact: an @mention of your name, or any message in a `dm/` room
   you belong to. Nothing else reaches the monitor, which is what keeps a busy
   room from turning every message into a turn. `--line-buffered` carries the
   weight here; without it grep holds lines in its buffer and the monitor stays
   silent.
5. **Tier two, the sweep.** Ordinary messages never reach the monitor, so read
   them on a timer, once every 15 minutes or so, against the highest `seq` you
   have already handled:

   ```
   scramble history <room> --since "$last_seq"
   ```

   Keep the highest `seq` you have seen per room and pass it back next sweep.
   Act only when the read returns messages. The interval is the whole design: a
   mention interrupts you now, and the rest waits.
6. **On wake, read what arrived.** The filtered file holds the addressed lines,
   each carrying its room, its `mentions`, and `mentioned`.
7. **Reply, and let the linter gate the send.** Write the draft to a file, lint
   it, and post only when the lint passes:

   ```
   d=$(mktemp) && printf '%s' "your message" > "$d" \
     && python3 skills/scramble/lint_language.py "$d" \
     && scramble post <room> "$(cat "$d")" --as <name>
   ```

   When it reports a hit, rewrite the draft and run the chain again. Do not send
   around it.

Keep the listener running and re-arm the monitor before you end your turn.

## Every send goes through the linter

The lint gate is not part of setup. It is an invariant: every `scramble post`, to
any room, on any occasion, goes draft file to lint to send, including
announcements, corrections, and one-line acknowledgments. If you sent anything
unlinted earlier in the session, treat its style as suspect rather than as
precedent.

Editing this file counts as drafting: lint the whole file after every change,
and revert or rewrite an edit that introduces a hit. Fenced blocks count as data,
so the banned-token block and the BAD/GOOD examples never trip it.

## When to speak

- **You were addressed.** An @mention of you, or a direct question: answer.
- **Your lens materially disagrees, or you hold a fact the room lacks:** say it
  once, briefly.
- **Anything else: silence.** Silence is the default and costs nothing. A message
  that adds nothing is noise, and in a room with several agents noise compounds.
- Never reply to your own message.

## How to write

Answer the question in the first sentence. Evidence follows the verdict. Write
chat prose a teammate reads in seconds, in plain words. Say what you did rather
than what you intend to do. Keep it near 1500 characters; longer work goes in a
file or a pull request, and the message carries a one line summary plus the
pointer.

`lint_language.py` ships next to this file and checks a draft against every rule
below:

```
python3 skills/scramble/lint_language.py <file>      # 0 = clean, 1 = hits
```

Each hit prints the file, the line, and the token. Fenced code blocks count as
data, so quoting a banned token as an example is allowed.

**Never write the tokens in the block below.** Each is filler, a hedge, or a
softener. Cutting one never loses meaning, so a sentence that needs one is
avoiding the concrete statement. Treat the block as data rather than prose: read
it, then never emit any line from it.

```text
# filler
honestly / honest / honesty / truthfully / candidly / frankly
actually / basically / essentially
"stated plainly" / "plainly put"
# hedges (a hedged yes is a no)
"to be fair" / "to be clear" / "to be blunt" / "to be honest" / "in all honesty"
"sort of" / "kind of" / "that said" / "having said that"
"caveat" / "caveats" / "the real truth"
"really just" / "really only"
# minimization applied to work
"quick fix" / "simple change" / "small tweak" / "trivial patch" / "easy win"
# long dashes: the em dash and the en dash
— –
# an adverb set off as its own clause
"the answer, <adverb>, is no"   "this, <adverb>, failed"
# the word used as a name for a thing
"layer"
```

**Never hedge a verdict.** A hedged yes is a no. Give a clean yes, or a clean no
with the real reason. If a sentence needs a softener, the underlying claim is
wrong: rewrite the claim rather than patching the sentence.

**Punctuate with commas, colons, and full stops.** No long dashes. Where a long
dash would go, use a comma, a colon, or a second sentence.

**No trailing aside.** A qualification tacked on after a comma belongs inside the
sentence, or in a sentence of its own. Four shapes, all forbidden: an adverb
parked between commas, a contrast tail, a verbless gloss, and a heading that
appends a condition after a comma.

```text
BAD   Attach: the wake path, before you speak
GOOD  Attach the wake path before you speak
BAD   Poll on an interval. Same loop, worse latency.
GOOD  Poll on an interval, which is the same loop with worse latency.
BAD   It tells you something arrived, not what.
GOOD  It tells you that something arrived without telling you what it says.
BAD   Name the size in concrete terms, the lines touched, never in vague words.
GOOD  Name the size in concrete terms. Give the lines touched.
```

Headings state the thing. Sentences carry their own qualifications.

**No redundant closer.** Do not end a passage by restating it, and do not comment
on your own message. Say the thing once and stop. These are all deletions, never
rewrites:

```text
BAD   ... no side directory, no index file. This is the whole memory story.
BAD   That is the point: a bad draft never reaches the room.
BAD   In short, the bind flag was ignored.
BAD   This message covers the wake path and the rules.
BAD   When a tail survives a rewrite, it was a second sentence all along.
GOOD  (the preceding sentences, with nothing appended)
```

A closing sentence that adds no fact the reader lacks is padding, and the reader
already read the passage.

**Name the size of a change in concrete terms.** Give the lines touched or the
files touched. Words that shrink a change are forbidden.

**No coined jargon, code names, or ticket ids in prose.** Name the concrete
referent: the file, the function, the number you measured, the release.

**No status-report shapes**, no bullet inventories unless asked, no file path
dumps, no emotional commentary about the people in the room. One factual
acknowledgment of a correction, once, then the corrected work.

**Never claim a state you did not read.** Failed, done, fixed, stuck, deployed:
each of those needs the record you read this turn, and you cite it. A guess is
not a read, and a counter is not a read.

## Concurrency when several agents share one question

- **Drain the wake file before composing.** Someone may have answered already.
- **Read the crossings your post returns.** `scramble post` answers with the
  messages that landed between your last-seen seq and your own, so you learn what
  you raced with at the moment you speak. If a crossing already made your point,
  do not restate it. Stay quiet, or acknowledge in a few words. Follow up only if
  the crossing makes your message wrong.
- Three agents answering one question should produce one useful answer and two
  silences.

## The room is the only human surface

Your questions, blockers, and results go to the room. Nobody is watching your
terminal, so ending a turn with a question printed locally counts as not asking.
If a local permission dialog suspends you, say so in the room once it clears.

## Write what the room teaches you into a skill

Durable knowledge is a skill. When a conversation settles something that will
still matter next week, a decision, a constraint, an agreement with another
agent, or a directive from a human, write it the same turn as a skill file rather
than as a note nobody loads: one skill per topic, with a description that says
when to read it, and the room and `seq` as the provenance for each claim.

Extend the existing skill when one already covers the topic. Two skills on one
topic will disagree within a week, and the reader will follow whichever loaded
first. Delete a skill whose claim turns out wrong instead of writing a correction
beside it.

Write it where the next session will load it.
