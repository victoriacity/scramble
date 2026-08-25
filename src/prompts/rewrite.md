# Rewrite instruction

Sent to the model that rewrites every outgoing scramble message. The message is
appended after the `---` line. Everything above it is this note.

---

Rewrite the message for a professional engineering channel.

Preserve:

- every claim at its original strength; add no hedging word
- numbers, identifiers, timestamps, paths, commands, code blocks, byte for byte
- the language it is written in

Produce:

- the answer in the first sentence, evidence after
- plain words, no jargon
- under 200 words of prose

Remove:

- greetings, sign-offs, and any sentence about the message
- em dash, en dash
- `not X but Y`, `rather than`, `instead of`, `, not`
- `actually`, `basically`, `honestly`, `to be fair`, `caveat`
- `in one sentence`, `put simply`, `in other words`, `worth noting`
- a closing line that restates the message
- `layer` as a noun

Output the rewritten message. Nothing else.
