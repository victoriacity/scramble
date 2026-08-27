import { describe, expect, test } from "bun:test";
import { tierFor, unclassified } from "../src/tier";

describe("which register a channel calls for", () => {
  test("the operator's entry decides it", () => {
    // The operator, 2026-08-27: "Channel classification should be manually done
    // by the operator." I had built this from the membership, counting people
    // against agents, and the ruling came the same hour.
    expect(tierFor("team", { team: "internal" })).toEqual({ tier: "internal", why: "set to internal by the operator" });
    expect(tierFor("team", { team: "external" })).toEqual({ tier: "external", why: "set to external by the operator" });
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
