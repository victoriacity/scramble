import { describe, expect, test } from "bun:test";
import { tierFor, tierOf } from "../src/tier";

describe("which register a channel calls for", () => {
  test("humans outnumbering agents makes a room external", () => {
    // The operator, 2026-08-27: an external channel has lots of humans in it,
    // an internal one is where agents talk, and neither follows from the
    // channel being public or private.
    expect(tierOf({ humans: 8, agents: 1, unknown: 0 }).tier).toBe("external");
    expect(tierOf({ humans: 1, agents: 6, unknown: 0 }).tier).toBe("internal");
  });

  test("a tie reads as external", () => {
    // The careful register costs a reader nothing. The dense one costs them the
    // message.
    expect(tierOf({ humans: 2, agents: 2, unknown: 0 }).tier).toBe("external");
  });

  test("a member this host cannot classify counts as a person", () => {
    // Putting internal shorthand in front of somebody who cannot read it is the
    // failure worth avoiding, so an unread member never tips a room to internal.
    const decided = tierOf({ humans: 0, agents: 3, unknown: 3 });
    expect(decided.tier).toBe("external");
    expect(decided.why).toContain("3 unread and counted as people");
    // And with nothing unread the sentence stays short.
    expect(tierOf({ humans: 1, agents: 6, unknown: 0 }).why).toBe("1 human(s) and 6 agent(s)");
  });

  test("a configured entry beats the membership, in both directions", () => {
    // A room full of agents can still be where a customer reads, and nothing
    // derives that.
    const crowd = { humans: 9, agents: 0, unknown: 0 };
    const agentsOnly = { humans: 0, agents: 9, unknown: 0 };
    expect(tierFor("team", { team: "internal" }, crowd)).toEqual({
      tier: "internal",
      why: "set to internal in the config",
    });
    expect(tierFor("bots", { bots: "external" }, agentsOnly)).toEqual({
      tier: "external",
      why: "set to external in the config",
    });
    // A value that names no tier is ignored, and the membership answers.
    expect(tierFor("team", { team: "loud" }, agentsOnly).tier).toBe("internal");
    expect(tierFor("team", undefined, agentsOnly).tier).toBe("internal");
  });

  test("an unreadable membership gives the careful register", () => {
    const decided = tierFor("team", undefined, undefined);
    expect(decided.tier).toBe("external");
    expect(decided.why).toContain("could not be read");
  });
});
