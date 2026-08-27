/** WHAT A SCRAMBLE AGENT'S SLACK APP MUST DECLARE. One source, imported by both
 *  readers: `scripts/onboard-agent.ts` builds the manifest from it, and `doctor`
 *  compares a live app against it.
 *
 * It is one list because it was two. The scopes lived here as `REQUIRED_SCOPES`
 * and again in the onboarding script, under a comment saying the duplication
 * was deliberate and that "`doctor` compares them so a drift between the two is
 * reported". That comparison was never written, and the two lists had already
 * diverged: the script asked for `reactions:write` and `reactions:read` and
 * this copy did not, so an agent could react and doctor would not have noticed
 * if it could not. The events had no second copy at all, which is worse: doctor
 * could not check a subscription it did not know about, and
 * `member_joined_channel` was added to the script while every app created
 * before it stayed subscribed to three events, silently, with an invite
 * delivering nothing (operator: "invited but inbox does not fire").
 */

/** Each scope with the capability that needs it. The reason travels with the
 *  name, so `--print-manifest` and every later reader get the why along with
 *  the what. */
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

/** Each event with what stops arriving without it. AN EVENT THE APP DOES NOT
 *  SUBSCRIBE TO IS NOT DELIVERED AND NOTHING REPORTS THAT: the socket opens, says
 *  hello, and stays quiet, which is indistinguishable from a channel where
 *  nobody is talking. */
/** THE TWO LISTS COST DIFFERENT AMOUNTS TO CHANGE, and the difference decides
 *  how a manifest change is rolled out.
 *
 *  Adding a SCOPE needs `developerInstall`, which returns a NEW bot token and
 *  leaves every config holding a dead one, so a scope change is a rotation
 *  across every agent.
 *
 * Adding an EVENT is a manifest write and nothing else. Measured end to end on
 * a live app: `apps.manifest.update` with `reaction_added` added, no
 * `developerInstall` call, bot token sha256 `c34fc7458ffc` before and after,
 * `auth.test` ok on the same token, and `doctor --wake` delivered afterwards.
 * Everything keeps running while you do it.
 *
 *  What that measurement does NOT cover: whether a frame for a newly subscribed
 *  event ARRIVES at all. `toDelivery` returns nothing for any type that is not
 *  `message` or `app_mention`, so a subscription this list does not serve is
 *  inert, and its delivery is unproven until something reads it. */
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
