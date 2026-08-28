// src/tier.ts: WHICH REGISTER A CHANNEL CALLS FOR, set by the operator.
//
// The operator: "Agents shall communicate very differently in an `external`
// channel where there are lots of humans from an `internal` channel where
// agents frequently communicate. This is similar to human teams speaking inside
// the team's internal channel/room versus speaking to cross functional
// stakeholders or management. Also such external and internal cannot be
// determined by whether a channel is private or public."
//
// I built this from the membership first, counting people against agents. The
// operator ruled that out the same hour: "Channel classification should be
// manually done by the operator." So the config carries the answer, the
// derivation is gone, and a channel nobody has classified gets the careful
// register with a line saying it is unclassified.

/** Which register a channel calls for. */
export type Tier = "internal" | "external";

/** The name prefix the operator gave a standing answer for: "set a default
 *  channel rule: if a channel starts with `scramble` then it is an internal
 *  channel". These are the channels where this tool is built and where the
 *  readers are the agents building it. */
export const INTERNAL_PREFIX = "scramble";

/** The tier for one channel, and why.
 *
 *  AN UNCLASSIFIED CHANNEL READS AS EXTERNAL. The careful register costs a
 *  reader nothing, and the dense one costs them the message, so the guess that
 *  errs toward people is the one to make while the operator has not spoken. */
export function tierFor(channel: string, configured: Record<string, string> | undefined): { tier: Tier; why: string } {
  const set = configured?.[channel];
  if (set === "internal" || set === "external") {
    return { tier: set, why: `set to ${set} by the operator` };
  }
  // THE NAME CARRIES THE ANSWER for one family of channels, by the operator's
  // standing rule. An entry in the config still wins, so a `scramble` channel
  // that fills with people is one command away from the careful register.
  if (channel.startsWith(INTERNAL_PREFIX)) {
    return {
      tier: "internal",
      why: `${channel} starts with ${INTERNAL_PREFIX}, which the operator set as internal by default`,
    };
  }
  return {
    tier: "external",
    why: `no tier set for ${channel}, so the careful register applies: scramble channel tier ${channel} internal|external`,
  };
}

/** Channels with no answer at all, so `doctor` can name what is waiting on the
 *  operator. A channel the default rule answers is left out: it has a tier, and
 *  listing it would ask for a decision already made. */
export function unclassified(channels: string[], configured: Record<string, string> | undefined): string[] {
  return channels
    .filter((c) => {
      const set = configured?.[c];
      return set !== "internal" && set !== "external" && !c.startsWith(INTERNAL_PREFIX);
    })
    .sort();
}
