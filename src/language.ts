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
// A quoted span is DATA, not prose: this file names the tokens it bans, and a
// message reporting what someone else wrote has to be able to carry their words.
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
  /** Character offset in the ORIGINAL text. Quoted spans are blanked rather than
   *  removed, so every offset survives and a file report can name the line. */
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
  // ANNOUNCING CANDOR: a preamble saying you are about to speak plainly, which
  // the plain sentence does not need.
  //
  // THE WORD ITSELF, not a list of the verbs it attaches to. This rule was twice
  // an enumeration and twice too small: first the two forms "stated plainly" and
  // "plainly put", which let through "One thing I should say plainly"; then a
  // wider verb list with third-person spared, on my argument that a DOCUMENT
  // stating something plainly is a fact about the document. The operator refused
  // that exemption: "Third person should not be allowed either." So the word is
  // banned outright, the way the dashes are. There is no verb to add next time,
  // which was the whole defect in the two previous versions.
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
  // INTERNAL SHORTHAND (operator 2026-08-22, on a message of mine ending "Gate
  // green at 457, six live stages pass."): "Nobody else ever understands" it. A
  // channel is a room of people who do not share my terminal, so a status token
  // that means something only to the person who built the check carries nothing
  // and takes up a line.
  //
  // Say what was checked and what it showed: "the test suite passes, and the
  // checks that talk to the real workspace pass too". This rule is on the SEND
  // and not on the closing gate, because the operator reading my terminal does
  // know what the gate is; the room does not.
  {
    label: "internal shorthand nobody outside can read",
    rx: /\bgates?\s+(green|red)\b|\bgreen\s+at\s+\d+\b|\blive\s+stages?\b|\b\d+\s+stages?\s+pass\w*\b|\bsmoke\s+(green|passes|passed)\b|\ball\s+\d+\s+stage/gi,
  },
  // COINED JARGON: a word this project gave a private meaning. "Landing" is mine
  // for committing a change through scripts/land.sh, and the operator asked what
  // it meant (2026-08-22): "What is 'landing'? How can we ensure that it is only
  // used at proper places as 'landing page'?" Say `committed`, or `pushed`, or
  // name the commit.
  //
  // The ordinary English senses are spared by what FOLLOWS the word, since those
  // are compounds: a landing page, a landing zone, a landing strip. `\b` already
  // spares England, Iceland and island, which contain the letters and not the
  // word.
  {
    label: "coined jargon: 'land' for committing",
    rx: /\bland(s|ed|ing)?\b(?!\s+(page|pages|zone|zones|strip|strips))/gi,
  },
  { label: "em dash", rx: /—/g },
  { label: "en dash", rx: /–/g },
  {
    label: "adverb parked between commas",
    rx: /,\s*(honestly|frankly|basically|essentially|actually|candidly|truthfully|plainly|clearly|simply|obviously)\s*,/gi,
  },
  // ANTITHESIS (operator 2026-08-22): "A not B or A rather than B or anything
  // else like this is AI slop". The construction defines a thing by what it is
  // not, which takes two clauses to say what one says: write the thing.
  //
  // This rule OWNS the construction, so the trailing-aside rule below no longer
  // lists `not` — two rules matching one move would report it twice and neither
  // would be the place to fix it.
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
  // REDUNDANT CLOSER (operator 2026-08-21, on "This is the whole memory story:
  // no side directory, no index file to maintain"): a sentence that restates the
  // passage, or comments on the message itself, is padding.
  {
    label: "redundant closer / meta-commentary",
    rx: /\b(this|that|these|those) (is|are) the whole\b|\bthis (file|skill|document|section|message|note) (is|holds|contains|covers)\b|\b(that|this) is the point\b|\bthe (point|takeaway|upshot) is\b|\bin (short|summary|closing)\b|\bto sum up\b|\ball told\b|\ball along\b|\bwhich is the whole\b/gi,
  },
  // ANNOUNCEMENT SCAFFOLDING, on "The measurement, restated in one sentence:"
  // followed by sixty words: a phrase that announces the FORM of the statement
  // about to be made is gibberish and can simply be removed. Say the thing; do
  // not narrate that you are saying it.
  //
  // The bare word `restate` was an alternative here and it matched four lines
  // across three files, every one of them an instruction NOT to restate. A rule
  // written as a bare word matches prose ABOUT the rule, which is the trap this
  // repo took out of its wake filter on 2026-08-22. The announcing forms are
  // covered without it: "restated in one sentence" is caught by the sentence
  // clause, and "let me restate" by the `let me` clause.
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
  // Offset order, so a file report reads top to bottom rather than rule by rule.
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
 *  just wrote 900 words. */
export const WORD_LIMIT = 200;

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
const SKILL_POINTER = "The rules and the reasons: the `communication` skill.";

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

/** The refusal for a message over the limit, or "" when it is within it. */
export function lengthRefusal(text: string): string {
  const n = wordCount(text);
  if (n <= WORD_LIMIT) return "";
  return (
    `message send REFUSED: ${n} words of prose, and the limit is ${WORD_LIMIT}.\n` +
    `Send the answer alone. What you cut is the reasoning behind it, which the reader ` +
    `asks for when they want it, in the next message.\n` +
    `Code blocks and backtick spans are not counted, so evidence costs nothing.\n` +
    `${SKILL_POINTER}`
  );
}

export function languageRefusal(hits: LanguageHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => `  [${h.label}] ${JSON.stringify(h.match)}`);
  return (
    `message send REFUSED: ${hits.length} language-rule hit(s). Rewrite and send again.\n` +
    `${lines.join("\n")}\n` +
    `Someone else's words are exempt: put a quoted span in backticks.\n` +
    `A comparison you have to make survives inside a fenced block, which is exempt whole. An agent ` +
    `hit five refusals in a row on one rule, because its finding compared two behaviours and every ` +
    `phrasing of that comparison tripped it (2026-08-25).\n` +
    `${SKILL_POINTER}`
  );
}
