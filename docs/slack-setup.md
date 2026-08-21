# scramble × Slack setup

The Slack bridge (`scramble slack`) connects one internal Slack app to the
scramble channels over **Socket Mode**, with no public URL and no inbound webhook. Each
agent appears as a distinct "user" in the channel through one of two identity
tiers:

- **Persona (default, zero marginal setup)**: `chat:write.customize` lets the
  single app post each agent's messages under that agent's display name and
  avatar. Display-only identity: not in @-mention autocomplete, no presence, no
  DM channel.
- **Real bot user (optional, per agent)**: configure a per-agent bot token
  (one tiny app per agent). The agent becomes a genuine Slack user: @-mention
  autocomplete, profile, DMs, its own rate budget.

**DMs to an individual agent require the real-bot-user tier.** A *persona* is
not a Slack user entity, so Slack has nothing to open a DM with; only a real
bot token gives the agent both an `@mention` and a DM channel.

## Step-by-step

1. **Create the app** from the bundled manifest:

   - Open [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**
     → **From an app manifest**.
   - Paste the contents of `docs/slack-manifest.yaml` (`chat:write`,
     `chat:write.customize`, `channels:history`, `im:history`; events
     `message.channels`, `message.im`; socket mode enabled).

2. **Generate the app-level token** (`connections:write`):

   - App settings → **Basic Information** → **App-Level Tokens** → **Generate**.
   - Scope: `connections:write`. The result is the `appToken` (starts `xapp-`).

3. **Install the app** for the bot token:

   - **Install App** → **Install to Workspace** → copy the **Bot User OAuth
     Token** (`xoxb-`), which is the `token` used for persona-tier posts.
   - The socket event stream needs the bot in the workspaces you bridge:
     **invite the bot to each channel** (`/invite @scramble`). The bridge
     only echoes text from channels whose Slack channel it is present in.

4. **Write `.scramble/slack.json`** in the workspace the bridge runs from.
   Every key is documented below with a real example.

5. **Verify the config before going live**:

   ```
   scramble slack --dry-run
   ```

   This prints the wired channel→Slack-channel map and each agent's identity tier, and
   exits 0 when the config is valid; it never connects to Slack.

6. **Go live** with the daemon running:

   ```
   scramble serve   # the daemon (channel store + firehose)
   scramble slack   # the bridge in another terminal
   ```

## `.scramble/slack.json`: every key

```json
{
  "appToken": "xapp-1-A...your-socket-mode-app-token...",
  "token": "xoxb-1234567890-...your-app-bot-token...",

  "channels": {
    "general": "C0EXAMPLE004",
    "design": "C0EXAMPLE005"
  },

  "agents": {
    "alice": { "token": "xoxb-2222-...alice's-own-bot-token...", "icon": ":robot:" },
    "bob":   { "icon": ":hammer_and_wrench:" },
    "carol": {}
  },

  "dmChannels": { "D0EXAMPLE008": "alice" },

  "roster": { "U0123456789": "ana" },

  "dmMirrorChannel": "#scramble-dms"
}
```

| Key | Meaning | Example |
|---|---|---|
| `appToken` | **Required.** App-level token (`xapp-`), scope `connections:write`. Used for Socket Mode connect. | `"xapp-1-A1B2..."` |
| `token` | **Required.** The app's bot OAuth token (`xoxb-`), used for every persona-tier post. | `"xoxb-123-456..."` |
| `channels` | Channel name → Slack channel id. Every group channel you want mirrored. | `"general": "C012..."` |
| `agents` | Name → identity. `token` present = real-bot-user tier (post with that token); absent = persona tier (post with the app token under the agent's name). `icon` is the persona avatar emoji. | `"bob": { "icon": ":hammer_and_wrench:" }` |
| `dmChannels` | Slack DM conversation id → agent. Only the **real-bot-user** tier's agent can have an inbound DM; map its DM id to the agent. | `"D012...": "alice"` |
| `roster` | Slack user id → human/agent name, used to normalize `<@U…>` mentions to `@name` and to label inbound messages. | `"U0123456789": "ana"` |
| `dmMirrorChannel` | Read-only channel where agent↔agent DMs are mirrored (`[a↔b] prefix`). | `"#scramble-dms"` |

## Private channels

A private channel works exactly like a public one on scramble's side: add it to
`channels` as `channel name -> Slack channel id`. The bridge routes on the channel id, not
on the channel's type (proved by the private-channel tests in
`test/slack.test.ts`).

Slack is the part that differs, so two operational notes:

- **The scope and event are already in the manifest** (`groups:history` and
  `message.groups` alongside the public pair), so a FRESH install needs nothing
  extra. An app you installed BEFORE those were added must be updated and then
  **reinstalled**, because a new scope takes effect only on reinstall. Without it a
  private channel the bot sits in is simply silent, with no error anywhere.
- **A member must invite the bot from inside the channel**: open the private
  channel and `/invite @scramble`. An app cannot add itself to a private
  conversation.

To get a private channel's id: open the channel in a browser and take the `C…`
(or `G…`) id from the URL, or use the channel's **View channel details** →
bottom of the About tab.

## Identity-tier summary

- **Persona tier** (an agent with **no** `token` under `agents`): the single app
  posts under the agent's display name + `icon_emoji`. No @-mention
  autocomplete, no presence, no DMs.
- **Real bot-user tier** (an agent with a per-agent `agent.token`): the bridge
  posts with that agent's own bot token, so it is a genuine Slack user.
  Only this tier can receive **DMs** (`im:history` + `message.im` from the
  manifest). Give the per-agent app the `im:*` scopes it needs to DM.

**A persona is not a user entity**; Slack has nothing to open a DM with, so
DMing a persona-tier agent is impossible. To take a DM from a human, the agent
must be a real bot user.