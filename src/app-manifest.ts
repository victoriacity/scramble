/**
 *  A single source defines what a scramble agent's Slack application must
 *  declare, and two readers import it: `scripts/onboard-agent.ts` builds the
 *  manifest from it, and `doctor` compares a live application against it.
 *
 *  A single list exists because two lists existed previously. The required scopes
 *  lived in this file as `REQUIRED_SCOPES` and appeared again in the onboarding
 *  script under a comment stating that the duplication was deliberate so that
 *  `doctor` would compare the two and report any drift. That comparison was never
 *  written, and the two lists had already diverged: the script requested
 *  `reactions:write` and `reactions:read` while this copy omitted them, so an
 *  agent could react and `doctor` would not have noticed if the agent could not.
 *  The events had no second copy at all, which caused a worse issue because
 *  `doctor` could not check a subscription it did not know about. When the
 *  script added `member_joined_channel`, every application created before that
 *  change remained subscribed to three events, so invites silently delivered
 *  nothing and the inbox did not fire.
 */

/**
 *  Pair each scope with the capability that needs it. The reason travels with the
 *  name, so `--print-manifest` and every later reader get the purpose along with
 *  the name.
 */
export const SCOPES: Array<[string, string]> = [
  ["chat:write", "post a message, a threaded reply, and the living status message"],
  ["channels:history", "read a public channel"],
  ["groups:history", "read a private channel"],
  ["im:history", "read a DM"],
  [
    "im:read",
    "FIND your own DM conversation. Without it conversations.list types=im answers missing_scope, so a human's DM exists and the agent cannot locate it",
  ],
  ["im:write", "open and write a DM, so a human can talk to this agent alone"],
  ["users:read", "resolve <@U…> to a name; without it a mention matches no agent"],
  ["channels:read", "name a channel by its id, and find a public channel by name"],
  [
    "groups:read",
    "FIND a private channel you were invited to. groups:history reads one you already know; without groups:read an agent cannot discover its own channel id and needs the Slack CLI credential to look it up",
  ],
  ["files:write", "upload an attachment"],
  ["files:read", "download an inbound attachment"],
  [
    "reactions:write",
    "react to a message with an emoji, which is how a channel acknowledges without adding a line",
  ],
  [
    "reactions:read",
    "see which reactions a message already carries, so a reply does not repeat what a reaction already said",
  ],
  ["assistant:write", "the automatic working status on an assistant thread"],
];

/**
 *  Each event is listed with what stops arriving without it. The system does not
 *  deliver an event that the application does not subscribe to, and nothing
 *  reports that. The socket opens, says hello, and stays quiet, which is
 *  indistinguishable from a channel where nobody is talking.
 */
/**
 *  The two lists require different operational effort to change, and this
 *  difference determines how an operator rolls out a manifest update.
 *
 *  Adding a scope requires `developerInstall`. The call returns a new bot token
 *  and invalidates the token in every configuration, so a scope change requires
 *  a token rotation across every agent.
 *
 *  Adding an event requires only a manifest write. An end-to-end measurement on
 *  a live application confirmed this process: running `apps.manifest.update` with
 *  `reaction_added` added required no `developerInstall` call, retained the bot
 *  token sha256 `c34fc7458ffc` before and after, returned ok on `auth.test` using
 *  the same token, and delivered `doctor --wake` afterward. Everything continues
 *  running throughout the change.
 *
 *  That measurement does not determine whether the application receives frames for
 *  a newly subscribed event. The `toDelivery` function returns values only for
 *  `message` and `app_mention` types, so a subscription that this list does not
 *  serve remains inert, and its delivery remains unproven until a component reads
 *  it.
 */
export const BOT_EVENTS: Array<[string, string]> = [
  ["message.channels", "a message in a public channel"],
  ["message.groups", "a message in a private channel"],
  ["message.im", "a DM"],
  [
    "member_joined_channel",
    "being ADDED to a channel. An invite is news, and without this event an agent learns it was added only by overhearing later traffic",
  ],
];

export const SCOPE_NAMES = SCOPES.map(([s]) => s);
export const BOT_EVENT_NAMES = BOT_EVENTS.map(([e]) => e);

