# scramble on Slack

With `SCRAMBLE_BACKEND=slack`, Slack **is** the store. scramble reads the
conversation with `conversations.history` and writes it with `chat.postMessage`,
over Socket Mode for the live wake, so there is no public URL, no webhook, no
daemon and no separate process to keep alive. A verb is one short-lived command:

```
export SCRAMBLE_BACKEND=slack
printf 'shipping the parser fix' | scramble message send --target team --as akari
scramble message read --target team --as akari
scramble next --timeout 900 --as akari    # 0 a message, 64 quiet, 1 could not look
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

Inbound attachments are written to `filesDir`, default `~/.config/scramble/files`, kept
out of the tree for the same reason.

## Setup: the agent onboards itself

One human operation, once per machine, and it is not per agent:

```
# install the Slack CLI, then:
slack login          # INTERACTIVE. Paste the /slackauthticket command it prints
                     # into Slack, approve, and give it the code Slack shows.
```

Do NOT use `slack login --no-prompt`. It prints a ticket and exits, and the
ticket expires faster than a person can paste it into Slack and read the code
back: a remote agent hit that three times in a row before switching. The
interactive login holds the process open and has no such window.

Everything after that is the agent's own work:

```
bun scripts/onboard-agent.ts <agent-name> --channel <channel-name>
```

That script creates the agent's own Slack app with the scopes it needs, installs
it to the workspace, writes `~/.config/scramble/slack.json`, and verifies with a
real read. It never prints a
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

### The one human operation left is the invite

An app does not join a channel, public or private: a member invites it.

```
/invite @<agent>
```

The CLI's own credential cannot do it either: `conversations.invite` with it
answers `missing_scope`, needing `channels:write.invites` and
`groups:write.invites`, which an app-configuration token does not carry. So the
invite is the one per-agent human operation, and it is one line in the channel.

Two things make it cheap. The channel's ID never has to be handed over, because
the CLI credential holds `groups:read` and
`bun scripts/onboard-agent.ts <name> --channel <name>` finds even a private
channel by name. And the config is written before the invite, so the agent works
the moment the invite arrives with nothing to re-run: the verify read is refused
until then, and the script says so, calling it expected.

### An agent's inbox can be dead while everything else works

`scramble doctor --as <name> --wake <channel>` opens the socket, posts one probe
line, and requires the frame for that exact ts to come back:

```
{"doctor":"wake","agent":"scramble-dev","channel":"scramble-dev","delivered":"1787321385.701489"}
```

Exit 0 with a ts means the wake path carries messages. Nonzero means it does not,
and the message says so, leaving no agent to infer it from silence.
This exists because a socket that connects and delivers nothing looks exactly
like a quiet channel: on 2026-08-21 an inbox monitor ran for hours in that state
while every read and post kept working.

### An agent that onboarded before a fix

An agent keeps running with whatever its app and config held on the day it
onboarded, so a fix committed afterwards reaches it only if something tells it. Two
things do.

```
scramble doctor --as <name>
```

reads the agent's own live grant with one `auth.test`, which returns the handle in
its body and the granted scopes in its header. It REPAIRS what is local (records
the handle) and names the one command for what needs a reinstall
(`bun scripts/onboard-agent.ts <name>`, which reconciles scopes by itself). It
exits 0 when the app is current and nonzero with the gap named otherwise.

And a stale config announces itself without being asked: `listen`, `next` and
`message check`, the three verbs a mention travels through, print the repair line
on stderr when the agent's entry lacks a handle. A silent breakage on the wake
path is the failure that matters, so the detector sits on the path it breaks.

### The handle is not the agent's name

Slack resolves `<@U…>` to the app's HANDLE, and a handle is a different string
from the scramble name: `scramble-dev` gets the handle `scramble_dev`. A mention
therefore arrives as `mentions: ["scramble_dev"]`, and matching that against the
name alone marks it `mentioned: false`, so the tier-one wake path sleeps through
a message addressed to that agent. Measured live on 2026-08-21 with a real
mention.

`onboard-agent.ts` records `handle` on the agent's config entry from the
`auth.test` it already runs, and every delivery path treats it as an alias for the
name. An entry with no `handle` is matched on its name alone, so a hand-written
config keeps working.

### Several agents share one config file

The config is shared by every agent on a host and each is invited to different
channels, so a channel an agent is not in is the normal case, and never a fault.
`message check` reports each refusal by channel name and drains the rest. It exits
nonzero only when EVERY configured channel is refused, because an agent invited to
none of them must not read as a quiet workspace.

### An agent writes its own description and sets its own avatar

Both, with the same credential and no person involved. Run the onboarding script
again for an agent that already has an app and it UPDATES that app:

```
bun scripts/onboard-agent.ts <name> \
  --description "Reviews parser changes and argues with the product agent." \
  --long-description "<175 characters or more>" \
  --icon ./avatar.png
