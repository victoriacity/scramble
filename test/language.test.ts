import { describe, expect, test } from "bun:test";
import { LANGUAGE_RULES, WORD_LIMIT, attributionRefusal, languageRefusal, lengthRefusal, lintLanguage, proseOf, unownedAttributions, wordCount } from "../src/language";

describe("the language rules, checked where the message leaves", () => {
  test("THE MESSAGE THAT GOT THROUGH: a long dash is refused", () => {
    // During the incident, the rule existed, and the check was a separate script that
    // the sender had to run first. The sender piped text straight into `message send`
    // all day, so the check ran on nothing. The operator read this shape in a message
    // and reported that the linting had failed.
    const hits = lintLanguage("Both are landed in the closing gate — controlled on six transcripts.");
    // Two hits appear, and the second was added hours later. The sentence also says
    // `landed`, which means committing.
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
      ["deferring a decision the writer owns", "The floor is yours to call."],
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
    // This test includes a case for every rule in the list, so any rule added
    // without one fails the test and never ships unexercised.
    expect(cases.map(([label]) => label).sort()).toEqual(LANGUAGE_RULES.map((r) => r.label).sort());
    for (const [label, text] of cases) {
      expect(lintLanguage(text).map((h) => h.label)).toContain(label);
    }
  });

  test("THE PHRASE THAT GOT THROUGH: the ban is the class, not two written-down phrasings", () => {
    // The opening phrase `One thing I should say plainly` is unacceptable language.
    // The rule matched only `stated plainly` and `plainly put`, so a third phrasing
    // of the preamble passed the check built to stop it.
    for (const said of [
      "One thing I should say plainly: it went out unchecked.",
      "To put it plainly, the lint never ran.",
      "Plainly put, the lint never ran.",
      "Let me be clear about what happened.",
      "I must admit the check was skipped.",
    ]) {
      expect(lintLanguage(said).length).toBeGreaterThan(0);
    }
    // Third-person phrasing receives no exemption from the rule. A document
    // describing itself that way states a fact about the document with no speaker
    // making a preamble, but the rule disallows third person. The restriction bans
    // the word outright, so there is no verb list to fall outside of.
    expect(lintLanguage("The manifest says plainly which events it subscribes to.").length).toBeGreaterThan(0);
    expect(lintLanguage("The error names the field plainly enough to act on.").length).toBeGreaterThan(0);
    // The sentence expresses the same meaning without the word.
    expect(lintLanguage("The manifest names every event it subscribes to.")).toEqual([]);
    expect(lintLanguage("The error names the field, which is enough to act on.")).toEqual([]);
  });

  test("THE LINE THE ROOM COULD NOT READ: internal shorthand is refused", () => {
    // A channel consists of people who do not share the author's terminal, and a
    // status line built from local shorthand tells them nothing. The rows below are
    // the shapes this rule refuses.
    for (const said of [
      "Gate green at 457, six live stages pass.",
      "gate red, looking now",
      "All 6 stages passed against the real workspace.",
      "smoke green, landing it",
    ]) {
      expect(lintLanguage(said).length).toBeGreaterThan(0);
    }
    // This text clarifies the meaning of those sentences so that readers outside
    // the original terminal can act on them.
    expect(lintLanguage("The test suite passes, and so do the checks that talk to the real workspace.")).toEqual([]);
    expect(lintLanguage("457 tests pass, including the ones that send a real message.")).toEqual([]);
  });

  test("COINED JARGON for committing, and the compounds that are English", () => {
    // The coined verb means committing a change through `scripts/land.sh`, and it
    // means nothing outside this session. Ensure that a page a reader arrives on
    // appears only in
    // proper places.
    for (const said of [
      "Landed a44ac75.",
      "Both skills corrected and landed.",
      "I will land this after the tests pass.",
      "Landing the fix now.",
    ]) {
      expect(lintLanguage(said).map((h) => h.label)).toContain("coined jargon: 'land' for committing");
    }
    // The compound that follows spares the ordinary English senses.
    expect(lintLanguage("The landing page is ready for review.")).toEqual([]);
    expect(lintLanguage("Check the landing pages before the launch.")).toEqual([]);
    // Letters contained inside another word do not constitute the word.
    expect(lintLanguage("England and Iceland are unaffected.")).toEqual([]);
    expect(lintLanguage("The island survey is unrelated.")).toEqual([]);
    // State the replacement phrasing.
    expect(lintLanguage("Committed a44ac75 and pushed it.")).toEqual([]);
  });

  test("someone else's words in backticks are DATA, not this agent's prose", () => {
    // The only exemption exists because reporting what another person wrote must
    // carry their words unchanged, and this repository's own rule list names the
    // tokens it bans.
    expect(lintLanguage("The operator wrote `you sent a long dash — fix it`.")).toEqual([]);
    expect(lintLanguage("```\nhonestly, basically, — \n```\nNothing above is mine.")).toEqual([]);
    // The exemption does not consume the remainder of the line.
    expect(lintLanguage("They said `honestly` and then I wrote basically.").map((h) => h.match)).toEqual(["basically"]);
  });

  test("blanking a quote keeps every other offset, so line numbers stay true", () => {
    const text = "one `x` two\nthree";
    expect(proseOf(text)).toBe("one     two\nthree");
    expect(proseOf(text).length).toBe(text.length);
    expect(proseOf("```\na\nb\n```\nafter").split("\n").length).toBe(5);
  });

  test("a second message in one process is scanned from its own start", () => {
    // A shared `/g` regular expression literal preserves `lastIndex` across calls, so
    // the engine scans a second message from where the first message stopped and
    // misses a match near its start. When the same rule evaluates two calls, both
    // calls must report.
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
    // A rule written as a bare word matched four lines across three files, where
    // every line was an instruction not to restate. A rule written as a bare word
    // matches prose about the rule, which is the trap removed from the wake filter.
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
  // The system must enforce a message length limit in words, maybe 200 words,
  // because readers do not care about the way an answer is reached unless they
  // explicitly ask for it.

  test("a message within the limit passes", () => {
    expect(lengthRefusal("a short answer")).toBe("");
    expect(lengthRefusal(Array.from({ length: WORD_LIMIT }, () => "word").join(" "))).toBe("");
  });

  test("one word over is refused, with the count and the limit", () => {
    const said = lengthRefusal(Array.from({ length: WORD_LIMIT + 1 }, () => "word").join(" "));
    expect(said).toContain(`${WORD_LIMIT + 1} words of prose, and the limit is ${WORD_LIMIT}`);
    expect(said).toContain("Send the answer alone");
    // Every refusal specifies the skill. A skill that an agent must remember to open
    // functions as advice. This notification arrives at the moment someone is writing
    // and makes an error.
    expect(said).toContain("the `communication` skill");
  });

  test("code and backtick spans cost nothing", () => {
    // Charging for evidence would encourage a sender to paraphrase information it
    // could have displayed directly, which contradicts the purpose of the limit.
    const code = ["```", Array.from({ length: 500 }, () => "line").join("\n"), "```"].join("\n");
    expect(lengthRefusal(`here is the measurement:\n${code}`)).toBe("");
    expect(wordCount("see `a b c d e f g h` there")).toBe(2);
  });

  test("a language with no spaces counts by character", () => {
    // A space-splitting counter reads a 300-character Chinese message as one word,
    // and the operator requested support in both languages.
    //
    // Escape sequences represent the characters so this file stays English, which the
    // gate enforces on every tracked file. The characters are the subject of the test,
    // and a literal here would create the one case where the rule and the test
    // disagree.
    const cjk = "\u8fd9\u6761\u6d88\u606f\u5f88\u957f"; // six Han characters
    expect(wordCount(cjk)).toBe(6);
    expect(lengthRefusal("\u5b57".repeat(WORD_LIMIT + 1))).toContain(`${WORD_LIMIT + 1} words of prose`);
  });

  test("punctuation and blank runs are not words", () => {
    expect(wordCount("  ...  ---  ")).toBe(0);
    expect(wordCount("two words")).toBe(2);
  });
});


describe("a decision inside your own code", () => {
  // AN AGENT READ A THRESHOLD IN ITS OWN REPOSITORY, found the number had no
  // measurement under it, found that it refused the work the tool exists to do,
  // named the replacement, and closed with a phrase handing the choice back. The
  // operator answered that the agent is the sole developer of the codebase, and
  // then spent two messages doing the deciding.
  test("the reflex deferrals are refused, and naming what somebody else owns is not", () => {
    for (const said of [
      "The measure for that is per-sentence coverage. I have not built it, and it is yours to call.",
      "Your call on the threshold.",
      "Switching the page into that mode is up to you.",
      "The floor is for you to decide.",
      "I can wire the mode in if you want it.",
      "Say the word and I will wire that up.",
    ]) {
      const hits = lintLanguage(said);
      expect(hits.map((h) => h.label)).toContain("deferring a decision the writer owns");
    }

    // A decision that belongs to a person names the thing they own. These sentences
    // carry no reflex phrase and pass.
    for (const said of [
      "The hostname and the certificate need your word, since the DNS is yours.",
      "The visibility flip on that repository needs the account that owns it.",
      "I set the floor at a quarter, and the measurement is in the commit.",
    ]) {
      expect(lintLanguage(said).map((h) => h.label)).not.toContain("deferring a decision the writer owns");
    }
  });
});

describe("whose fact is it: a claim about one reader in a room of several", () => {
  // TWICE IN TWO DAYS. A message greeting three agents said "your 118-draft scan"
  // when the scan belonged to one of them and another had scanned 26 files; the day
  // before, a message to two agents wrote "you counted eleven" for a number one of
  // them owned, and the other published a correction of a claim they never made.
  test("a possessive claim with no owner is refused, and the room's own `you` is not", () => {
    const room = "@reader-one @reader-two @reader-three";
    const unowned = `${room} Three of you hit the same wall.\n\nOn the file mode you measured, the ledger now writes 0600.`;
    const hits = unownedAttributions(unowned);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("On the file mode you measured");
    const said = attributionRefusal(hits, unowned);
    expect(said).toContain("1 paragraph(s) say \"you\" to 3 agents");
    expect(said).toContain("@reader-two");
    expect(said).toContain("the ts of the message the fact came from");

    // THE ROOM'S OWN SENTENCE IS LEFT ALONE. A rule that refused the greeting of
    // every message written to several agents would teach everybody to work around
    // the check.
    expect(unownedAttributions(`${room} Three of you hit the same wall.`)).toEqual([]);
    expect(unownedAttributions("@a @b The rows behind you hold verdicts alone.")).toEqual([]);
  });

  test("one handle, every handle, or a ts names the owner", () => {
    expect(unownedAttributions("@a @b @reader-two your 118-draft scan found nothing.")).toEqual([]);
    // Naming every agent the message addresses is a claim about the room.
    expect(unownedAttributions("@a @b\n\n@a @b you both ran the scan.")).toEqual([]);
    // A ts is stronger than a handle: the send reads it back from Slack and prints
    // who wrote it, so the attribution is checked against the record.
    expect(unownedAttributions("@a @b The scan at 1787967819.574939 is why your premise holds.")).toEqual([]);
    // One addressee owns every sentence in the message.
    expect(unownedAttributions("@reader-two your replay discriminates.")).toEqual([]);
    // Backticks and fences are exempt here as everywhere.
    expect(unownedAttributions("@a @b The code reads `your scan ran` and nothing else.")).toEqual([]);
    expect(attributionRefusal([], "@a @b anything")).toBe("");
  });
});
