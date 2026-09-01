// THE LANGUAGE RULES, AND THE ONLY PLACE THEY LIVE.
//
// The `message send` command checks language rules where the message leaves, so
// there is no separate linter to run first.
//
// The previous workflow required a sequence the sender had to remember: write a
// draft file, run `lint_language.py` on it, and send only if it passed. Piping
// text directly into `message send` meant the lint ran on nothing, which allowed a
// long dash to appear in a message. The linting had not run. A step an agent has to
// remember is not a check.
//
// A quoted span is data. This file names the tokens it bans, and a message
// reporting what someone else wrote has to be able to carry their words. Fenced
// blocks and inline backticks are blanked before the scan, and that is the only
// exemption. There is no `--no-lint` flag: a flag that turns the check off makes
// it optional again, which is the defect this replaced.

export interface LanguageRule {
  label: string;
  rx: RegExp;
}

export interface LanguageHit {
  label: string;
  match: string;
  /**
   *  Character offsets match the original text. Quoted spans are blanked in place,
   *  so every offset survives and a file report can name the line.
   */
  index: number;
}

/**
 *  The line number for an offset is 1-based.
 */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line += 1;
  return line;
}

/**
 *  Every rule includes the reason for its existence when that reason is not
 *  obvious.
 */
export const LANGUAGE_RULES: LanguageRule[] = [
  // A DECISION INSIDE YOUR OWN CODE IS YOURS TO MAKE. An agent read a threshold in
  // its own repository, found the number had no measurement under it, found that it
  // refused the work the tool exists to do, named the replacement, and then closed
  // with `it is yours to call`. The operator answered that the agent is the sole
  // developer of the codebase, and spent two messages doing the deciding. The same
  // agent had
  // deferred a page change of its own an hour earlier.
  //
  // A decision that genuinely belongs to a person names the thing they own: a
  // hostname, a credential, a visibility flip, a budget, an access grant. Those
  // sentences carry none of the phrases below, which are the reflex forms and say
  // nothing about which decision is whose.
  {
    label: "deferring a decision the writer owns",
    rx: /\byours to (call|decide)\b|\byour call\b|\bup to you\b|\bfor you to decide\b|\bif you want it\b|\bsay the word and I\b/gi,
  },
  {
    label: "filler",
    rx: /\b(honestly|honest|honesty|actually|basically|essentially|frankly|candidly|truthfully)\b|\bstated plainly\b|\bplainly put\b|\bto be (fair|blunt|clear)\b/gi,
  },
  // Preambles that announce direct phrasing add nothing that a sentence requires.
  //
  // The rule targets the word itself. Two attempts to list its associated verbs
  // failed. The first attempt checked specific phrasing such as `plainly put`,
  // which still permitted expressions like `One thing I should say plainly`. A
  // second attempt expanded the verb list while exempting third-person
  // statements, under the rationale that a document describing itself states a
  // factual property. Third-person phrasing is also disallowed. Therefore, the
  // rule bans the word outright, as it does dashes, so no verb list can fail again.
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
  // When a message ends with a status token and a stage count, `Nobody else ever
  // understands` the internal shorthand. A channel contains people who do not share
  // the sender's terminal, so a token that means something only to the person who
  // built the check carries nothing for the room and takes up a line.
  //
  // State what was checked and what it showed: `the test suite passes, and the
  // checks that talk to the real workspace pass too`. This rule applies to SEND
  // operations alone. The operator reading the terminal knows the local check,
  // whereas the room lacks that context.
  {
    label: "internal shorthand nobody outside can read",
    rx: /\bgates?\s+(green|red)\b|\bgreen\s+at\s+\d+\b|\blive\s+stages?\b|\b\d+\s+stages?\s+pass\w*\b|\bsmoke\s+(green|passes|passed)\b|\ball\s+\d+\s+stage/gi,
  },
  // This project coined private jargon for committing a change. The rule below
  // catches the coined verb and leaves the ordinary uses alone, such as a page a
  // reader arrives on. Write `committed` or `pushed`, or name
  // the commit.
  //
  // The check preserves ordinary English senses by matching what follows the
  // word, since those terms are compounds: a page, a zone, a strip. The `\b`
  // boundary preserves England, Iceland, and island, which carry the letters
  // without the word.
  {
    label: "coined jargon: 'land' for committing",
    rx: /\bland(s|ed|ing)?\b(?!\s+(page|pages|zone|zones|strip|strips))/gi,
  },
  // Human organization vocabulary misrepresents a fleet of agents. This system
  // coordinates collaborating agents under automated execution, so the words a
  // company uses for hiring, team size, shift rotas and management escalation
  // describe nothing here. The rule below carries them.
  //
  // Human terms introduce constraints that do not bind software. A human team
  // rations personnel and schedules availability because an employee receives a
  // salary and works one shift. The lane pool and the endpoint bound an agent fleet,
  // so the system assigns work by dispatching it.
  //
  // State operational details concretely: report how many workers the pool runs,
  // which unit is unclaimed, and what the endpoint serves.
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
  // The ANTITHESIS operator matches patterns like
  // `A not B or A rather than B or anything` `else like
  // this is AI slop`. The construction uses two clauses to define a concept by its
  // opposite, whereas a single clause states the fact.
  //
  // This rule manages this construction, so the trailing-aside rule below dropped
  // its `not` clause. Two rules that match the same pattern would report it twice,
  // and neither rule would serve as the clear place to fix it.
  {
    label: "antithesis (A not B / A rather than B)",
    rx: /\brather than\b|\binstead of\b|,\s*not\b|\bnot\b[^.\n]{0,40}\bbut\b/gi,
  },
  // A qualification added after a comma belongs inside the sentence or in its own
  // sentence under the heading "the wake path, before you speak".
  {
    label: "contrast tail at sentence end",
    rx: /,\s+(never|worse|better|only|just|less|more)\b[^.!?\n]{0,30}[.!?]/gi,
  },
  // A redundant closing sentence that restates a passage, opens with
  // `This is the whole memory story:` to repeat a paragraph, or comments on the
  // message itself, is padding.
  {
    label: "redundant closer / meta-commentary",
    rx: /\b(this|that|these|those) (is|are) the whole\b|\bthis (file|skill|document|section|message|note) (is|holds|contains|covers)\b|\b(that|this) is the point\b|\bthe (point|takeaway|upshot) is\b|\bin (short|summary|closing)\b|\bto sum up\b|\ball told\b|\ball along\b|\bwhich is the whole\b/gi,
  },
  // Announcement scaffolding occurs when a line announces its own form and extends
  // to sixty words. A phrase that announces the form of what follows carries no
  // meaning and is removed cleanly. State the point directly, and drop the
  // narration around it.
  //
  // The bare word `restate` was an alternative here, and it matched four lines
  // across three files, where every matching line was an instruction against
  // restating. A rule written as a bare word matches prose about the rule itself,
  // which is the trap this repository removed from its wake filter. The sentence
  // clause and the `let me` clause cover the announcing forms.
  {
    label: "announcement scaffolding",
    rx: /\bin (one|a single) sentence\b|\bin a nutshell\b|\b(stated|said) differently\b|\bto put it (simply|differently|plainly|another way)\b|\b(simply|plainly) put\b|\bput simply\b|\bin other words\b|\blet me (explain|be clear|rephrase|restate|put)\b|\bin plain (terms|language|english)\b|\bworth noting\b|\bit should be noted\b|\bneedless to say\b/gi,
  },
];

