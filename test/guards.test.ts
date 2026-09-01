import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Every guard in this tool is listed in `src/guards.md` with who asked for it.
 *
 *  WHY THIS TEST EXISTS. The operator asked for one change to the rewriter and got
 *  that change plus a guard nobody had asked for, plus a fix to a second guard that
 *  the first one tripped. Their words: additional busywork created between agents,
 *  which slowed the feature down.
 *
 *  A guard refuses somebody's message, so the authority for it comes from a person
 *  who asked or an incident somebody measured. This test makes the writing-down step
 *  mandatory: a new rule or a new refusal fails the suite until its line exists. A
 *  line that cannot be written honestly is the signal that the guard was nobody's
 *  request.
 */
const src = (name: string): string => readFileSync(join(import.meta.dir, "..", "src", name), "utf8");

/** The rule labels, read from the table the linter runs. */
export function ruleLabels(text: string): string[] {
  return [...text.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** The first words of every refusal the rewrite guards can produce.
 *
 *  A refusal message is a template with expressions in it, so the key is the part
 *  before the first expression, which is stable while the numbers inside are not.
 */
export function refusalKeys(text: string): string[] {
  return [...text.matchAll(/refusal\(\s*\n?\s*`([^`$]{12,})/g)].map((m) => (m[1] ?? "").replace(/\s+/g, " ").trim());
}

describe("every guard names who asked for it", () => {
  const registry = src("guards.md");

  test("each language rule has a line in the registry", () => {
    const labels = ruleLabels(src("language.ts"));
    expect(labels.length).toBeGreaterThan(10);
    for (const label of labels) {
      // The label appears in the table with a requester beside it. A row with an
      // empty requester column fails the same way, since the split below needs text
      // on both sides.
      const row = registry.split("\n").find((l) => l.includes(`| ${label} |`));
      expect(row, `no line in src/guards.md for the language rule "${label}"`).toBeDefined();
      const who = (row ?? "").split("|")[2]?.trim() ?? "";
      expect(who.length, `the registry line for "${label}" names no requester`).toBeGreaterThan(8);
    }
  });

  test("each rewrite refusal has a line in the registry", () => {
    const keys = refusalKeys(src("rewrite.ts"));
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      // The registry states each guard in its own words, so the match is on the
      // opening words of the refusal, which is what a reader recognises.
      const opening = key.split(" ").slice(0, 5).join(" ").replace(/[,:.]$/, "");
      const row = registry.split("\n").find((l) => l.includes("|") && l.includes(opening));
      expect(row, `no line in src/guards.md for the refusal that starts "${opening}"`).toBeDefined();
      const who = (row ?? "").split("|")[2]?.trim() ?? "";
      expect(who.length, `the registry line for "${opening}" names no requester`).toBeGreaterThan(8);
    }
  });

  test("the registry says what to do when no requester can be named", () => {
    // The rule the whole file exists for. A reader who cannot fill the column has
    // found unrequested work.
    expect(registry).toContain("file it");
    expect(registry).toContain("who asked");
  });
});
