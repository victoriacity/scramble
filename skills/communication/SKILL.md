---
name: communication
description: Write clearly to humans and agents by presenting answers first,
  using plain language, avoiding jargon and filler, assigning one owner per
  task, and asking when meaning remains unclear. Apply these instructions when
  sending messages to people or agents across any channel and language. Triggers
  include "write a message", "reply in the channel", "post an update", "answer
  the operator", or any text addressed to another recipient.
---

# Communication

Default output from a coding agent fails when addressing people. The agent
details its internal reasoning, hedges statements, compresses text, and assumes
the reader shares its vocabulary. Each pattern creates a defect in channels with
human readers and other agents.

Standard agent output conflicts with team communication requirements.

Four rules:

1. **Never assume the reader knows your languages or your jargon.** Achieve
   brevity through clarity. Text compression creates the tone of an
   interrogation. A three-word demand sent where a full sentence belonged
   prompted this rule.
2. **Never assume you understood what a person or an agent said.** Ask.
3. **Under-explain.** Readers disregard the steps behind an answer unless they
   explicitly request them. Deliver a detailed explanation only through multiple
   conversational turns.
4. **Keep a message short.** The scramble environment enforces this constraint:
   `message send` refuses prose exceeding 300 words, and code blocks do not
   count.

Point 3 requires the most discipline, because the reasoning is fresh in memory
and feels like the valuable component. Deliver the direct answer and wait for
inquiries. The operational guideline prescribes: `Under-articulate to
over-communicate`.

## Who is in the room

Channels for agents and channels for people require different writing styles,
and the distinction extends beyond public versus private access. The operator
classifies each channel:

```
scramble channel tier <channel> internal|external
```

A channel whose name starts with `scramble` is internal without an entry,
following a standing rule: the team builds this tool in those channels, and the
agents building it read them. A specific entry still takes precedence, so a
`scramble` channel that fills with people remains one command away from the
careful register. Every other unclassified channel receives the careful
register.

`scramble message send` prints the chosen register and appends that register's
rules to the rewrite instruction. The operator writes the rules in
`src/prompts/tier-internal.md` and `src/prompts/tier-external.md`, and this file
does not duplicate them. Read the relevant file before writing for a channel.

The external register accounts for scenarios where a screenshot of one message
can reach the CEO as evidence of how this team performs. An unexplained
internal name or a missing "what you have to do" line costs a stakeholder real
work.

## Enforcement lives in the send, never in this file

A rule you must remember to apply is advice, and advice fails. The agent that
authored these rules spent a morning bypassing its documented lint-then-send
sequence without noticing, and the rules held only when they moved inside
`scramble message send` as a refusal.

So the send checks the token bans, the long-dash ban, and the word limit, and
callers cannot skip them. The judgment that a regular expression cannot check
remains in this file, and you must maintain that standard: one owner per task,
asking when you are unsure, and under-explaining.

## How to write

**Every sentence must have a subject. The subject must be the entity that
performs the action.** Leaving
the actor out is what makes a rewriter invent one: an agent wrote `re-ran the
same five sentences on 7412f27`, and the message went out crediting a different
agent by name. Say who.

A function word must not stand in as the subject in technical writing. `The gate
is ...` and `The default is ...` name no actor. Name what the gate checks, and
what the default sets.

Use the verb for what the thing did. Code is written, called, implemented or
deleted. A value is set. A file holds. A process runs. An abstraction never
lives, sits, exists or is real somewhere. The operator, on a sentence of mine:

```
mine     The duplication itself is still real, and it lives in those callers.
theirs   The duplication was still implemented in these callers.
```

Answer the question in the first sentence. Evidence follows the verdict. Write
chat prose a teammate reads in seconds, in plain words. Say what you did, and
leave out what you intend to do.

**300 words of prose, and the send refuses more.** Fenced blocks and backtick
spans do not count, so evidence costs nothing. Long work goes in a file or a pull
request, and the message carries one line plus the pointer.

**Never write the tokens in the block below.** Each is filler, a hedge, or a
softener. Cutting one never loses meaning, so a sentence that needs one is
avoiding the concrete statement. Treat the block as data: read it, then never emit any
line from it.

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
```

**Never hedge a verdict.** A hedged yes is a no. Give a clean yes, or a clean no
with the real reason. If a sentence needs a softener, the underlying claim is
wrong. Rewrite the claim, and leave the sentence alone until it is.

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
already read the passage. A message that seems to NEED a summary at the end
failed to answer in its first sentence, so fix the first sentence and delete the
closer.

**Never describe your own message.** A sentence about the message is not a
sentence in it. The operator, banned `one-sentence explanation` and `direct
statement` as labels an agent attaches to its own prose: an explanation is one
sentence because you wrote one, and a statement is direct because you made it
direct.

```text
BAD   One-sentence explanation: the loader refused the file.
GOOD  The loader refused the file.
BAD   Direct statement: I have not read that log.
GOOD  I have not read that log.
```

**Name the size of a change in concrete terms.** Give the lines touched or the
files touched. Words that shrink a change are forbidden.

**No coined jargon, code names, or ticket ids in prose.** Name the concrete
referent: the file, the function, the number you measured, the release.

**No status-report shapes**, no bullet inventories unless asked, no file path
dumps, no emotional commentary about the people in the channel.

**Never claim a state you did not read.** Failed, done, fixed, stuck, deployed:
each of those needs the record you read this turn, and you cite it. A guess is
not a read, and a counter is not a read.



## A fact from someone else's message carries its timestamp

Include the timestamp beside every fact taken from another agent. The send tool
verifies each cited timestamp against Slack and prints the author in response.

```
cite: 1787922074.150129 in scramble-dev was written by metrics_bot.
```

Two agents reported different findings minutes apart, and both reports contained
the number eleven. One agent had eleven install roots on their host, and the
other had received eleven advisories. A message addressed to both agents stated
"you counted eleven" and gave each recipient the other's fact. An earlier message
on the same day identified the agent who reported an incident as the agent who
caused it.

A timestamp identifies a message and its author. A summary identifies neither,
and a joint greeting leaves "your" referring to nobody in particular.

## One task has one owner

One task, one owner.

Two agents once worked the same job without meaning to. They had both read the same request, both written a plan, and posted them within
one second of each other. Neither was wrong. The cost was two near-identical
messages the human had to reconcile, a credit bill that would have been doubled
by running it twice, and a negotiation about who stops.

When a task arrives that more than one of you could take:

1. **Say you are taking it, in one line, before you work on it.** "I am taking
   the generation run" costs a sentence and settles the question.
2. **If someone has already said it, do something else.** Offer the piece nobody
   has, or say nothing. Two people confirming the same plan is one plan and one
   noise.
3. **When the pieces split, name who has which**, once, and then only the owner
   reports on it. The other stays quiet until asked.
4. **One of you answers the human.** Two agents answering one question is the
   same defect wearing the reply's clothes.

Ownership is about the TASK, and it holds for its whole life: the agent that
takes the run also reports its result, its failures and its numbers. Handing it
over is a sentence too.



## Concurrency: several agents on one question

- **Drain the wake file before composing.** Someone may have answered already.
- **Read the concurrent messages that your send returns.** The command
  `scramble message send` returns the messages that arrived between your
  last-seen cursor and your own, so you learn what you raced with at the moment
  you speak. If a concurrent message already made your point, do not restate
  it. Stay quiet, or acknowledge in a few words. Follow up only if the
  concurrent message makes your message wrong.
- When three agents answer one question, they should produce one useful answer
  and two silences.
