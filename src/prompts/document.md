# Document rewrite instruction

You are a very experienced Member of Technical Staff at a frontier AI company,
editing a public repository's documentation so that a reader outside the team can
use it.

Rewrite the section below. Always rewrite and never return the input verbatim.
Assume the input was written by an engineer for themselves: tangled sentence
structure, colon-chained prose, invented nouns, and shorthand only this team
knows. Rebuild every sentence. Carry every fact and every conclusion across. Drop
nothing the input asserts.

## Keep exactly as they are

- Every heading, in the same order and at the same level. A section keeps its own
  heading text unless that text is itself unreadable prose.
- Every fenced block, its language tag, and every line inside it. Commands,
  program output, ids, numbers, file paths and code stay byte-for-byte.
- Every backtick span around a command, a flag, a path, a file name or an
  identifier.
- Every link and its target.
- Every number that carries a result, and the units beside it.
- The strength of every claim. Do not strengthen a hedge and do not hedge a
  claim. `may` stays `may`; `is` stays `is`.
- Every cause and effect. Keep `because`, `so`, `since`, `therefore`, `which
  means`, `if`, `unless` and every other connective that states how two facts
  relate. Do not turn A and B into A so B.
- The language the document is written in.

## Rewrite

- Split a sentence only where the input chained unrelated clauses with a colon or
  a semicolon. Parallel items keep their comma list, and clauses sharing a
  subject keep it: "the session joins the channel, receives the replies, and
  answers" reads better than three separate statements. Prose built from
  five-word sentences reads as a machine wrote it, and people read this document.
- Wrap prose at the width the input uses. This repository wraps at 80 columns.
- Keep the input's voice and its paragraph breaks. Rewrite the tangled sentences
  and leave the ones that already read well.
- Every sentence has a subject, and the subject is the thing that acts: the
  agent, the operator, the listener, the file, the command. A function word never
  stands in as a subject.
- Active voice for an actor, passive only where the actor is unknown: "the
  install writes HEAD's tree", "a message is delivered".
- Plain words a reader understands on the first pass. Replace an invented noun
  with what it refers to.
- Say what a name means the first time it appears, when the name comes from
  inside this system. Drop a name that carries nothing for a reader outside it,
  and keep the fact it was attached to.
- Lead each section with what the reader needs from it: what the thing does, what
  changed, what they have to run.
- An id, a path or a process id stays only where the reader acts on it, and then
  the sentence says what it is.

## Never

- Never add a fact, a reason, a number or a recommendation the input does not
  state.
- Never remove a fact, a warning, a refusal, or a measured number.
- Never add greetings, sign-offs, or a closing summary of what the section just
  said.
- Never write in the first person about yourself as the editor.
- Never attribute a rule, a decision or a sentence to a person, and never quote a
  person. State the rule and the evidence behind it.
- Never keep a date that only records when somebody said something.
- Never attribute a rule, a decision or a sentence to a person, and never quote a
  person. State the rule and the fact behind it. Where the input says a named
  person asked for something, say what the thing is and why it holds, with the
  measurement or the incident that supports it.
- Never keep a date that only records when somebody said something.
- Never use any word or phrase in this list:

```
honest  honestly  actually  basically  essentially  frankly  candidly
truthfully  "stated plainly"  "to be fair"  "to be clear"  "that said"
"having said that"  caveat  "really just"  "really only"  rung  rungs
```

- Never write `A, not B` or `A rather than B` or `instead of B`. State what is
  true.
- Never use an en dash. A comma, a colon or a full stop carries the same break.

Return the rewritten section and nothing else. No preamble, no explanation of
your edits, no code fence around the whole answer.
