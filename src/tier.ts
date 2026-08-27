// src/tier.ts: WHO IS IN THE ROOM, and which register that calls for.
//
// The operator, 2026-08-27: "Agents shall communicate very differently in an
// `external` channel where there are lots of humans from an `internal` channel
// where agents frequently communicate. This is similar to human teams speaking
// inside the team's internal channel/room versus speaking to cross functional
// stakeholders or management. Also such external and internal cannot be
// determined by whether a channel is private or public."
//
// So the tier comes from the MEMBERSHIP, which is the thing the operator
// described: people, or agents. Slack marks every member as a bot or a person,
// so this is a read of a fact rather than a guess about a name.

/** Which register a channel calls for. */
export type Tier = "internal" | "external";

export interface Composition {
  humans: number;
  agents: number;
  /** Members whose kind this host could not read. Counted, never assumed. */
  unknown: number;
}

/** The register a composition calls for, with the reason.
 *
 *  HUMANS OUTNUMBERING AGENTS MAKES A ROOM EXTERNAL. One person among six
 *  agents is a team channel with its operator in it; eight people around one
 *  agent is a room where that agent is the guest.
 *
 *  A TIE READS AS EXTERNAL, since the careful register costs a reader nothing
 *  and the dense one costs them the message.
 *
 *  UNKNOWN MEMBERS COUNT TOWARD THE PEOPLE. A member this host cannot classify
 *  may be a person, and treating them as an agent is the mistake that puts
 *  internal shorthand in front of somebody who cannot read it. */
export function tierOf(c: Composition): { tier: Tier; why: string } {
  const people = c.humans + c.unknown;
  const tier: Tier = people >= c.agents ? "external" : "internal";
  const unknownNote = c.unknown === 0 ? "" : `, ${c.unknown} unread and counted as people`;
  return {
    tier,
    why: `${c.humans} human(s) and ${c.agents} agent(s)${unknownNote}`,
  };
}

/** The tier for one channel: a configured answer wins, and a composition
 *  answers when none is configured.
 *
 *  THE CONFIG WINS BECAUSE MEMBERSHIP IS A PROXY. A room can be full of agents
 *  and still be where a customer reads, and nobody can derive that. The
 *  override says which rooms those are, and the derivation covers the rest with
 *  no list to maintain. */
export function tierFor(
  channel: string,
  configured: Record<string, string> | undefined,
  composition: Composition | undefined,
): { tier: Tier; why: string } {
  const set = configured?.[channel];
  if (set === "internal" || set === "external") {
    return { tier: set, why: `set to ${set} in the config` };
  }
  if (composition === undefined) {
    return {
      tier: "external",
      why: "the membership could not be read, so the careful register applies",
    };
  }
  return tierOf(composition);
}
