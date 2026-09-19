/**
 * What the document does NOT say.
 *
 * 🔴 This is the honest half of "tell me more". The tempting version of that request is to
 * let the model add things it knows from outside the document — and that is exactly how
 * this app produced its worst answer: asked where he went to school, it said *University
 * of Windsor*, a name that is not in the resume. **The model already had the instruction
 * not to do that**, so asking it more politely would not have helped. What helps is telling
 * the reader something no model is needed for:
 *
 *   - **Which words in the question the document does not contain at all.** That is the
 *     literal answer to "what does it not say", it explains a refusal instead of leaving
 *     the reader to guess, and it is a lookup, not a guess.
 *   - **Which of its own findings rest on a single mention.** A thing said once is the
 *     easiest thing in a document to miss, and the count is already known.
 *
 * **Nothing here is generated.** Every claim is counted over the document's whole text, so
 * it costs nothing in trust and cannot hallucinate. That is why it can be shown beside a
 * grounded answer without weakening the answer's one promise.
 *
 * ⚠️ **THE CRITICAL PROPERTY IS THAT IT NEVER CLAIMS AN ABSENCE IT HAS NOT PROVED.**
 * "The document does not contain *door*" is a strong claim, and a wrong one is worse than
 * no panel at all — it would teach the reader to distrust a feature built entirely on
 * being checkable. So word matching below is deliberately **over-generous**: it counts a
 * word as present if the document holds anything close, including a plural, a different
 * spelling of the same word, or a mere four-letter opening. Being generous can only lose a
 * true absence; being strict would invent a false one, and a false absence is the one
 * failure this module must not have.
 */

import type { GapReport, Mention } from './types.js';

/** Question scaffolding: true of almost every question, so it carries no information. */
const SCAFFOLD = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how', 'did', 'does',
  'doesnt', 'dont', 'done', 'was', 'were', 'are', 'is', 'will', 'would', 'should', 'could',
  'can', 'about', 'there', 'their', 'them', 'they', 'this', 'that', 'these', 'those',
  'have', 'has', 'had', 'any', 'all', 'some', 'more', 'most', 'much', 'many', 'tell',
  'says', 'said', 'say', 'mention', 'mentions', 'mentioned', 'name', 'named', 'names',
  'give', 'gives', 'list', 'lists', 'happen', 'happened', 'happens', 'time', 'long',
  'often', 'again', 'still', 'just', 'only', 'very', 'know', 'think', 'thing', 'things',
  'with', 'from', 'into', 'over', 'under', 'than', 'then', 'and', 'the', 'for', 'not',
  'you', 'your', 'its', 'his', 'her', 'him', 'she', 'they', 'like', 'now', 'yet', 'also',
]);

/** The shortest word worth making an absence claim about. */
const MIN_LENGTH = 4;

/** Words in the text, lowercased, letters and digits only. */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((word) =>
    word.replace(/^['’]+|['’]+$/g, '')
  );
}

/**
 * True when two words are close enough that the document should be credited with the one
 * the question used.
 *
 * Deliberately loose, and it is loose in ONE direction on purpose: every clause below
 * makes the matcher say *"the document has this"* more readily, which can only cost us a
 * true absence. A false absence is the failure this whole module has to avoid.
 *
 *   `signed`  / `sign`    — one is the other's opening
 *   `doors`   / `door`    — the same, in the other direction
 *   `colour`  / `color`   — the same four letters, one letter apart
 *   `study`   / `studied` — the same four letters, two letters apart
 *
 * 🔴 THE THIRD CLAUSE IS THE ONE THAT WAS MISSING, and the probe found it: `study`
 * against a document reading **"He studied engineering and his studies ended in 1993"**
 * was reported ABSENT, because `studied` does not begin with `study` — the `y` becomes
 * `ied`. The first two clauses are prefix tests and a prefix test cannot see a word that
 * changes its ending. A **shared four-letter opening** can, and the length allowance is
 * what lets `studied` through while still refusing `date`/`data`, which differ at the
 * second letter.
 */
function related(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= MIN_LENGTH && longer.startsWith(shorter)) return true;
  return a.slice(0, 4) === b.slice(0, 4) && Math.abs(a.length - b.length) <= 4;
}

export interface GapInput {
  question: string;
  /** The document's whole text — not the notes, because this is a claim about all of it. */
  documentText: string;
  mentions: { places: Mention[]; people: Mention[]; amounts: Mention[] };
}

/**
 * How many absent words to name before summarising the rest. A question with eight unknown
 * words does not need eight lines under every answer.
 */
const MAX_ABSENT = 6;
const MAX_ONCE = 4;

export function analyseGaps(input: GapInput): GapReport {
  const documentWords = words(input.documentText);

  const contentTerms: string[] = [];
  const seen = new Set<string>();
  for (const word of words(input.question)) {
    if (word.length < MIN_LENGTH) continue;
    if (SCAFFOLD.has(word)) continue;
    if (/^\d+$/.test(word) && word.length < 4) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    contentTerms.push(word);
  }

  const absent: string[] = [];
  let presentCount = 0;
  for (const term of contentTerms) {
    const found = documentWords.some((word) => related(term, word));
    if (found) presentCount += 1;
    else absent.push(term);
  }

  // Only the things the reader can see named on the page, and only where the count is
  // exactly one — a claim the tally already made, restated.
  const once: { value: string; kind: string }[] = [];
  const groups: [string, Mention[]][] = [
    ['place', input.mentions.places],
    ['person', input.mentions.people],
    ['amount', input.mentions.amounts],
  ];
  for (const [kind, list] of groups) {
    for (const mention of list) {
      if (mention.count === 1) once.push({ value: mention.value, kind });
    }
  }

  return {
    absent: absent.slice(0, MAX_ABSENT),
    absentTotal: absent.length,
    presentCount,
    once: once.slice(0, MAX_ONCE),
  };
}
