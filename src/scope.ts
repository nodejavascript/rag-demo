/**
 * Does this question ask for EVERYTHING the document holds, or for the part that matches?
 *
 * 🔴 WHY THIS FILE EXISTS — AND IT IS A MEASURED FAILURE, NOT A CAUTION. George asked his own
 * resume *"Which employers and job titles are named?"*, which is one of the questions the page
 * itself offers, and got **four employers out of twelve**. The answer ended by stating them:
 * *"Data Vision Studios, IOU Concepts, HealthyConnect Inc., and Conversion Media Group are the
 * employers."*
 *
 * Measured on his upload — document `X4HFxriPeq80`, 12,350 characters, 20 notes:
 *
 *   · the answer was written from **8 of the 20 notes**
 *   · those eight notes contained **four employer names**
 *   · **nine employer names were never shown to the model at all** — Utherverse, First Canadian
 *     Title, Influitive, Human_Code, LabX, Zeta Global, ICON Laser, BASF, and the second Data
 *     Vision entry
 *
 * **The model was faithful to its notes; the search starved it.** And the reason is structural, not
 * accidental: an employment block in a resume reads *"IOU Concepts / Hamilton, Ontario / 02/2017 -
 * 05/2022"* and never uses the word *employer*, so a similarity search for "employers and job
 * titles" has almost nothing to match on and ranks a handful of blocks. A question that asks for a
 * SET cannot be answered from the best-matching part of a document — the answer is not "the part
 * that matches", it is "all of it".
 *
 * 🔴 SO THE SHAPE OF THE QUESTION DECIDES THE SEARCH, and that decision is made ONCE, here, in code,
 * rather than quietly inside a similarity score. `wantsEverything` true means the whole document is
 * handed over instead of the best eight notes (`retrieveEverything` in `retrieve.ts`).
 *
 * 🔴 TWO REGISTRIES AND A NET, AND THE REGISTRIES ARE EXACT ON PURPOSE. The offered questions are
 * known strings, so they are classified **by their exact text** — a decision made once, deliberately,
 * per question — and `test/scope.test.js` fails if any question offered by `kinds.ts` is missing from
 * both registries. A new suggested question therefore cannot slip through unclassified. The patterns
 * underneath are the net for what a reader TYPES, where there is no registry to consult, and they
 * are deliberately narrow: a false positive costs a slower answer, a false negative costs the
 * incomplete list this file was written to stop.
 *
 * ⚠️ **A QUESTION HERE IS NOT A COUNT.** Nothing in this file asks the model to count — the counts
 * are still computed in code over the whole document (`factsFor`) and handed over as facts. Reading
 * every note is what makes an enumeration complete; it is not a licence to add up.
 */

import { BY_KIND, type DocumentKind } from './kinds.js';

/** The offered questions that ask for a list of everything, matched on their exact text. */
export const LIST_QUESTIONS: string[] = [
  // resume
  'What skills are listed?',
  'Where has this person worked?',
  'What education is listed?',
  'Which employers and job titles are named?',
  // job description — every one of these is spread down the page and is not all alike, so the same
  // starved search that answered "Which employers and job titles are named?" with four of twelve
  // would answer these with part of the list.
  'What are the essential qualifications?',
  'What are the responsibilities?',
  'What are the performance objectives?',
  'Which technologies and tools are named?',
  // news article
  'Who is quoted?',
  'Which places and organisations are named?',
  // statement of accounts
  'What amounts are listed?',
  'Which payees or merchants are named?',
  'What kinds of transactions appear?',
  // minutes
  'What action items are there?',
  'Who attended?',
  'What was left unresolved?',
  'What was decided?',
  // transcript
  'Who spoke, and about what?',
  'What was agreed?',
  'What questions were asked?',
  // policy
  'What does each party have to do?',
  // general, offered on a diary as well as on anything unclassified
  'Where do the events take place?',
];

/**
 * The offered questions that ask for ONE thing, listed so the decision is visible rather than
 * implied by a pattern that happened not to match. *"Who is mentioned most?"* is the type case: it
 * wants a single name, and handing over the whole document would answer it by accident.
 */
export const NOT_LIST_QUESTIONS: string[] = [
  'What is this document about?',
  'What happened first, and what happened last?',
  'Which month was busiest?',
  'Who is mentioned most?',
  'What did they do in the most recent role?',
  'What does it say about termination?',
  'What notice is required?',
  'What does it say about payment?',
  'What does it say about liability?',
  'What was discussed first?',
  'What was said last?',
  'What date range does it cover?',
  // job description — one thing said in one place, or nothing said at all
  'What does it say about where and how the work is done?',
  // news article — a byline, a narration and a look forward are each single answers
  'Who wrote it, and when was it published?',
  'What does it say happened?',
  'What does it say happens next?',
];

