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
  return {
    tier: "external",
    why: `no tier set for ${channel}, so the careful register applies: scramble channel tier ${channel} internal|external`,
  };
}

/** Channels this config has no tier for, so `doctor` can name what is waiting
 *  on the operator. */
export function unclassified(channels: string[], configured: Record<string, string> | undefined): string[] {
  return channels
    .filter((c) => {
      const set = configured?.[c];
      return set !== "internal" && set !== "external";
    })
    .sort();
}
