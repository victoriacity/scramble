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
// only exemption. There is no --no-lint flag, because a bypass flag is exactly
// what a hurried agent reaches for.

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
  {
    label: "hedge",
    rx: /\b(sort of|kind of|to be fair|to be clear|to be (direct|frank|blunt|honest|candid)|in all (honesty|fairness)|in (truth|fairness)|that said|with that said|having said that|caveat|caveats|the (honest|direct|real) truth)\b/gi,
  },
  { label: "minimizing really-just", rx: /\breally (just|only|need)\b/gi },
  {
    label: "minimization of work",
    rx: /\b(quick|simple|simplest|easy|easiest|minimal|trivial|small|tiny|cheap|fast)\s+(fix|patch|approach|path|solution|change|edit|commit|tweak|update|win|hack)\b/gi,
  },
  { label: "em dash", rx: /—/g },
  { label: "en dash", rx: /–/g },
  { label: "'layer' as a name", rx: /\blayers?\b|\blayering\b/gi },
  {
    label: "adverb parked between commas",
    rx: /,\s*(honestly|frankly|basically|essentially|actually|candidly|truthfully|plainly|clearly|simply|obviously)\s*,/gi,
  },
  // TRAILING ASIDE (operator 2026-08-21, on the heading "the wake path, before
  // you speak"): a qualification tacked on after a comma belongs inside the
  // sentence or in its own sentence.
  {
    label: "contrast tail at sentence end",
    rx: /,\s+(not|never|worse|better|only|just|less|more)\b[^.!?\n]{0,30}[.!?]/gi,
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