/**
 *  These rules apply to this repository's own text, which includes every source
 *  comment and every tracked markdown file. This text forbids everything that the
 *  message rules ban, plus the log line.
 *
 *  A date in the repository's own text acts as a log entry. Source comments carried
 *  340 stamps across 39 files, in the shapes `The operator, 2026-08-27:` and
 *  `(2026-08-26)`, where each stamp recorded when someone made a statement. The
 *  repository excludes these dates from the code. A reader of a comment needs the
 *  rule and the failure it prevents; `git log` holds when, and `git blame` holds
 *  who.
 *
 *  Messages keep their dates, so this rule stays out of `LANGUAGE_RULES`: a date
 *  in a channel message is evidence the reader can check. A path that carries a
 *  date in its name goes in backticks, which `proseOf` blanks.
 */
export const DATE_RULES: LanguageRule[] = [
  { label: "dated log line in the repo's own text", rx: /\b\d{4}-\d{2}-\d{2}\b/g },
];

export const CODE_RULES: LanguageRule[] = [...LANGUAGE_RULES, ...DATE_RULES];

/**
 *  The rule applies to prose only. Fenced blocks and inline backtick spans
 *  become blanks, so a quoted banned token is not a hit and every other
 *  offset remains unchanged.
 */
export function proseOf(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank);
}

/**
 *  The output shows every rule that fires, in rule order, with what it matched.
 */
export function lintLanguage(text: string, rules: LanguageRule[] = LANGUAGE_RULES): LanguageHit[] {
  const prose = proseOf(text);
  const hits: LanguageHit[] = [];
  for (const rule of rules) {
    // The function creates a fresh `RegExp` per call. A shared `/g` literal carries
    // `lastIndex` between calls, so the second message sent in one process would start
    // scanning from wherever the first message stopped and miss what came before it.
    const rx = new RegExp(rule.rx.source, rule.rx.flags);
    for (const m of prose.matchAll(rx)) {
      if (m[0] !== "") hits.push({ label: rule.label, match: m[0], index: m.index });
    }
  }
  // The report uses offset order, so a file report reads top to bottom.
  return hits.sort((a, b) => a.index - b.index);
}

/**
 *  An agent reads this refusal, which names every hit. The field is empty when the
 *  text is clean.
 */
/**
 *  The word limit on one message.
 *
 *  The system imposes a message length limit of 200 words after a day of messages
 *  from three agents that buried their answers in reasoning. Senders must omit the
 *  steps used to reach an answer unless the recipient explicitly asks for them.
 *  Even when communicating a detailed explanation, the sender must deliver it
 *  through multiple rounds of back-and-forth conversation.
 *
 *  The limit is a refusal. A long version must become several short turns, because
 *  a warning leaves the response to a sender that wrote 900 words.
 *
 *  The limit is raised to 300 words: `Increase slack message word count`
 *  `cap to 300`.
 */
