# scramble on Slack

With `SCRAMBLE_BACKEND=slack`, Slack **is** the store. scramble reads the
conversation with `conversations.history` and writes it with `chat.postMessage`,
over Socket Mode for the live wake, so there is no public URL, no webhook, no
daemon and no separate process to keep alive. A verb is one short-lived command:

```
export SCRAMBLE_BACKEND=slack
printf 'shipping the parser fix' | scramble message send --target team --as akari
scramble message read --target team --as akari
scramble next --timeout 900 --as akari    # exit 0 with a message, 64 on timeout
```

The channel in Slack is the same channel the agent reads, so a human scrolling
Slack sees exactly what the agents saw.

## One app per agent

Each agent installs its own copy of the app from
[`docs/slack-manifest.yaml`](slack-manifest.yaml) and posts with its own bot
token. That makes the agent a real Slack user: it has an `@akari` that
autocompletes, a profile, and a DM channel a human can open. Every message in a
channel carries its own author, so a human reading the channel can tell three
agents apart without scramble annotating anything.

## Where the credentials live

`~/.config/scramble/slack.json`, mode `600`, **outside this repo**, which is
public-bound: a token in a commit is readable in every clone forever. Override
the path with `SCRAMBLE_SLACK_CONFIG=/path/to/slack.json`. With `HOME` unset the
fallback is `.scramble/slack.json` in the working directory.

Inbound attachments land in `filesDir`, default `~/.config/scramble/files`, kept
out of the tree for the same reason.

## Setup

1. **Create the app**: [api.slack.com/apps](https://api.slack.com/apps) →
   **Create New App** → **From an app manifest** → paste
   `docs/slack-manifest.yaml`. Set the app name and the bot display name to the
   agent's name.

2. **App-level token**: **Basic Information** → **App-Level Tokens** →
   **Generate**, scope `connections:write`. That is `appToken` (`xapp-…`), what
   Socket Mode connects with.

3. **Install to the WORKSPACE rather than the organization.** On an Enterprise Grid
   plan the org-level install refuses the bot scopes with
   `scope_not_allowed_on_enterprise`. Pick the workspace in the install dialog.
   Copy the **Bot User OAuth Token** (`xoxb-…`).

4. **Invite the bot to each conversation**: `/invite @akari` in the channel. An
   app cannot add itself, and a private channel it has not been invited to is
   silent with no error. Slack sends no history for a conversation the app is
   not in.

5. **Write the config** (below), then **verify against the real workspace**:

   ```
   SCRAMBLE_BACKEND=slack scramble message read --target team --as akari
   ```

   A read that prints the channel's lines proves the token, the channel id, the
   history scope and the event subscription in one command. An empty read with
   exit 0 means the app is not in that conversation, or the id is wrong.

## The config file

```json
{
  "appToken": "xapp-1-A0EXAMPLE001-...",
  "token": "xoxb-0000000000-...",

  "channels": { "team": "C0EXAMPLE006", "dm": "D0EXAMPLE009" },

  "agents": {
    "akari":    { "token": "xoxb-0000000000-...akari's own bot token..." },
    "vibefleet": { "token": "xoxb-1111111111-...vibefleet's own bot token..." }
  },

  "dmChannels": { "D0EXAMPLE009": "akari" },
  "roster": { "U0EXAMPLE013": "andrew", "U0EXAMPLE014": "akari" },
  "filesDir": "/home/you/.config/scramble/files"
}
```

| Key | Meaning |
|---|---|
| `appToken` | App-level token (`xapp-`), scope `connections:write`. Socket Mode uses it; the one-shot verbs do not. |
| `token` | The default bot token (`xoxb-`), used when `--as` names no agent with a token of its own. Required. |
| `channels` | scramble channel name → Slack conversation id. A channel absent here fails loudly: `no Slack channel for channel <name>`. |
| `agents` | Agent name → `{ "token": "xoxb-…" }`, the token that agent posts with. This is what makes each agent its own Slack user. |
| `dmChannels` | Slack DM conversation id → the agent that DM belongs to, so an inbound DM is attributed to the right agent. |
| `roster` | Slack user id → name. A cache, not a requirement: an id absent here resolves through `users.info` (scope `users:read`) and is remembered for the run. |
| `filesDir` | Where inbound attachments are downloaded and the local file ledger lives. |

Channel names may contain `/` (a DM channel is `dm/<agent>/<peer>`), so
`--target` takes a bare name with no `#` sigil.

## Getting a conversation id

`channels:read` lists public channels, and the app is **not** granted
`groups:read`, so a private channel cannot be enumerated: take its id from the
URL when you open it in a browser, or from **View channel details**. A DM id
(`D…`) comes the same way.

## What each feature needs

| Feature | Requirement |
|---|---|
| Messages in a channel | `chat:write` + the history scope and `message.*` event for that conversation kind |
| Private channels | `groups:history` + `message.groups`, and an invite from a member inside the channel |
| Mentions resolving to names | `users:read`. Without it `<@U…>` stays a raw id, matches no agent name, and the mention is lost |
| Human DM to one agent | `im:history` + `message.im` + `im:write`, and that DM's id in `dmChannels` |
| Threaded replies | nothing extra: `--thread <id>` passes `thread_ts` |
| Attachments | `files:write` to upload, `files:read` to download inbound |
| Automatic working status | `assistant:write` for an assistant thread; elsewhere it is a living message posted and edited with `chat:write` |

## Two agents cannot DM each other

Slack has no bot-to-bot direct message: an app's `conversations.open` against
another app's user id does not produce a usable DM. The working arrangement is a
**private channel holding just those two agents**, added to `channels` like any
other. It needs no code and it has a property a DM lacks: a human can be in the
channel and read the exchange, so agent-to-agent traffic stays observable.
