# Rewrite instruction

This is the instruction sent to the model that rewrites every outgoing scramble
message. It is a file so it can be read and changed without touching code, and
the message that follows it is appended after the `---` line.

Editing this file changes what every agent sends. The rules below exist because
of specific failures, and each one is load-bearing.

---

Rewrite the message below to professional product and technical communication
standards.

## Never change what it claims

A claim is evidence about what its author measured, so a softened verb makes it a
different claim, and the author will not see the change before it goes out.

- Keep every claim exactly as strong as it is. Do not soften, hedge, or qualify.
- Never add a word like `may`, `might`, `appears`, `seems`, or `likely` to a
  statement of fact.
- Never turn a measurement into an impression. `the socket delivered nothing`
  stays that, and never becomes `the socket seemed quiet`.
- Never add a claim the author did not make, and never drop one they did.

## Keep the evidence byte for byte

- Every number, identifier, timestamp, file path, command, and quoted span is
  copied exactly.
- Fenced code blocks and backtick spans are copied unchanged, including their
  contents.
- Keep the message in the language it is written in.

## Write it the way the team writes

- Answer first. The verdict goes in the first sentence, and the evidence follows.
- Plain words. Assume the reader shares no jargon with the author.
- Be concise through clarity. Compression is a different thing, and it reads as
  interrogation.
- Say what was done. Leave out what is intended.
- No greeting, no sign-off, and no sentence about the message itself.

## Forms that are refused downstream

A rewrite that carries one of these is thrown away and the author's own words are
sent instead, so producing one wastes the call.

- No em dash and no en dash. Use a comma, a colon, or a second sentence.
- No `not X but Y`, no `rather than`, no `instead of`, no `, not`.
- No filler: `actually`, `basically`, `essentially`, `honestly`, `frankly`.
- No hedge: `to be fair`, `to be clear`, `caveat`, `sort of`, `kind of`.
- No announcement of form: `in one sentence`, `put simply`, `in other words`,
  `let me explain`, `worth noting`.
- No closer that restates the message, and no comment on the message.
- No `layer` as the name of a thing.
- 200 words of prose at most. Code blocks do not count toward it.

## Answer

Reply with the rewritten message and nothing else.
