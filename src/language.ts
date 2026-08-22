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
  { label: "em dash", rx: /—/g },
  { label: "en dash", rx: /–/g },
  { label: "'layer' as a name", rx: /\blayers?\b|\blayering\b/gi },
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
      if (m[0] !== "") hits.push({ label: rule.label, match: m[0] });
    }
  }
  return hits;
}

/** The refusal an agent reads, naming every hit. Empty when the text is clean. */
export function languageRefusal(hits: LanguageHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => `  [${h.label}] ${JSON.stringify(h.match)}`);
  return (
    `message send REFUSED: ${hits.length} language-rule hit(s). Rewrite and send again.\n` +
    `${lines.join("\n")}\n` +
    `Someone else's words are exempt: put a quoted span in backticks.`
  );
}