export const WORD_LIMIT = 300;

/**
 *  WHERE THE RULES ARE WRITTEN, printed on every refusal.
 *
 *  Communication does not operate as a standalone skill that an agent must open
 *  before sending a message. A skill an agent must remember to open acts as advice,
 *  and repository history shows the result of relying on advice: the agent that
 *  wrote a documented lint-then-send workflow left it unrun for a morning.
 *
 *  So the refusal carries the pointer. The refusal arrives at the moment an author
 *  makes an error, which is the only moment the skill provides value, and the
 *  author does not need to memorize anything.
 */
const SKILL_POINTER = "Read the `communication` skill for the rules and the reasons.";

/**
 *  The system counts the words of prose in a message. Fenced blocks and backtick
 *  spans do not count toward this total. A measurement, a command, or a log line
 *  provides the evidence someone asked for, and charging for it would push a sender
 *  to paraphrase what could be shown directly. All text outside these blocks counts
 *  in any language. A sequence of CJK characters without spaces counts by
 *  character, since splitting only on whitespace would read a 300-character Chinese
 *  message as one word.
 */
export function wordCount(text: string): number {
  const prose = proseOf(text);
  const cjk = prose.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
  const latin = prose
    .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g, " ")
    .split(/\s+/)
    .filter((w) => w.replace(/[^\p{L}\p{N}]/gu, "") !== "").length;
  return cjk + latin;
}

// A language refusal omits exact example quotes in code and history from past
// incidents that a reader encounters while blocked on a send. When the model
// diagnosed the refusal text, it returned five faults: an anecdote burying the
// fix, an exemption written obscurely, a verbless pointer, an edge case placed
// ahead of the fix, and a count in developer syntax.
//
// A refusal names the rule, shows the words, and states what to do. The reasons
// live in the skill.

/**
 *  The output contains the refusal for a message over the limit, or "" when the
 *  message is within the limit.
 */
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

/** The paragraphs that say "your" to a room of several agents without naming which
 *  one they mean, returned as the text of each offending paragraph.
 *
 *  WHOSE FACT IS IT. A message greeting three agents and then saying "your 118-draft
 *  scan" leaves every reader to guess whether the clause is theirs, and they guess
 *  wrong: one agent read two clauses as both theirs and published a correction of a
 *  claim they never made, and a later message credited one agent's scan of 26 files
 *  as another's scan of 118. Twice in two days, from the same writing habit of
 *  opening to everyone who replied and then writing clauses that each belong to one
 *  of them.
 *
 *  A paragraph clears this by naming its owner: one `@handle` inside that paragraph,
 *  or the timestamp of the message the fact came from, which the send already reads
 *  back from Slack with its author printed. A message addressed to one agent has one
 *  owner throughout and is left alone. */
export function unownedAttributions(text: string): string[] {
  const prose = proseOf(text);
  const handlesIn = (s: string): Set<string> =>
    new Set((s.match(/@[a-z][a-z0-9_.-]{2,}/gi) ?? []).map((h) => h.toLowerCase()));
  const handles = handlesIn(prose);
  if (handles.size < 2) return [];
  // A CLAIM ABOUT WHAT ONE READER DID is what goes wrong: a possessive ("your
  // 118-draft scan") or a report of their action ("you measured"). A collective "you"
  // ("the rows behind you", "three of you hit the same wall") belongs to the room and
  // names nobody's work, so it is left alone. A wider rule refused the greeting of
  // every message written to more than one agent, which would have taught everybody
  // to work around the check.
  const attributes = (s: string): boolean =>
    /\byours?\b\s+[a-z0-9]/i.test(s) ||
    /\byou\b\s+(measured|counted|ran|scanned|reported|published|wrote|found|said|held|proposed|posted|sent|read|replayed|stored|built|filed|landed|shipped)\b/i.test(s);
  const out: string[] = [];
  for (const para of prose.split(/\n\s*\n/)) {
    if (!attributes(para)) continue;
    const named = handlesIn(para);
    // A Slack ts names the message the fact came from, which is stronger than a
    // handle: the send reads it back and prints who wrote it.
    if (/\b\d{10}\.\d{6}\b/.test(para)) continue;
    // One handle names the owner. Every handle the message addresses is the room,
    // and a sentence to the room owns its claim collectively.
    if (named.size === 1 || named.size === handles.size) continue;
    out.push(para.trim());
  }
  return out;
}

export function attributionRefusal(paras: string[], text: string): string {
  if (paras.length === 0) return "";
  const handles = [...new Set((proseOf(text).match(/@[a-z][a-z0-9_.-]{2,}/gi) ?? []).map((h) => h.toLowerCase()))];
  return (
    `message send REFUSED: ${paras.length} paragraph(s) say "you" to ${handles.length} agents ` +
    `(${handles.join(", ")}) without naming which one.\n` +
    `${paras.map((p) => `  ${JSON.stringify(p.slice(0, 160))}`).join("\n")}\n` +
    `Name the owner in the paragraph, with the handle or with the ts of the message the fact came from.\n` +
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

