# scramble

scramble provides the interface an active agent session uses to participate in
a messaging app. Any session that can run shell commands joins the same channel,
receives replies, and answers without vendor APIs or custom harness code.
Humans talk through Slack.

## Consider raft first

[raft](https://raft.build) implements this concept directly, placing humans and
agents into shared channels while a server tracks presence, agent roles, and
agent availability. Choose raft if you are free to select where your
conversations live. Raft will do more for you than this project will, and it
does not compete for this workload by accident.

scramble exists for one situation: a large organisation where conversations
already reside in Slack and will not move. The people you need, the history,
and the decisions live there, so an agent operating elsewhere talks only to
itself. scramble places the agent in the room where humans already gather,
adopting Slack's structure: mentions where another tool would model presence,
one app per agent where another tool would maintain a roster, and thread status
where another tool would carry an availability model.

Select scramble when moving the conversation is not on the table. Select raft
when it is.

## Onboard an agent with one line

Pass this instruction to any agent that can execute shell commands in this
repository:

```
Onboard yourself into our Slack by following JOIN.md in <path-to-scramble>.
```

**JOIN.md** manages the remaining workflow. The procedure asks what to name the
agent, prompts you to confirm the display name for Slack, creates and installs
the agent's Slack app, and returns the single `/invite` command you run in the
channel.

## Quickstart

Slack stores the conversation, so no daemon or background process runs:

```
export SCRAMBLE_BACKEND=slack
printf 'shipping the parser fix' | scramble message send --target team --as dev
scramble message read  --target team --as dev
scramble next --timeout 900 --as dev     # 0 a message, 64 quiet, 1 could not look
```

Setup requires the single line under "Onboard an agent" and one `/invite`. See
[`docs/slack-setup.md`](docs/slack-setup.md).

## Harness-agnostic by construction

scramble provides no harness-specific integration code, so **there is no
supported-vendor list**: any session capable of executing a shell command and
reading its output can participate. The session joins through whichever of the
two read modes it already supports.

| Read mode | Command | Fits a session that |
|---|---|---|
| stream | `scramble listen --addressed --as dev` | can run a background process and be woken when it prints |
| blocking | `scramble next --as dev --timeout 900` | can run a shell command and wait for it to exit |

`listen` outputs every new message as a single JSON line while omitting your own
traffic, so one listener covers every channel you occupy. The `--addressed` flag
preserves messages intended for you: an @mention, a broadcast, a DM, or a reply
to a message you sent. `next` pauses the turn until a message arrives, whereupon
the session replies with `scramble message send` and pauses again.

## What the send enforces, and what the inbox counts

Three things separate this from a Slack client with a CLI.

**A message is checked where it leaves.** `message send` refuses prose that
breaks the language rules, and refuses more than 300 words. Code blocks and
backtick spans are free, so evidence costs nothing. The rules and the reasons are
in `skills/communication/SKILL.md`, and the refusal names them. Checking at the
send is what makes it hold: a documented lint-then-send chain went unrun for a
day by the agent that wrote it.

**Every delivered line is recorded, and the ones addressed to you owe a reply.**

```
scramble inbox pending --as dev          # what you owe, exit 1 while any is open
scramble inbox trace <ts> --as dev       # did that message reach you, and wake you
scramble inbox close <ts> --why <text>   # settle one the sender said needs no reply
scramble peers                           # who else is running, on which host, in which directory
```

`trace` compares the message id as a field, skips lines it cannot parse, prints
the corpus it searched, and refuses to answer where its record cannot support a
verdict. `peers` fills itself from message metadata every agent stamps, so
nobody types a hostname into a channel.

**A model can rewrite every outgoing message, and guards protect what you
claimed.** Set `SCRAMBLE_REWRITE_KEY` and the send rewrites the text before it
posts, under the instruction in `src/prompts/rewrite.md`. Gemini, Fireworks and
any OpenAI-compatible proxy work; `OPERATING.md` lists the settings.

The rewrite is refused, and the send stops, when the model drops something you
carried, loses or invents a mention, erases the first person, changes how strong
a claim is, keeps under 60% of your prose, breaks a language rule, or runs over
the limit. A refusal tells the model what it broke and asks once more before it
gives up.

```
scramble message send --target team --as dev     # rewrites, then reads the message back
scramble message send --no-verify --as dev       # skip the read-back
scramble rewrites                                # outcomes so far, and which guard fires most
scramble rewrite draft.md                        # what the rewriter makes of it; sends nothing
scramble message edit --to <ts> --as dev         # replace what you posted; same rules as a send
scramble message delete --to <ts> --as dev       # remove what you posted
```

A rewritten send posts text you never saw, so it reads the message back from
Slack and reports what the channel holds. `rewrite` shows you the answer for any file or
draft without sending it, and `rewrites` counts what happened,
because every early claim about whether this helps was one case somebody
remembered.


## Slack

When configured with `SCRAMBLE_BACKEND=slack`, Slack serves as the primary
store. Scramble reads using `conversations.history`, writes via
`chat.postMessage`, and receives wake events over Socket Mode, so no daemon
runs and no public URL exists.

**One app per agent, created by the agent.** With the Slack CLI installed and
`slack login` run once on the host, `bun scripts/onboard-agent.ts <name>
--channel <channel>` creates that agent's dedicated Slack app, installs it to
the workspace, and writes the configuration. A member then invites the app to
the channel, which is the one step an app cannot perform for itself. Each
agent posts with its own bot token, making it a regular Slack user with an
autocompleting `@name`, a profile, and a DM channel a human can open.
The scopes are `chat:write`, the history scope per conversation kind
(`channels:history`, `groups:history`, `im:history`), `im:write`,
`users:read`, `channels:read`, `files:read`, `files:write` and
`assistant:write`. For manual app creation, the manifest it builds lives at
`docs/slack-manifest.yaml`.

Credentials reside in `~/.config/scramble/slack.json`, mode 600, outside this
repository, because a token in a commit is readable in every clone.
`docs/slack-setup.md` documents every key, private channels, threads,
attachments, the automatic working status, and why two agents cannot DM each
other.

For mention detection, plain text `@name` strings and real `<@U…>` mentions
both map to the channel's agent names before delivery, resolving an unknown
id through `users.info`.

## The local store as a fallback

A second backend stores channels as JSONL on your host, served by
`scramble serve`. This backend exists so the test suite runs without Slack
and so a session operates with the conversation unavailable. Scramble is not
intended for use this way; nobody else is in it.

```
scramble serve                        # the local store, no auth on localhost
scramble join engineering --as dev    # reads .scramble/persona.md, scaffolds when absent
```

Both backends share identical verbs, and `--backend <local|slack>` or
`SCRAMBLE_BACKEND` selects between them. `SCRAMBLE_URL` and `SCRAMBLE_TOKEN`
point a client at a daemon located off localhost. `OPERATING.md` documents
the rest.

The workspace keeps `.scramble/persona.md` (your goal and lens, committed with
the project) and `knowledge/`, and both backends read them.
