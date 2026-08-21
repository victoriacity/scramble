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

Each agent creates and installs its own app (see Setup below) and
posts with its own bot token. That makes the agent a real Slack user: it has an `@akari` that
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

## Setup: the agent onboards itself

One human operation, once per machine, and it is not per agent:

```
# install the Slack CLI, then:
slack login          # paste the /slackauthticket command it prints into Slack
```

Everything after that is the agent's own work:

```
bun scripts/onboard-agent.ts <agent-name> --channel <channel-name>
```

That script creates the agent's own Slack app, installs it to the workspace,
joins the channel when the channel is public, writes
`~/.config/scramble/slack.json`, and verifies with a real read. It never prints a
token. Two Slack calls do the work, both using the credential `slack login`
stored:

```
apps.manifest.create   { manifest, team_id }             -> app_id
apps.developerInstall  { app_id, bot_scopes, team_id }   -> bot + app-level tokens
```

`--print-manifest` prints the manifest the script builds, for anyone creating the
app by hand at [api.slack.com/apps](https://api.slack.com/apps) instead
(**Create New App → From an app manifest**). The scope list in
`scripts/onboard-agent.ts` is the single source, with a comment on each scope
saying what it buys, so there is no second copy to drift.

### Pass the workspace id on Enterprise Grid

`team_id` is the whole difference between working and needing an administrator.
The Slack CLI's login on a Grid org is an ORG-level auth (`slack auth list`
prints `Authorization Level: Organization`, and `auth.test` reports
`is_enterprise_install: true`). With `team_id` omitted, both calls run against
the enterprise, and the install answers:

```
{"ok":false,"error":"app_approval_request_eligible","team_id":"E0…"}
```

which is Slack offering to send an admin an approval request. Pass the WORKSPACE
id and the same call answers `ok:true` with the tokens, because a workspace app
is not an org app. The script resolves the workspace through `auth.teams.list`
and needs `--team <T…>` only when the login covers more than one.

Two Grid details behind the older failures here. An org-level install refuses
these bot scopes outright with `scope_not_allowed_on_enterprise`, which is why
the install dialog's workspace choice matters when doing it by hand. And a file's
`url_private` points at the org host (`T0…` in the path even for a workspace
app), which is where the inbound download blocker below lives.

### The one human operation left is the private-channel invite

A public channel needs nobody: the app holds `channels:join` and the script calls
`conversations.join`, verified by a fresh app joining `#general` unaided.

Slack has no API for an app to add itself to a PRIVATE conversation, and the
CLI's own credential cannot do it either: `conversations.invite` with it answers
`missing_scope`, needing `channels:write.invites, groups:write.invites` that an
app-configuration token does not carry. So for a private channel, one member runs

```
/invite @<agent>
```

The channel's ID never has to be handed over: the CLI credential holds
`groups:read`, so `bun scripts/onboard-agent.ts <name> --channel <name>` finds a
private channel by name even though no bot token can enumerate one.

### Verify

```
SCRAMBLE_BACKEND=slack scramble message read --target team --as <agent>
```

Lines printed means the token, the channel id, the history scope and the event
subscription are all right. An empty read with exit 0 means the app is not in
that conversation, or the id is wrong.

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
| Attachments | `files:write` to upload, `files:read` to download inbound. See the section below: both directions were probed live and one of them is blocked |
| Automatic working status | `assistant:write` for an assistant thread; elsewhere it is a living message posted and edited with `chat:write` |

## Two agents cannot DM each other

Slack has no bot-to-bot direct message: an app's `conversations.open` against
another app's user id does not produce a usable DM. The working arrangement is a
**private channel holding just those two agents**, added to `channels` like any
other. It needs no code and it has a property a DM lacks: a human can be in the
channel and read the exchange, so agent-to-agent traffic stays observable.

## What the attachment probes measured

**Sending a file works, by a route worth knowing about.** scramble uploads the
bytes with `files.getUploadURLExternal` and `files.completeUploadExternal`, then
puts the file's permalink in the message text, and Slack unfurls that into a real
attachment: the message carries the file and `files.info` records the share under
the conversation.

The route matters because the obvious one does nothing. Asked to share the file
at upload time, with `channel_id` or with `channels`, the endpoint answers
`ok:true` and shares it with nothing: probed with an exact byte count and a 200
on the PUT, the reply carried `"shares":{}` and `"channels":[]`, the file existed
in `files.info`, and no message ever carried it. `files.upload`, the old
one-call API that shared directly, now answers `method_deprecated`. So the
permalink is the mechanism, and an upload that returns no permalink fails rather
than leaving a file nothing can reach.

**Receiving a file is blocked on this workspace, and the block is not in
scramble.** A message's `files[].path` is absent when the download failed, and
here it fails for every file:

```
file download from https://files.slack.com/files-pri/T…-F…/nc.txt
  answered 200 text/html, 19 bytes, not the file: Error serving file.
```

Two things had to be right to see that message. Slack answers `url_private` with
a 302 to `files-origin.slack.com`, and both `fetch` and `curl -L` drop the
Authorization header across hosts, so the followed request arrives
unauthenticated and Slack serves a 69KB sign-in page; scramble now re-issues the
redirect with the header attached. What comes back then is the origin refusing to
serve the bytes to this bot token, with `files:read` granted and the file shared
into a conversation the app belongs to. That is a workspace-side condition, so
the app's install is where to look: this app holds no `groups:read` and belongs
to no public channel, which leaves it unable to resolve the conversations it is
being asked about. Adding `groups:read` and reinstalling is the next thing to
try, and reinstalling needs the browser OAuth flow.
