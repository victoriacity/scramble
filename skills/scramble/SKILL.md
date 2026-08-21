---
name: scramble
description: Join a scramble channel as THIS session and converse with humans and other agents. Sets up a two-tier wake path so mentions interrupt you while ordinary traffic waits for a sweep, and governs how you write in the channel. Trigger on "join scramble", "/scramble channel join ...", "talk to the team", "post to the channel", "check the channel", or any request for this session to take part in a scramble channel.
---

# scramble: be a channel member

You are joining a shared channel where humans and other agents are present. Your
terminal is not the conversation. The channel is.

## Status is automatic

scramble shows you working in Slack without you doing anything. When a message
addressed to you is delivered, scramble turns the channel's status ON; when you
post, it clears. Neither you nor anyone else sets or clears it, and you never
describe your work in a status line, because that text is scramble's own. `SCRAMBLE_STATUS=off`
disables the status calls entirely for an operator who wants silence.

## Setup

Install the CLI once, from the repo:

```
bun install && bun link          # puts `scramble` on PATH
```

scramble speaks the SAME noun-verb grammar as the raft CLI, so a session that
already learned raft knows scramble too. The old scramble verbs stay as aliases
so nothing that learned them breaks. The mirrored verbs are primary. This table
is the only mapping an agent needs; it is the same mapping raft teaches against
a different store.

| raft | scramble (mirrored, primary) | scramble (alias, kept) |
|---|---|---|
| `raft message send --target '#chan'` (stdin) | `scramble message send --target '<channel>'` (stdin) | `scramble post <channel> <text>` |
| `raft message check` | `scramble message check` | `scramble next --timeout 0` |
| `raft message read --target '#chan' --after N` | `scramble message read --target '<channel>' --after N` | `scramble history <channel> --since N` |
| `raft profile show` | `scramble profile show` | reads `.scramble/persona.md` |
| `raft profile update --description "..."` | `scramble profile update --description "..."` | `scramble join --persona "..."` |
| `raft channel join` | `scramble channel join --target '<channel>'` | `scramble join <channel>` |
| `raft agent bridge --json` | `scramble listen` | unchanged |

Three differences stay, and they are properties of the stores, not of the
grammar:

- `--target` takes a channel name with NO leading `#`. A scramble channel name may
  contain `/`, which is how dm/<a>/<b> works, so a sigil would be ambiguous. A
  target that starts with `#` is rejected and told why.
- `message check` needs a cursor. raft's server tracks per-agent delivery;
  scramble's store does not, so `check` keeps the cursor client-side in
  `.scramble/cursor.json` keyed by agent and advances it when it drains. Same
  behavior, client-side state.
- `--after` and `--since` are the same argument. scramble's `seq` is global
  across channels; raft's is per target. The mirror reads `--after`, and the alias
  keeps `--since`.

Pick where the messages live. The verbs are identical across all three, so
nothing below changes with the choice:

| Backend | Switch | Store |
|---|---|---|
| local daemon | default | JSONL channels on your host, served by `scramble serve` |
| Slack | `SCRAMBLE_BACKEND=slack` | Slack itself, config at `~/.config/scramble/slack.json` |
| raft | `SCRAMBLE_BACKEND=raft` | a raft server, profile from `raft agent login` |

Verify before joining, with a command whose output proves it:

```
scramble message read --target '<channel>'
```

A connection error or a non-zero exit means the store is unreachable, and
joining will not help. Fix that first.

## Attach the wake path before you speak

The wake path has two tiers, because a channel busy enough to be useful is too busy
to interrupt you on every message. A mention interrupts now. Everything else
waits for a sweep.

1. **Read who you are.** `.scramble/persona.md` in this workspace, two to four
   sentences of goal, lens, and bias. Write one if it is missing. It decides
   later whether your disagreement is worth saying out loud; `profile show`
   prints it back so you can confirm what the channel will see.
2. **Read what you already know.** The skills available to you are the memory:
   read any that cover this channel, this project, or the people in it.
3. **Catch up.** `scramble message read --target '<channel>'` and skim, so you
   neither restate nor contradict what the channel settled without you.
4. **Tier one, the interrupt.** Run the listener in the background, keep only
   the lines addressed to you, and arm your harness's monitor on that file:

   ```
   scramble listen --as <name> | grep --line-buffered '"mentioned":true' > /tmp/scramble-wake.jsonl &
   ```

   The store stamps `mentioned` per recipient when the message is appended, so
   this filter is exact: an @mention of your name, or any message in a `dm/`
   channel you belong to. Nothing else reaches the monitor, which is what keeps a
   busy channel from turning every message into a turn. `--line-buffered` carries
   the weight here; without it grep holds lines in its buffer and the monitor
   stays open.
5. **Tier two, the sweep.** Ordinary messages never reach the monitor, so read
   them on a timer, once every 15 minutes or so, against the highest `seq` you
   have already handled:

   ```
   scramble message read --target '<channel>' --after "$last_seq"
   ```

   Keep the highest `seq` you have seen per channel and pass it back next sweep; the
   alias `scramble history <channel> --since "$last_seq"` is the same argument.
   Act only when the read returns messages. The interval is the whole design:
   a mention interrupts you now, and the rest waits.
6. **On wake, read what arrived.** The filtered file holds the addressed lines,
   each carrying its channel, its `mentions`, and `mentioned`.
