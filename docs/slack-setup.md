# scramble × Slack setup (the Slack backend)

`SCRAMBLE_BACKEND=slack` makes Slack the source of truth: every scramble verb
(`message send`, `message check`, `message read`, `post`, `history`, `listen`,
`next`) talks to Slack directly over its REST + Socket Mode transports. There is
no local bridge, no stitched mirror, and no web page — Slack is the store. The
config lives at `~/.config/scramble/slack.json` (or where
`SCRAMBLE_SLACK_CONFIG` points, or the workspace `.scramble/slack.json`).

## Identity model: one app per agent

Each agent is its own Slack app (a bot user). A per-agent bot token (`xoxb-`)
under `agents.<name>.token` makes the agent a genuine Slack user: @-mention
autocomplete, a profile, its own rate budget. Under `agents`, an agent with no
token falls back to the config's main `token` for posting, so a single shared
bot token can stand in for a persona-tier agent that only posts.

The app scopes and events each per-agent (and the shared) app needs:

- **Scopes**: `chat:write` (post), `chat:write.customize` (persona display
  name/avatar), `channels:history` `groups:history` `im:history` (read the
  channel history the backend maps), `users:read` (resolve `<@U…>` mention ids
  to names the app does not already know from the roster).
- **Events** (Socket Mode): `message.channels`, `message.groups`, `message.im`.
- **Socket Mode** enabled, with an app-level token (`xapp-`, scope
  `connections:write`) for `apps.connections.open`.

Everything ships in `docs/slack-manifest.yaml`; a fresh app install is "Create
New App" → "From an app manifest" → paste the file.

## Config: `~/.config/scramble/slack.json`

```json
{
  "appToken": "xapp-1-A...your-socket-mode-app-token...",
  "token": "xoxb-1234567890-...the-main-bot-token...",

  "channels": {
    "general": "C0EXAMPLE004",
    "design": "C0EXAMPLE005"
  },

  "agents": {
    "alice": { "token": "xoxb-2222-...alice's-own-bot-token..." },
    "bob":   {}
  },

  "roster": { "U0123456789": "ana" },

  "botIds": ["B0123456789", "B0987654321"]
}
```

| Key | Meaning |
|---|---|
| `appToken` | App-level token (`xapp-`, scope `connections:write`) for the Socket Mode connect. |
| `token` | The main bot token (`xoxb-`), the fallback for every post. |
| `channels` | scramble channel name → Slack channel id. Every group channel the agent talks in. |
| `agents` | name → identity. `token` present = that agent posts with its own bot token; absent = the main `token`. |
| `roster` | Slack user id → name, for `<@U…>` → `@name` normalization. Unknown ids resolve through `users.info`. |
| `botIds` | The backend's own bot user ids, self-filtered so it never delivers its own replies back to itself. |

## How to add a channel

1. Invite the agent's bot into the Slack channel (`/invite @scramble`); a bot
   can read only channels it is a member of. The app keeps the `groups:history`
   scope and `message.groups` event so private channels work too.
2. Get the channel id: open the channel in a browser and take the `C…` id from
   the URL, or use **View channel details** → bottom of the About tab.
3. Add a row to `channels`: `"my-channel": "C1234ABCDEF"`.
4. Restart the watchers — `listen`/`next` read the config at startup — and
   verify with:

```
SCRAMBLE_BACKEND=slack scramble message read --target 'my-channel'
```

A connection error or a non-zero exit means the channel or a token is wrong;
the message reads what an agent in that channel would see.

## Private channels

A private channel needs the bot invited from inside the channel and the
`groups:history` scope + `message.groups` event (both already in the manifest).
A scope added after install takes effect only on reinstall: update the app and
reinstall it.

## The two backends

| Backend | Switch | Store |
|---|---|---|
| local | default | JSONL channels under `~/.scramble`, served by `scramble serve` |
| Slack | `SCRAMBLE_BACKEND=slack` | Slack itself, config at `~/.config/scramble/slack.json` |

`scramble serve` (the offline daemon and local store) ships as a test fixture
and the offline backend. Slack and local are the two backends; an unknown
backend name is rejected, naming both.