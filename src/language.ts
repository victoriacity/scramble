// THE LANGUAGE RULES, AND THE ONLY PLACE THEY LIVE.
//
// They are checked in `message send`, where the message leaves, and there is no
// separate linter to run first (operator, 2026-08-22: "for scramble there should
// not be a separate linter. Linter is part of send message").
//
// It used to be a chain the sender had to remember: write a draft file, run
// lint_language.py on it, send only if it passed. I piped text straight into
// `message send` all day, so the lint ran on nothing, and the operator read a
// long dash in a message and told me the linting had failed. It had not failed.
// It had not run. A step an agent has to remember is not a check.
//
// A quoted span is DATA. This file names the tokens it bans, and a message
// reporting what someone else wrote has to be able to carry their words.
// Fenced blocks and inline backticks are blanked before the scan, and that is the
// only exemption. There is no --no-lint flag: a flag that turns the check off
// makes it optional again, which is the defect this replaced.

export interface LanguageRule {
  label: string;
  rx: RegExp;
}

export interface LanguageHit {
  label: string;
  match: string;
  /** Character offset in the ORIGINAL text. Quoted spans are blanked in place,
   *  so every offset survives and a file report can name the line. */
  index: number;
}

/** 1-based line number for an offset. */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line += 1;
  return line;
}