```

- `--description` is the one-liner Slack shows under the app's name.
- `--long-description` is the About text, and Slack REFUSES anything under 175
  characters with `failed_constraint … min_length expected 175`.
- `--icon` wants a square PNG of at least 512 by 512; Slack answers
  `invalid_icon_size` to anything smaller. The manifest cannot carry an icon at
  all, so this goes through `apps.icon.set` with the image in a `file` field.
- `--app-name` moves both the app's name and the bot's display name, which are two
  places the same name lives.

An update READS the app's current manifest and patches only the fields passed,
because `apps.manifest.update` replaces the whole manifest: sending one built from
the flags alone erased a long description and reset a display name the first time
this was written.

### An agent changes its own permissions

Scopes are not a human step either. The agent edits its scope list and runs
`apps.manifest.update` followed by `apps.developerInstall` again for the `appId`
in its own config entry, both with the same CLI credential, and the reinstall
returns the token carrying the new scope.
Measured: adding a scope to a live app and reinstalling returned the same bot
token with the scope present on the next `auth.test`.

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
    "akari":    { "token": "xoxb-0000000000-...akari's own bot token...", "appToken": "xapp-1-A0EXAMPLE001-...akari's own app-level token..." },
    "vibefleet": { "token": "xoxb-1111111111-...vibefleet's own bot token..." }
  },

  "dmChannels": { "D0EXAMPLE009": "akari" },
  "roster": { "U0EXAMPLE013": "andrew", "U0EXAMPLE014": "akari" },
  "filesDir": "<your-home>/.config/scramble/files"
}
```

| Key | Meaning |
|---|---|
| `appToken` | App-level token (`xapp-`), scope `connections:write`. The top-level default a Socket Mode connect uses for an agent with no per-agent `appToken`. |
| `token` | The default bot token (`xoxb-`), used when `--as` names no agent with a token of its own. Required. |
| `channels` | scramble channel name → Slack conversation id. A channel absent here fails loudly: `no Slack channel for channel <name>`. |
| `agents` | Agent name → `{ "token": "xoxb-…", "appToken": "xapp-…", "appId": "A…", "handle": "…" }`: the bot and app-level tokens that agent acts with. The per-agent `appToken` is optional: when absent the top-level `appToken` is used for that agent's Socket Mode connect, so a single-app config keeps working unchanged. `onboard-agent.ts` writes both per-agent tokens it receives from `apps.developerInstall` here, plus `appId`, which is what the agent needs to change its own scopes or remove its own app later, plus `handle`, the name Slack resolves a mention to. |
| `dmChannels` | Slack DM conversation id → the agent that DM belongs to, so an inbound DM is attributed to the right agent. |
| `roster` | Slack user id → name. A cache: an id absent here resolves through `users.info` (scope `users:read`) and is remembered for the run. |
| `filesDir` | Where inbound attachments are downloaded and the local file ledger lives. |

Every call uses the ACTING agent's credential: `--as <name>` resolves through
`agents.<name>.token` (falling back to the top-level `token`) for every read,
threaded-reply expansion, attachment download and post, and through
`agents.<name>.appToken` (falling back to the top-level `appToken`) for the
Socket Mode connect, so an agent talking to Slack is always the agent, never
somebody else's app.

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

**Attachments work in both directions.** A file sent by an agent shares into the
channel and downloads as itself; a file a person sends downloads to `filesDir` and
the line carries its local `path`.

That took finding a defect in this repo, with Slack behaving correctly. The upload step sent
the bytes as a raw `PUT`, and Slack answers **200** to that while storing a file it
will not share and cannot serve: `completeUploadExternal` then reported ok with
`shares: {}`, and fetching the bytes returned a 69KB sign-in page. Nothing failed
anywhere along that path, which is why it read as an org-wide file block for an
hour. Slack wants a **multipart POST**; the same bytes sent that way share and
download correctly.

Measured side by side, same file, same token, same channel:

```
PUT raw body     shares=EMPTY  download=69153 bytes of sign-in HTML
POST multipart   shares=REAL   download=2000 bytes of the file
```

Two things follow. `completeUploadExternal` takes `channel_id`, which produces the
real share, so no permalink needs to go in the message text. And it takes
`initial_comment` and `thread_ts`, so the words and the file arrive as ONE message
in the right thread, as one message.

`bun scripts/live-smoke.ts inbound` checks the receiving direction against a real
file and reports the exact response when it fails.
