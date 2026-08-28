import { describe, expect, test } from "bun:test";
import { tierFor, unclassified } from "../src/tier";

describe("which register a channel calls for", () => {
  test("the operator's entry decides it", () => {
    // The operator should manually classify channels. The previous implementation
    // built classification from membership, counting people against agents.
    expect(tierFor("team", { team: "internal" })).toEqual({ tier: "internal", why: "set to internal by the operator" });
    expect(tierFor("team", { team: "external" })).toEqual({ tier: "external", why: "set to external by the operator" });
  });

  test("A NAME STARTING WITH scramble IS INTERNAL, by the operator's standing rule", () => {
    // The default rule states that if a channel starts with `scramble`, then it is
    // an internal channel. These are the channels where this tool is built and where
    // the readers are the agents building it.
    for (const name of ["scramble", "scramble-dev", "scramble-applied-research", "scrambleXYZ"]) {
      const decided = tierFor(name, undefined);
      expect(decided.tier).toBe("internal");
      expect(decided.why).toContain("the operator set as internal by default");
    }
    // The rule applies as a prefix, so the system leaves a name untouched if the
    // name merely contains the word.
    expect(tierFor("team-scramble", undefined).tier).toBe("external");
    // An entry still takes precedence, so an operator can switch a scramble channel
    // that fills with people to the careful register with a single command.
    expect(tierFor("scramble-dev", { "scramble-dev": "external" })).toEqual({
      tier: "external",
      why: "set to external by the operator",
    });
    // The doctor tool stops asking for a decision the rule already makes.
    expect(unclassified(["scramble-dev", "team", "scramble"], undefined)).toEqual(["team"]);
  });

  test("an unclassified channel gets the careful register and the command to set one", () => {
    // A careful register costs the reader nothing. Dense prose costs the reader the
    // message.
    const decided = tierFor("team", { other: "internal" });
    expect(decided.tier).toBe("external");
    expect(decided.why).toContain("no tier set for team");
    expect(decided.why).toContain("scramble channel tier team internal|external");
    // A value that specifies no tier provides no classification.
    expect(tierFor("team", { team: "loud" }).tier).toBe("external");
    expect(tierFor("team", undefined).tier).toBe("external");
  });

  test("unclassified names what is waiting on the operator, sorted", () => {
    expect(unclassified(["team", "dev", "ops"], { dev: "internal" })).toEqual(["ops", "team"]);
    expect(unclassified(["dev"], { dev: "external" })).toEqual([]);
    expect(unclassified([], undefined)).toEqual([]);
  });
});

