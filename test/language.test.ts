import { describe, expect, test } from "bun:test";
import { lintLanguage, languageRefusal, proseOf, LANGUAGE_RULES } from "../src/language";

describe("the language rules, checked where the message leaves", () => {
  test("THE MESSAGE THAT GOT THROUGH: a long dash is refused", () => {
    // The incident, 2026-08-22. The rule existed and the check was a separate
    // script the sender had to run first; I piped text straight into
    // `message send` all day, so it ran on nothing, and the operator read this
    // shape in a message and told me the linting had failed.
    const hits = lintLanguage("Both are landed in the closing gate — controlled on six transcripts.");
    expect(hits).toEqual([{ label: "em dash", match: "—" }]);
    expect(languageRefusal(hits)).toContain("message send REFUSED: 1 language-rule hit(s)");
    expect(languageRefusal(hits)).toContain("[em dash]");
  });

  test("clean prose is clean, and produces no refusal", () => {
    const hits = lintLanguage("The app subscribed to three events and not to the fourth, so Slack sent nothing.");
    expect(hits).toEqual([]);
    expect(languageRefusal(hits)).toBe("");
  });

  test("every rule fires on its own shape", () => {
    const cases: Array<[string, string]> = [
      ["filler", "This is basically the same defect."],
      ["announcing candor", "One thing I should say plainly: it went out unchecked."],
      ["hedge", "That said, the socket stayed open."],
      ["minimizing really-just", "It really just needs the team id."],
      ["minimization of work", "A quick fix for the lookup."],
      ["em dash", "One thing — another thing."],
      ["en dash", "One thing – another thing."],
      ["'layer' as a name", "Add a validation layer above it."],
      ["adverb parked between commas", "The read, obviously, returned nothing."],
      ["contrast tail at sentence end", "Slack answered with a refusal, not a miss."],
      ["redundant closer / meta-commentary", "In short, the invite delivered nothing."],
    ];
    // Every rule in the list has a case here, so a rule added without one fails
    // this test rather than shipping unexercised.
    expect(cases.map(([label]) => label).sort()).toEqual(LANGUAGE_RULES.map((r) => r.label).sort());
    for (const [label, text] of cases) {
      expect(lintLanguage(text).map((h) => h.label)).toContain(label);
    }
  });

  test("THE PHRASE THAT GOT THROUGH: the ban is the class, not two written-down phrasings", () => {
    // 2026-08-22, the operator reading a message I had sent: "One thing I should
    // say plainly" is not acceptable language. The rule named "stated plainly"
    // and "plainly put" and nothing else, so a third phrasing of the same
    // preamble passed a check that existed precisely to stop it.
    for (const said of [
      "One thing I should say plainly: it went out unchecked.",
      "To put it plainly, the lint never ran.",
      "Plainly put, the lint never ran.",
      "Let me be clear about what happened.",
      "I must admit the check was skipped.",
    ]) {
      expect(lintLanguage(said).length).toBeGreaterThan(0);
    }
    // THIRD PERSON IS NOT SPARED. I argued it should be, on the grounds that a
    // document stating something plainly is a fact about the document rather
    // than a preamble about the speaker. The operator refused the exemption:
    // "Third person should not be allowed either." The word is banned outright,
    // so there is no verb list to fall outside of.
    expect(lintLanguage("The manifest says plainly which events it subscribes to.").length).toBeGreaterThan(0);
    expect(lintLanguage("The error names the field plainly enough to act on.").length).toBeGreaterThan(0);
    // And the sentence those wanted to be says the same thing without the word.
    expect(lintLanguage("The manifest names every event it subscribes to.")).toEqual([]);
    expect(lintLanguage("The error names the field, which is enough to act on.")).toEqual([]);
  });

  test("someone else's words in backticks are DATA, not this agent's prose", () => {
    // The only exemption, and the reason it must exist: reporting what another
    // person wrote has to carry their words unchanged, and this repo's own rule
    // list names the tokens it bans.
    expect(lintLanguage("The operator wrote `you sent a long dash — fix it`.")).toEqual([]);
    expect(lintLanguage("```\nhonestly, basically, — \n```\nNothing above is mine.")).toEqual([]);
    // ...and the exemption does not swallow the rest of the line.
    expect(lintLanguage("They said `honestly` and then I wrote basically.").map((h) => h.match)).toEqual(["basically"]);
  });

  test("blanking a quote keeps every other offset, so line numbers stay true", () => {
    const text = "one `x` two\nthree";
    expect(proseOf(text)).toBe("one     two\nthree");
    expect(proseOf(text).length).toBe(text.length);
    expect(proseOf("```\na\nb\n```\nafter").split("\n").length).toBe(5);
  });

  test("a second message in one process is scanned from its own start", () => {
    // A shared /g literal carries lastIndex between calls, so message two would
    // be scanned from wherever message one stopped and the hit near its start
    // would be missed. Same rule, two calls, both must report.
    const one = "basically the first message, and basically again later in it";
    expect(lintLanguage(one).length).toBe(2);
    expect(lintLanguage("basically the second").map((h) => h.match)).toEqual(["basically"]);
  });

  test("the refusal names every hit rather than the first", () => {
    const hits = lintLanguage("Honestly — that said, a quick fix.");
    expect(hits.length).toBeGreaterThan(2);
    const said = languageRefusal(hits);
    for (const h of hits) expect(said).toContain(h.label);
    expect(said).toContain(`${hits.length} language-rule hit(s)`);
  });
});
