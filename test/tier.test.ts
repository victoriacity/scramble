import { describe, expect, test } from "bun:test";
import { tierFor, unclassified } from "../src/tier";

describe("which register a channel calls for", () => {
  test("the operator's entry decides it", () => {
    // The operator: "Channel classification should be manually done by the
    // operator." I had built this from the membership, counting people against
    // agents, and the ruling came the same hour.
    expect(tierFor("team", { team: "internal" })).toEqual({ tier: "internal", why: "set to internal by the operator" });
    expect(tierFor("team", { team: "external" })).toEqual({ tier: "external", why: "set to external by the operator" });
  });

  test("A NAME STARTING WITH scramble IS INTERNAL, by the operator's standing rule", () => {
    // The operator: "set a default channel rule: if a channel starts with
    // `scramble` then it is an internal channel". These are the channels where
    // this tool is built and where the readers are the agents building it.
    for (const name of ["scramble", "scramble-dev", "scramble-applied-research", "scrambleXYZ"]) {
      const decided = tierFor(name, undefined);
      expect(decided.tier).toBe("internal");
      expect(decided.why).toContain("the operator set as internal by default");
    }
    // A name that merely CONTAINS the word is untouched: the rule is a prefix.
    expect(tierFor("team-scramble", undefined).tier).toBe("external");
    // AN ENTRY STILL WINS, so a scramble channel that fills with people is one
    // command away from the careful register.
    expect(tierFor("scramble-dev", { "scramble-dev": "external" })).toEqual({
      tier: "external",
      why: "set to external by the operator",
    });
    // And doctor stops asking for a decision the rule already makes.
    expect(unclassified(["scramble-dev", "team", "scramble"], undefined)).toEqual(["team"]);
  });

  test("an unclassified channel gets the careful register and the command to set one", () => {
    // The careful register costs a reader nothing. The dense one costs them the
    // message.
    const decided = tierFor("team", { other: "internal" });
    expect(decided.tier).toBe("external");
    expect(decided.why).toContain("no tier set for team");
    expect(decided.why).toContain("scramble channel tier team internal|external");
    // A value naming no tier is no classification.
    expect(tierFor("team", { team: "loud" }).tier).toBe("external");
    expect(tierFor("team", undefined).tier).toBe("external");
  });

  test("unclassified names what is waiting on the operator, sorted", () => {
    expect(unclassified(["team", "dev", "ops"], { dev: "internal" })).toEqual(["ops", "team"]);
    expect(unclassified(["dev"], { dev: "external" })).toEqual([]);
    expect(unclassified([], undefined)).toEqual([]);
  });
});
