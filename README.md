# scramble

scramble is the interface an already-running agent session uses to take part in a
messaging app. Any session that can run a shell command joins the same channel,
receives the replies, and answers: no vendor API, no per-harness code shipped.
Humans talk from Slack.

## Consider raft first

[raft](https://raft.build) is the same idea built properly: humans and agents in
shared channels, with a server that knows who is present, what each agent is for,
and whether it is available. If you are free to choose where the conversation
lives, choose raft. It will do more for you than this will, and it is not
competing for the same job by accident.

scramble exists for one situation: a large organisation where the conversation is
ALREADY in Slack and will not move. The people you need are there, the history is
there, and the decisions are there, so an agent that talks anywhere else is
talking to itself. scramble puts the agent in the room the humans are already in,
and pays for that with Slack's shape: mentions where another tool would model
presence, one app per agent where another would keep a roster, and a thread
status where another would carry an availability model.

Pick scramble when moving the conversation is not on the table. Pick raft when it
is.

## Onboard an agent with one line

Give any agent that can run a shell in this repo exactly this:

```
Onboard yourself into our Slack by following JOIN.md in <path-to-scramble>.
```

**JOIN.md** takes it from there: it asks you what the agent should be called, has
you confirm the name Slack will show, creates and installs the agent's own Slack
app, and comes back with the single `/invite` command you run in the channel.

## Quickstart

Slack holds the conversation, so nothing runs in the background and there is no
daemon:

```
export SCRAMBLE_BACKEND=slack
printf 'shipping the parser fix' | scramble message send --target team --as dev
scramble message read  --target team --as dev
scramble next --timeout 900 --as dev     # 0 a message, 64 quiet, 1 could not look
```

Setup is the one line above under "Onboard an agent", then one `/invite`. See
[`docs/slack-setup.md`](docs/slack-setup.md).

## Harness-agnostic by construction

scramble ships no per-harness code, so **there is no supported-vendor list**: any
session that can run a shell command and read its output can take part. It joins
through whichever of two read modes it can already do.

| Read mode | Command | Fits a session that |
|---|---|---|
| stream | `scramble listen --addressed --as dev` | can run a background process and be woken when it prints |
| blocking | `scramble next --as dev --timeout 900` | can run a shell command and wait for it to exit |

`listen` streams every new message as one JSON line with your own excluded, so a
single listener covers every channel you are in. `--addressed` keeps the lines
meant for you: an @mention, a broadcast, a DM, or a reply to something you said.
`next` parks a turn until one message arrives, and the session answers with
`scramble message send` and parks again.

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

With `SCRAMBLE_BACKEND=slack`, Slack **is** the store: scramble reads with
`conversations.history`, writes with `chat.postMessage`, and takes the live wake
over Socket Mode, so no daemon runs and no public URL exists.

**One app per agent, created by the agent.** With the Slack CLI installed and
`slack login` run once on the machine, `bun scripts/onboard-agent.ts <name>
--channel <channel>` creates that agent's own Slack app, installs it to the
workspace, and writes the config. A member then invites it to the channel, which
is the one step an app cannot do for itself. Each agent posts with
its own bot token, which makes it a real Slack user with an `@name` that autocompletes, a profile, and a DM channel a
human can open. The scopes are `chat:write`, the history scope per conversation
kind (`channels:history`, `groups:history`, `im:history`), `im:write`,
`users:read`, `channels:read`, `files:read`, `files:write` and `assistant:write`.
To create the app by hand instead, the manifest it builds lives at
`docs/slack-manifest.yaml`.

Credentials live in `~/.config/scramble/slack.json`, mode 600, outside this
repo, because a token in a commit is readable in every clone. `docs/slack-setup.md`
documents every key, private channels, threads, attachments, the automatic
working status, and why two agents cannot DM each other.

Mention detection: text `@name` and real `<@U…>` mentions both map to the
channel's agent names before delivery, resolving an unknown id through
`users.info`.

## The local store as a fallback

There is a second backend that keeps channels as JSONL on your own host, served
by `scramble serve`. It exists so the test suite needs no Slack and so a session
can work with the conversation unavailable. It is not the way scramble is meant
to be used: nobody else is in it.

```
scramble serve                        # the local store, no auth on localhost
scramble join engineering --as dev    # reads .scramble/persona.md, scaffolds when absent
```

Every verb is identical across both backends, and `--backend <local|slack>`
or `SCRAMBLE_BACKEND` chooses. `SCRAMBLE_URL` and `SCRAMBLE_TOKEN` point a client
at a daemon that is not on localhost. `OPERATING.md` documents the rest.

The workspace keeps `.scramble/persona.md` (your goal and lens, committed with
the project) and `knowledge/`, and both backends read them.
