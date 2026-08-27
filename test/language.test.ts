import { describe, expect, test } from "bun:test";
import { LANGUAGE_RULES, WORD_LIMIT, languageRefusal, lengthRefusal, lintLanguage, proseOf, wordCount } from "../src/language";

describe("the language rules, checked where the message leaves", () => {
  test("THE MESSAGE THAT GOT THROUGH: a long dash is refused", () => {
    // The incident. The rule existed and the check was a separate script the
    // sender had to run first; I piped text straight into `message send` all
    // day, so it ran on nothing, and the operator read this shape in a message
    // and told me the linting had failed.
    const hits = lintLanguage("Both are landed in the closing gate — controlled on six transcripts.");
    // Two hits, and the second was added hours later: the sentence also says
    // "landed", which was my private word for committing until the operator
    // asked what it meant.
    expect(hits).toEqual([
      { label: "coined jargon: 'land' for committing", match: "landed", index: 9 },
      { label: "em dash", match: "—", index: 36 },
    ]);
    expect(languageRefusal(hits)).toContain("message send REFUSED: 2 language rule(s) broken");
    expect(languageRefusal(hits)).toContain("[em dash]");
    expect(languageRefusal(hits)).toContain("the `communication` skill");
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
      ["internal shorthand nobody outside can read", "Gate green at 457, six live stages pass."],
      ["coined jargon: 'land' for committing", "Landed a44ac75 and pushed it."],
      ["human-team vocabulary (agents are not staff)", "The staffing for this migration is thin."],
      ["em dash", "One thing — another thing."],
      ["en dash", "One thing – another thing."],
      ["adverb parked between commas", "The read, obviously, returned nothing."],
      ["antithesis (A not B / A rather than B)", "It is per turn, not per item."],
      ["contrast tail at sentence end", "The walk was a hundred times the size, worse than useless."],
      ["redundant closer / meta-commentary", "In short, the invite delivered nothing."],
      ["announcement scaffolding", "The measurement, restated in one sentence: we compared rolls."],
    ];
    // Every rule in the list has a case here, so a rule added without one fails
    // this test rather than shipping unexercised.
    expect(cases.map(([label]) => label).sort()).toEqual(LANGUAGE_RULES.map((r) => r.label).sort());
    for (const [label, text] of cases) {
      expect(lintLanguage(text).map((h) => h.label)).toContain(label);
    }
  });

  test("THE PHRASE THAT GOT THROUGH: the ban is the class, not two written-down phrasings", () => {
    // , the operator reading a message I had sent: "One thing I should say
    // plainly" is not acceptable language. The rule named "stated plainly" and
    // "plainly put" and nothing else, so a third phrasing of the same preamble
    // passed a check that existed precisely to stop it.
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

  test("THE LINE THE ROOM COULD NOT READ: internal shorthand is refused", () => {
    // Operator, on a message of mine: "Nobody else ever understands 'Gate green
    // at 457, six live stages pass.'" A channel is a room of people who do not
    // share my terminal.
    for (const said of [
      "Gate green at 457, six live stages pass.",
      "gate red, looking now",
      "All 6 stages passed against the real workspace.",
      "smoke green, landing it",
    ]) {
      expect(lintLanguage(said).length).toBeGreaterThan(0);
    }
    // What those sentences were trying to say, which a reader outside my
    // terminal can act on.
    expect(lintLanguage("The test suite passes, and so do the checks that talk to the real workspace.")).toEqual([]);
    expect(lintLanguage("457 tests pass, including the ones that send a real message.")).toEqual([]);
  });

  test("COINED JARGON: 'landing' for committing, and the compounds that are English", () => {
    // Operator: "What is 'landing'? How can we ensure that it is only used at
    // proper places as 'landing page'?" It was my word for committing a change
    // through scripts/land.sh, and it means nothing outside this session.
    for (const said of [
      "Landed a44ac75.",
      "Both skills corrected and landed.",
      "I will land this after the tests pass.",
      "Landing the fix now.",
    ]) {
      expect(lintLanguage(said).map((h) => h.label)).toContain("coined jargon: 'land' for committing");
    }
    // The ordinary English senses, spared by the compound that follows.
    expect(lintLanguage("The landing page is ready for review.")).toEqual([]);
    expect(lintLanguage("Check the landing pages before the launch.")).toEqual([]);
    // And the letters inside another word are not the word.
    expect(lintLanguage("England and Iceland are unaffected.")).toEqual([]);
    expect(lintLanguage("The island survey is unrelated.")).toEqual([]);
    // What to say in its place.
    expect(lintLanguage("Committed a44ac75 and pushed it.")).toEqual([]);
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
    expect(said).toContain(`${hits.length} language rule(s) broken`);
  });
});

describe("announcement scaffolding", () => {
  test("a phrase announcing the FORM of what follows is refused", () => {
    for (const bad of [
      "The measurement, restated in one sentence: it works.",
      "Let me restate the finding.",
      "In other words, the socket was dead.",
      "Worth noting that the count was wrong.",
      "To put it simply, nothing arrived.",
    ]) {
      expect(lintLanguage(bad).map((h) => h.label)).toContain("announcement scaffolding");
    }
  });

  test("the bare verb is NOT the rule, so prose about restating passes", () => {
    // Written as a bare word it matched four lines across three files, every
    // one of them an instruction NOT to restate. A rule written as a bare word
    // matches prose ABOUT the rule, which is the trap taken out of the wake
    // filter.
    for (const fine of [
      "Do not restate what the channel settled without you.",
      "Do not end a passage by restating it.",
      "If a crossing already made your point, do not restate it.",
    ]) {
      expect(lintLanguage(fine).map((h) => h.label)).not.toContain("announcement scaffolding");
    }
  });
});

describe("the word limit on one message", () => {
  // The operator: "We need to impose a message length limit in words. Maybe
  // 200", with the reason in the same instruction: "nobody cares about the way
  // you get your answer unless they explicitly ask for it."

  test("a message within the limit passes", () => {
    expect(lengthRefusal("a short answer")).toBe("");
    expect(lengthRefusal(Array.from({ length: WORD_LIMIT }, () => "word").join(" "))).toBe("");
  });

  test("one word over is refused, with the count and the limit", () => {
    const said = lengthRefusal(Array.from({ length: WORD_LIMIT + 1 }, () => "word").join(" "));
    expect(said).toContain(`${WORD_LIMIT + 1} words of prose, and the limit is ${WORD_LIMIT}`);
    expect(said).toContain("Send the answer alone");
    // EVERY REFUSAL NAMES THE SKILL. A skill an agent has to remember to open is
    // advice; this arrives at the moment someone is writing and got it wrong.
    expect(said).toContain("the `communication` skill");
  });

  test("code and backtick spans cost nothing", () => {
    // Charging for evidence would push a sender to paraphrase what it could
    // have shown, which is the opposite of what the limit is for.
    const code = ["```", Array.from({ length: 500 }, () => "line").join("\n"), "```"].join("\n");
    expect(lengthRefusal(`here is the measurement:\n${code}`)).toBe("");
    expect(wordCount("see `a b c d e f g h` there")).toBe(2);
  });

  test("a language with no spaces counts by character", () => {
    // A space-splitting count reads a 300-character Chinese message as one word,
    // and the operator asked for this in both languages.
    //
    // WRITTEN AS ESCAPES so this file stays English, which the gate enforces on
    // every tracked file. The characters are the subject of the test, and a
    // literal here would be the one case where the rule and the test disagree.
    const cjk = "\u8fd9\u6761\u6d88\u606f\u5f88\u957f"; // six Han characters
    expect(wordCount(cjk)).toBe(6);
    expect(lengthRefusal("\u5b57".repeat(WORD_LIMIT + 1))).toContain(`${WORD_LIMIT + 1} words of prose`);
  });

  test("punctuation and blank runs are not words", () => {
    expect(wordCount("  ...  ---  ")).toBe(0);
    expect(wordCount("two words")).toBe(2);
  });
});