/** Every rule, with the reason it exists where the reason is not obvious. */
export const LANGUAGE_RULES: LanguageRule[] = [
  {
    label: "filler",
    rx: /\b(honestly|honest|honesty|actually|basically|essentially|frankly|candidly|truthfully)\b|\bstated plainly\b|\bplainly put\b|\bto be (fair|blunt|clear)\b/gi,
  },
  // ANNOUNCING CANDOR: a preamble announcing that what follows is candid, which
  // the sentence itself does not need.
  //
  // THE WORD ITSELF IS THE RULE. Listing the verbs it attaches to was tried
  // twice and came up short twice. First two forms, `stated plainly` and
  // `plainly put`, which let through `One thing I should say plainly`. Then a
  // wider verb list sparing third person, on my argument that a DOCUMENT
  // describing itself that way states a fact about the document. The operator
  // refused that exemption: `Third person should not be allowed either.` So the
  // word is banned outright, the way the dashes are, and no verb list can come
  // up short again.
  {
    label: "announcing candor",
    rx: /\bplainly\b|\blet me be (clear|blunt|direct|plain)\b|\bI (should|must|have to|want to|will) (say|admit|confess|be clear)\b/gi,
  },
  {
    label: "hedge",
    rx: /\b(sort of|kind of|to be fair|to be clear|to be (direct|frank|blunt|honest|candid)|in all (honesty|fairness)|in (truth|fairness)|that said|with that said|having said that|caveat|caveats|the (honest|direct|real) truth)\b/gi,
  },
  { label: "minimizing really-just", rx: /\breally (just|only|need)\b/gi },
  {
    label: "minimization of work",
    rx: /\b(quick|simple|simplest|easy|easiest|minimal|trivial|small|tiny|cheap|fast)\s+(fix|patch|approach|path|solution|change|edit|commit|tweak|update|win|hack)\b/gi,
  },
  // INTERNAL SHORTHAND (operator 2026-08-22, on a message of mine ending with a
  // status token and a stage count): `Nobody else ever understands` it. A
  // channel is a room of people who do not share my terminal, so a token that
  // means something only to the person who built the check carries nothing and
  // takes up a line.
  //
  // Say what was checked and what it showed: `the test suite passes, and the
  // checks that talk to the real workspace pass too`. This rule sits on the SEND
  // alone. The operator reading my terminal knows what the local check is; the
  // room does not.
  {
    label: "internal shorthand nobody outside can read",
    rx: /\bgates?\s+(green|red)\b|\bgreen\s+at\s+\d+\b|\blive\s+stages?\b|\b\d+\s+stages?\s+pass\w*\b|\bsmoke\s+(green|passes|passed)\b|\ball\s+\d+\s+stage/gi,
  },
  // COINED JARGON: a word this project gave a private meaning. The L word below
  // is mine for committing a change, and the operator asked what it meant
  // (2026-08-22): `What is 'landing'? How can we ensure that it is only used at`
  // `proper places as 'landing page'?` Say `committed`, or
  // `pushed`, or name the commit.
  //
  // The ordinary English senses are spared by what FOLLOWS the word, since those
  // are compounds: a page, a zone, a strip. `\b` already spares England, Iceland
  // and island, which carry the letters without the word.
  {
    label: "coined jargon: 'land' for committing",
    rx: /\bland(s|ed|ing)?\b(?!\s+(page|pages|zone|zones|strip|strips))/gi,
  },
  // HUMAN ORGANISATION VOCABULARY, applied to a fleet of agents. The operator,
  // 2026-08-26: `this system is where agents collaborate. Agents are not humans.`
  // `There is no such thing as "staffing" or "headcount". Agent systems does not`
  // `need human team norms. Staffing, scheduling, and escalating human for`
  // `management decisions should not exist.`
  //
  // Each of these words imports a constraint that does not bind here: a person
  // costs a salary and works one shift, so a human team rations people and plans
  // who is available when. An agent fleet is bounded by the lane pool and the
  // endpoint, and the answer to "who does this" is "dispatch it".
  //
  // Say the concrete thing: how many workers the pool runs, which unit is
  // unclaimed, what the endpoint serves.
  {
    label: "human-team vocabulary (agents are not staff)",
    rx: /\b(staffing|staffed|headcount|head count|man[- ]?hours?|FTEs?|on[- ]call rotation|sprint capacity|work ?load balance)\b/gi,
  },
  { label: "em dash", rx: /—/g },
  { label: "en dash", rx: /–/g },
  {
    label: "adverb parked between commas",
    rx: /,\s*(honestly|frankly|basically|essentially|actually|candidly|truthfully|plainly|clearly|simply|obviously)\s*,/gi,
  },
  // ANTITHESIS (operator 2026-08-22): `A not B or A rather than B or anything`
  // `else like this is AI slop`. The construction spends two clauses defining a
  // thing by its opposite, where one clause states the thing.
  //
  // This rule OWNS the construction, so the trailing-aside rule below dropped
  // its `not` clause. Two rules matching one move would report it twice, and
  // neither would be the place to fix it.
  {
    label: "antithesis (A not B / A rather than B)",
    rx: /\brather than\b|\binstead of\b|,\s*not\b|\bnot\b[^.\n]{0,40}\bbut\b/gi,
  },
  // TRAILING ASIDE (operator 2026-08-21, on the heading "the wake path, before
  // you speak"): a qualification tacked on after a comma belongs inside the
  // sentence or in its own sentence.
  {
    label: "contrast tail at sentence end",
    rx: /,\s+(never|worse|better|only|just|less|more)\b[^.!?\n]{0,30}[.!?]/gi,
  },
  // REDUNDANT CLOSER (operator 2026-08-21, on a closing sentence of mine that
  // began `This is the whole memory story:` and then repeated the paragraph): a
  // sentence restating the passage, or commenting on the message itself, is
  // padding.
  {
    label: "redundant closer / meta-commentary",
    rx: /\b(this|that|these|those) (is|are) the whole\b|\bthis (file|skill|document|section|message|note) (is|holds|contains|covers)\b|\b(that|this) is the point\b|\bthe (point|takeaway|upshot) is\b|\bin (short|summary|closing)\b|\bto sum up\b|\ball told\b|\ball along\b|\bwhich is the whole\b/gi,
  },
  // ANNOUNCEMENT SCAFFOLDING, on a line of mine that announced its own form and
  // then ran to sixty words. A phrase announcing the FORM of what follows is
  // gibberish and comes out clean. Say the thing, and drop the narration around
  // saying it.
  //
  // The bare word `restate` was an alternative here and it matched four lines
  // across three files, every one of them an instruction against restating. A
  // rule written as a bare word matches prose ABOUT the rule, which is the trap
  // this repo took out of its wake filter on 2026-08-22. The announcing forms
  // are covered by the sentence clause and the `let me` clause.
  {
    label: "announcement scaffolding",
    rx: /\bin (one|a single) sentence\b|\bin a nutshell\b|\b(stated|said) differently\b|\bto put it (simply|differently|plainly|another way)\b|\b(simply|plainly) put\b|\bput simply\b|\bin other words\b|\blet me (explain|be clear|rephrase|restate|put)\b|\bin plain (terms|language|english)\b|\bworth noting\b|\bit should be noted\b|\bneedless to say\b/gi,
  },
];

/** Prose only: fenced blocks and inline backtick spans become blanks, so a quoted
 *  banned token is not a hit and every other offset is unchanged. */
export function proseOf(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank);
}