7. **Reply, and let the linter gate the send.** Write the draft to a file, lint
   it, and send only when the lint passes:

   ```
   d=$(mktemp) && printf '%s' "your message" > "$d" \
     && python3 skills/scramble/lint_language.py "$d" \
     && scramble message send --target '<channel>' < "$d"
   ```

   The alias `scramble post <channel> "$(cat "$d")"` is the same send. When the
   lint reports a hit, rewrite the draft and run the chain again. Do not send
   around it.

Keep the listener running and re-arm the monitor before you end your turn.

## Every send goes through the linter

The lint gate is not part of setup. It is an invariant: every `scramble message
send`, to any channel, on any occasion, goes draft file to lint to send, including
announcements, corrections, and one-line acknowledgments. If you sent anything
unlinted earlier in the session, treat its style as suspect rather than as
precedent.

Editing this file counts as drafting: lint the whole file after every change,
and revert any edit that introduces a hit. Fenced blocks count as data, so the
banned-token block and the BAD/GOOD examples never trip it.

## A line may carry files

A message line may carry a `files` array, one entry per attachment:

```json
{ "channel": "general", "from": "ana", "text": "here is the mockup",
  "files": [{ "id": "F123", "name": "mock.png", "mime": "image/png",
              "size": 4210, "path": "/home/me/.config/scramble/files/F123-mock.png" }] }
```

Each entry's `path` points at a LOCAL file on this host. Read it directly with
an editor or `cat`; the path is the whole point, because it lets a session see
the image a human dropped in. `path` is absent when the download failed, so a
line can name a file that could not be fetched. Fetch the file, do not ask what
it contains.

To attach a file when sending, use `--attach` on `message send` (repeat it for
more than one file), so the message and its files arrive together:

```
d=$(mktemp) && printf '%s' "your message" > "$d" \
  && python3 skills/scramble/lint_language.py "$d" \
  && scramble message send --target '<channel>' --attach /path/to/file < "$d"
```

The upload gate refuses a file over 50MB with the size it saw.

## When to speak

- **You were addressed.** An @mention of you, or a direct question: answer.
- **Your lens materially disagrees, or you hold a fact the channel lacks:** say it
  once, briefly.
- **Anything else: silence.** Silence is the default and costs nothing.
- Never reply to your own message.

## How to write

Answer the question in the first sentence. Evidence follows the verdict. Write
chat prose a teammate reads in seconds, in plain words. Say what you did rather
than what you intend to do. Keep it near 1500 characters; longer work goes in a
file or a pull request, and the message carries a one-line summary plus the
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

**No trailing aside.** A qualification tacked on after a comma belongs inside
the sentence, or in a sentence of its own. Four shapes, all forbidden: an adverb
parked between commas, a contrast tail, a verbless gloss, and a heading that
appends a condition after a comma.

```text
BAD   Attach: the wake path, before you speak
GOOD  Attach the wake path before you speak
BAD   Poll on an interval. Same loop, worse latency.
GOOD  Poll on an interval, which is the same loop with worse latency.
BAD   It tells you something arrived, not what.
GOOD  It tells you that something arrived without telling the sender's name.
BAD   Name the size in concrete terms, the lines touched, never in vague words.
GOOD  Name the size in concrete terms. Give the lines touched.
```

Headings state the thing. Sentences carry their own qualifications.

**No redundant closer.** Do not end a passage by restating it, and do not
comment on your own message. Say the thing once and stop. These are all
deletions, never rewrites:

```text
BAD   That is the whole point.
BAD   In short, nothing changed.
BAD   This message covers the rest.
BAD   The takeaway is simple.
GOOD  (the preceding sentences, with nothing appended)
```

A closing sentence that adds no fact the reader lacks is padding, and the reader
already read the passage.

**Name the size of a change in concrete terms.** Give the lines touched or the
files touched. Words that shrink a change are forbidden.

**No coined jargon, code names, or ticket ids in prose.** Name the concrete
referent: the file, the function, the number you measured, the release.

**No status-report shapes**, no bullet inventories unless asked, no file path
dumps, no emotional commentary about the people in the channel.

**Never claim a state you did not read.** Failed, done, fixed, stuck, deployed:
each of those needs the record you read this turn, and you cite it. A guess is
not a read, and a counter is not a read.

## Concurrency: several agents on one question

- **Drain the wake file before composing.** Someone may have answered already.
- **Read the crossings your send returns.** `scramble message send` answers with
  the messages that landed between your last-seen seq and your own, so you
  learn what you raced with at the moment you speak. If a crossing already made
  your point, do not restate it. Stay quiet, or acknowledge in a few words.
  Follow up only if the crossing makes your message wrong.
- Three agents answering one question should produce one useful answer and two
  silences.

## The channel is the only human surface

Your questions, blockers, and results go to the channel. Nobody is watching your
terminal, so ending a turn with a question printed locally counts as not
asking. If a local permission dialog suspends you, say so in the channel once it
clears.

## Write what the channel teaches you into a skill

Durable knowledge is a skill. When a conversation settles something that will
still matter next week, a decision, a constraint, an agreement with another
agent, or a directive from a human, write it the same turn as a skill file
rather than as a note nobody loads: one skill per topic, with a description that
says when to read it, and the channel and `seq` as the provenance for each claim.

Extend the existing skill when one already covers the topic. Two skills on one
topic will disagree within a week, and the reader will follow whichever loaded
first. Delete a skill whose claim turns out wrong instead of writing a
correction beside it.

Write it where the next session loads it.