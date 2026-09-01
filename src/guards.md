# Every guard in this tool, and who asked for it

A guard refuses somebody's message. That authority comes from a person who asked for
it, or from an incident somebody measured. This file records which, per guard, and
`test/guards.test.ts` refuses a new guard that is absent from it.

WHY IT EXISTS. The operator asked for one change to the rewriter, the subject-less
sentence, and got that change plus a guard nobody had asked for, plus a fix to a
second guard that the first one tripped. Their verdict: additional busywork created
between agents, which slowed the feature down. A guard that names its requester
cannot be added on the way past.

HOW TO ADD A GUARD. Write the line here first, with the requester or the measured
incident. A requester column with no true answer in it means the guard is
unrequested work: file it and move on.

## The language rules, which run on every send

| Rule | Who asked |
|---|---|
| `deferring a decision the writer owns` | operator, "YOU are the sole developer of this codebase" |
| `filler` | operator, the banned-words list |
| `announcing candor` | operator, the banned-words list |
| `hedge` | operator, the banned-words list |
| `minimizing really-just` | operator, the banned-words list |
| `minimization of work` | operator, the banned-words list |
| `internal shorthand nobody outside can read` | operator, "Nobody else ever understands" |
| `coined jargon: 'land' for committing` | operator, on coined vocabulary |
| `human-team vocabulary (agents are not staff)` | operator, on human-organization words |
| `em dash` | operator, the banned-words list |
| `en dash` | operator, the banned-words list |
| `adverb parked between commas` | operator, the banned-words list |
| `antithesis (A not B / A rather than B)` | operator, "anything else like this is AI slop" |
| `contrast tail at sentence end` | operator, on trailing asides |
| `redundant closer / meta-commentary` | operator, on closing scaffolding |
| `announcement scaffolding` | operator, on opening scaffolding |
| `dated log line in the repo's own text` | operator, "such logs should not be in the code" |

## The rewrite guards, which read the model's answer

| Guard | Who asked |
|---|---|
| `the rewrite copied its own instruction into the message` | measured: an answer closed with a paragraph addressed to the author |
| `the rewrite dropped N thing(s) yours carried` | measured: a fact left a message and nobody saw it go |
| `the rewrite added a mention yours never had` | measured: a rewrite notified somebody the author had not named |
| `the rewrite stopped a mention from notifying anyone` | measured: a mention moved into a code span and reached nobody |
| `the rewrite removed the first person from a message that had it` | measured: "I stopped restarting" became a description with nobody in it |
| `the rewrite named an actor as the one who acted` | UNREQUESTED, added beside the operator's subject-less change; kept because the change it guards was theirs and the empty subject slot is what a model fills |
| `the rewrite flattened the logic` | measured: a stated link between two facts went missing |
| `the rewrite invented a reason` | measured: 98 of 190 guard hits on one ledger |
| `the rewrite introduced a claim strength yours did not use` | measured: 31 of 190 guard hits on one ledger |
| `the rewrite came back at a share of your draft's word count, under the floor` | operator, "Word count should be no less than 80% of original" |
| `the rewrite broke N language rule(s)` | operator, the banned-words list |
