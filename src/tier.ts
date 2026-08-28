// `src/tier.ts` determines the register that a channel calls for, as configured by
// the operator.
//
// Agents communicate differently in an `external` channel where many humans are
// present compared to an `internal` channel where agents communicate frequently.
// This mirrors human teams speaking inside an internal team room compared to
// speaking with cross-functional stakeholders or management. Whether a channel
// is private or public does not determine whether it is `external` or `internal`.
//
// The operator classifies channels manually in the configuration, so automated
// derivation from human and agent membership counts is removed. A channel that
// lacks a classification receives the careful register and a line stating that it
// is unclassified.

/**
 *  A channel specifies which register it requires.
 */
export type Tier = "internal" | "external";

/**
 *  If a channel name starts with `scramble`, then the default rule defines it as an
 *  internal channel. Agents build this tool in these channels, and the agents
 *  building the tool read them.
 */
export const INTERNAL_PREFIX = "scramble";

/**
 *  The tier for one channel, and why.
 *
 *  The system treats an unclassified channel as external. A careful register costs
 *  a reader nothing, and a dense register costs them the message, so the system
 *  defaults to an audience of people while the operator has not set a tier.
 */
export function tierFor(channel: string, configured: Record<string, string> | undefined): { tier: Tier; why: string } {
  const set = configured?.[channel];
  if (set === "internal" || set === "external") {
    return { tier: set, why: `set to ${set} by the operator` };
  }
  // For one family of channels, the channel name determines its answer under the
  // operator's standing rule. A configuration entry still takes precedence, so an
  // operator can move a `scramble` channel that fills with people to the careful
  // register with a single command.
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

/**
 *  The check reports channels with no answer at all, so `doctor` can name what is
 *  waiting on the operator. The check leaves out a channel the default rule
 *  answers. The channel has a tier, and listing it would ask for a decision already
 *  made.
 */
export function unclassified(channels: string[], configured: Record<string, string> | undefined): string[] {
  return channels
    .filter((c) => {
      const set = configured?.[c];
      return set !== "internal" && set !== "external" && !c.startsWith(INTERNAL_PREFIX);
    })
    .sort();
}