/** Every rule that fires, in rule order, with what it matched. */
export function lintLanguage(text: string, rules: LanguageRule[] = LANGUAGE_RULES): LanguageHit[] {
  const prose = proseOf(text);
  const hits: LanguageHit[] = [];
  for (const rule of rules) {
    // A fresh RegExp per call: a shared /g literal carries lastIndex between
    // calls, so the second message sent in one process would start scanning
    // from wherever the first one stopped and miss what came before it.
    const rx = new RegExp(rule.rx.source, rule.rx.flags);
    for (const m of prose.matchAll(rx)) {
      if (m[0] !== "") hits.push({ label: rule.label, match: m[0], index: m.index });
    }
  }
  // Offset order, so a file report reads top to bottom.
  return hits.sort((a, b) => a.index - b.index);
}

/** The refusal an agent reads, naming every hit. Empty when the text is clean. */
/** The word limit on one message.
 *
 *  The operator, 2026-08-22: "We need to impose a message length limit in words.
 *  Maybe 200", after a day of messages from three agents that buried their
 *  answer in the reasoning behind it. From the same instruction: "nobody cares
 *  about the way you get your answer unless they explicitly ask for it. Even if a
 *  detailed explanation is communicated, the only allowed way for it to be done
 *  is multiple rounds of back and forth conversation."
 *
 *  So the limit is a REFUSAL and not a warning: the long version is meant to
 *  become several short turns, and a warning would leave that to the sender who
 *  just wrote 900 words.
 *
 *  RAISED TO 300 by the operator, 2026-08-27: `Increase slack message word count`
 *  `cap to 300`. */
export const WORD_LIMIT = 300;

/** WHERE THE RULES ARE WRITTEN, printed on every refusal.
 *
 *  The operator asked whether communication should be its own skill "required to
 *  be used when sending a message". A skill an agent has to remember to open is
 *  advice, and this repo's own history says what advice is worth: a documented
 *  lint-then-send chain went unrun for a morning by the agent that wrote it.
 *
 *  So the refusal carries the pointer. It arrives at the moment someone is
 *  writing and got it wrong, which is the only moment the skill is worth
 *  reading, and nobody has to remember anything. */
const SKILL_POINTER = "Read the `communication` skill for the rules and the reasons.";

/** Words of PROSE in a message. Fenced blocks and backtick spans do not count:
 *  a measurement, a command or a log line is the evidence someone asked for, and
 *  charging for it would push a sender to paraphrase what it could have shown.
 *  Everything outside them counts, in any language: a run of CJK characters with
 *  no spaces counts by character, since a space-splitting count would read a
 *  300-character Chinese message as one word. */
export function wordCount(text: string): number {
  const prose = proseOf(text);
  const cjk = prose.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
  const latin = prose
    .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g, " ")
    .split(/\s+/)
    .filter((w) => w.replace(/[^\p{L}\p{N}]/gu, "") !== "").length;
  return cjk + latin;
}

// WHAT A REFUSAL SAYS, AND WHAT IT LEAVES OUT. The operator, 2026-08-26, reading
// the language refusal: "this is very bad language ... you DO NOT need the exact
// example quote in code." The text carried an incident from the day before,
// which is history a reader hits while blocked on their own send. Run through the
// model for a diagnosis, the same five faults came back: an anecdote burying the
// fix, an exemption written obscurely, a verbless pointer, an edge case ahead of
// the fix, and a count in developer syntax.
//
// A refusal names the rule, shows the words, says what to do. The reasons live
// in the skill.

/** The refusal for a message over the limit, or "" when it is within it. */
export function lengthRefusal(text: string): string {
  const n = wordCount(text);
  if (n <= WORD_LIMIT) return "";
  return (
    `message send REFUSED: ${n} words of prose, and the limit is ${WORD_LIMIT}.\n` +
    `Send the answer alone, and keep the reasoning for a reply if someone asks for it.\n` +
    `Code and fenced blocks do not count, so evidence is free.\n` +
    `${SKILL_POINTER}`
  );
}

export function languageRefusal(hits: LanguageHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => `  [${h.label}] ${JSON.stringify(h.match)}`);
  return (
    `message send REFUSED: ${hits.length} language rule(s) broken.\n` +
    `${lines.join("\n")}\n` +
    `Rewrite those words and send again.\n` +
    `Backticks and fenced blocks are exempt, so quote someone else's words inside them.\n` +
    `${SKILL_POINTER}`
  );
}