/** The net for a question someone TYPED, where there is no registry to consult. */
const PATTERNS: RegExp[] = [
  /\blist\b/,
  /\benumerate\b/,
  /\bhow many\b/,
  /\ball (?:the|of|its|their|his|her|our|my)\b/,
  /\bevery\b/,
  /\beach\b/,
  /\bname (?:the|all|every|each|them|both)\b/,
  /\b(?:which|what|who)\b[^?]{0,60}\b(?:are|is|were|was)\b[^?]{0,40}\b(?:named|mentioned|listed|included|present|available|used|shown|recorded)\b/,
  /\bwhere\b[^?]{0,40}\b(?:work|worked|works|working)\b/,
  /\bwhat (?:kinds?|types?|sorts?) of\b/,
];

/**
 * The words that mark a question as wanting ONE item — the busiest month, the name mentioned most,
 * the last thing said. They do not decide on their own: *"name all the parties, most importantly the
 * landlord"* is a list. So they only veto when no strong list word is present.
 */
const ONE_OFF =
  /\b(?:most|busiest|least|biggest|largest|smallest|earliest|latest|first|last|longest|shortest|how long)\b/;

/** A word that can only mean "give me the whole set". */
const STRONG = /\b(?:list|enumerate|all|every|each|how many|name (?:the|all|every|each|them))\b/;

/** Trimmed, lowercased, question mark and inner whitespace removed — the form both sides compare in. */
function normalise(question: string): string {
  return question.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[?!.]+$/, '');
}

/**
 * The words that ask about the document's OWN span — when it starts, when it ends, how long it covers.
 *
 * 🔴 WHY THIS IS HERE AND NOT IN THE REGISTRIES. George's page offers *"What date range does it cover?"*
 * on a statement, and on a statement of accounts that question was **refused in 0.3 s** — *"Nothing in
 * this document matched the question closely enough"* — while the document opened with *"1 January
 * 2026 to 31 March 2026"* and **the answer had already been computed in code** (`factsFor` pushes a
 * `date-range` fact for every dated document, always). The refusal is decided by similarity, and a
 * question about the document's own span has very little in common with the words in it, so the one
 * thing the program already knows for certain was thrown away in favour of a cosine.
 *
 * So this is not a reading of the question that changes which notes are used — the whole-document path
 * does that. It is the test for "the answer is in the facts, not in the notes", and it exists so the
 * refusal cannot overrule a fact that was counted over the whole document.
 */
export function asksForTheDateRange(question: string): boolean {
  const asked = normalise(question);
  return (
    /\bdate range\b/.test(asked) ||
    /\bwhat (?:period|dates?|years?)\b/.test(asked) ||
    /\bfrom (?:when|what date)\b/.test(asked) ||
    /\bwhen does it (?:start|begin|end|finish|run)\b/.test(asked) ||
    /\bhow long (?:does|is|was)\b/.test(asked) ||
    /\bhow (?:far|much time) (?:apart|between)\b/.test(asked)
  );
}

/**
 * True when the question asks for everything the document holds.
 *
 * Order matters, and it is: the exact registries first (a decision already made), then the one-off
 * veto, then the patterns.
 */
export function wantsEverything(question: string): boolean {
  const asked = normalise(question);
  if (asked.length === 0) return false;
  if (LIST_QUESTIONS.some((question) => normalise(question) === asked)) return true;
  if (NOT_LIST_QUESTIONS.some((question) => normalise(question) === asked)) return false;
  if (ONE_OFF.test(asked) && !STRONG.test(asked)) return false;
  return PATTERNS.some((pattern) => pattern.test(asked));
}

/**
 * Every question the page offers, with what reading each one gets.
 *
 * Exists so the classification can be **audited rather than trusted**: the test walks this and fails
 * if a question offered by `kinds.ts` is in neither registry, and `npm run scope` prints it.
 */
export function offeredQuestions(): { kind: DocumentKind; question: string; everything: boolean }[] {
  return (Object.keys(BY_KIND) as DocumentKind[]).flatMap((kind) =>
    BY_KIND[kind].map((question) => ({ kind, question, everything: wantsEverything(question) }))
  );
}
