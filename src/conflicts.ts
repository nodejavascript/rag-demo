/**
 * Where the document disagrees with itself.
 *
 * 🔴 SAME RULE AS `gaps.ts`: NOTHING HERE IS GENERATED, and **nothing is claimed that has
 * not been proved.** A "the document contradicts itself" panel that is wrong once is worse
 * than no panel, because it asks the reader to distrust their own document on the strength
 * of a guess. So only three checks are made, and each one is arithmetic over what the parser
 * already extracted rather than an interpretation:
 *
 *   1. **Entries out of date order.** The parser knows each entry's date and the document's
 *      own order, so "these two entries are the wrong way round" is a comparison of two
 *      numbers. It matters more than it sounds: an out-of-order diary usually means a
 *      missing page, a copied-in block, or a typo in a year — all of which change what the
 *      timeline means.
 *   2. **A name written two different ways.** A fact about *spelling*, and it is worded that
 *      way — never "these are the same person". Two close spellings break keyword search
 *      (one of them finds nothing) and they are exactly what a reader misses.
 *   3. **A date that can be read two ways.** `06/03/2026` is March the 6th in one country
 *      and June the 3rd in another. The parser already refuses to resolve it; this names it,
 *      because a document containing one is a document whose dates cannot all be trusted.
 *
 * **What is deliberately NOT checked:** whether two mentions of the same thing are the same
 * thing, whether a total matches its parts, or whether a sentence contradicts another
 * sentence. Those need meaning, and a wrong answer about meaning is the failure mode this
 * whole app was built to avoid.
 */

import type { Entry, Mention } from './types.js';

export interface ConflictReport {
  /** Entries whose date runs backwards against the entry before them. */
  outOfOrder: { at: number; label: string; date: string; previousDate: string; previousLabel: string }[];
  /** The same word written two different ways, as a fact about the spelling. */
  spelledTwoWays: { a: string; b: string; kind: string }[];
  /** Dates the parser refused to resolve, quoted as written. */
  ambiguous: { label: string; raw: string }[];
}

/** How many of each to name before the panel becomes a wall. */
const MAX_OUT_OF_ORDER = 3;
const MAX_SPELLINGS = 4;
const MAX_AMBIGUOUS = 3;

/** Levenshtein distance, iterative, two rows. Short strings only — this is for names. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 99;
}

/**
 * True when two written forms are close enough to be worth showing side by side.
 *
 * The floor of five characters is what keeps this from being noise: at four, `Port` and
 * `Fort` would be reported as one name written two ways, and a reader would rightly stop
 * believing the panel. Above five, a transposition (`Grimsby`/`Grimbsy`) and a doubled
 * letter (`Necole`/`Necolle`) are still caught.
 */
function looksLikeTheSameWord(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.length < 5 || b.length < 5) return false;
  const wordsA = a.trim().split(/\s+/).length;
  const wordsB = b.trim().split(/\s+/).length;
  if (wordsA !== wordsB) return false;
  // 🔴 CASE IS NOT A SECOND WAY OF WRITING A NAME — George, 20 Sep 2026, verbatim: *"Full-Stack
  // and Full-stack — a name, written two ways so you should be ignoring case for this
  // disagreement stuff."* He was right, and the arithmetic says why: the edit distance between
  // the two is computed on lowercased copies, so `Full-Stack` and `Full-stack` give a distance
  // of **0** and were reported as a spelling disagreement **because of the capitals alone**.
  // The check exists to catch a difference in SPELLING; case is a difference in typing. Fold it
  // first and return, so the pair is never even considered. (A hyphen against a space still
  // counts: `Full-Stack` / `Full Stack` is a distance of 1 and is a genuine second form.)
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA === lowerB) return false;
  return editDistance(lowerA, lowerB) <= 2;
}

/**
 * Words where a small spelling gap is expected and means an entirely different thing.
 *
 * 🔴 **THIS LIST EXISTS BECAUSE OF MEASURED FALSE POSITIVES, TWO OF THEM.**
 *
 * First, run over the diary, the check reported **`Tuesday` and `Thursday` as one name
 * written two ways** — and it was right about the arithmetic: the two words really are two
 * edits apart (`tuesday` → `t-h-u-s-d-a-y` → `t-h-u-r-s-d-a-y`). It was wrong about the
 * meaning, which is the one thing it must never be wrong about. **Tightening the distance
 * would not fix it** — `Grimsby`/`Grimbsy`, the exact case this exists for, is also two
 * edits. So the fix is a closed list of the words where that gap is expected.
 *
 * Second, the pool builds short capitalised PHRASES, so a sentence opening gave the pair
 * **`On Tuesday` / `On Thursday`** — the stoplist check was looking at the whole phrase and
 * never saw the weekday inside it. Hence the per-word test below, and the function words:
 * a capitalised word at the start of a sentence is capitalised for grammar, not because it
 * is a name.
 */
const NEVER_A_MISSPELLING = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
  // Capitalised only because a sentence started.
  'a', 'an', 'the', 'and', 'but', 'so', 'or', 'if', 'as', 'at', 'by', 'for', 'from', 'in',
  'into', 'of', 'on', 'to', 'with', 'not', 'no', 'all', 'any', 'was', 'were', 'is', 'are',
  'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'should', 'may', 'might', 'must', 'it', 'its', 'i', 'we', 'our', 'he', 'she', 'they',
  'his', 'her', 'their', 'this', 'that', 'these', 'those', 'there', 'then', 'when', 'after',
  'before', 'during', 'my', 'me', 'us', 'them', 'you', 'your',
]);

/** True when a capitalised candidate could be a name at all. */
function isNameLike(value: string): boolean {
  return !value
    .trim()
    .split(/\s+/)
    .some((word) => NEVER_A_MISSPELLING.has(word.toLowerCase().replace(/[^\p{L}]/gu, '')));
}

function labelOf(entry: Entry): string {
  return entry.dateRaw ?? entry.heading ?? `entry ${entry.index + 1}`;
}

export interface ConflictInput {
  entries: Entry[];
  mentions: { places: Mention[]; people: Mention[]; amounts: Mention[] };
  /** The document's whole text, for the spelling check. See `capitalisedWords`. */
  documentText: string;
}

/**
 * The capitalised words in the document, which is the pool the spelling check runs over.
 *
 * 🔴 **WHY NOT JUST THE EXTRACTED PLACES AND PEOPLE — MEASURED.** The first version compared
 * only what `enrich.ts` had already accepted, and it found nothing on a document containing
 * **`Grimsby` and `Grimbsy`**: a single-word place is only accepted when it is in the
 * gazetteer, so the *misspelling* is rejected by the extractor and never reached the check.
 * The check could therefore only see names that were already spelled right — the one case
 * where it has nothing to say.
 *
 * A capitalised word is the widest pool that is still cheap and still a signal: it is what
 * a reader means by "a name". The guards below (`looksLikeTheSameWord`) are what keep it
 * from pairing two legitimately different nouns.
 */
function capitalisedWords(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][\p{L}\u2019'-]{4,}\b/gu)) {
    if (isNameLike(match[0])) out.add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Z][\p{L}\u2019'-]{1,}(?:\s+[A-Z][\p{L}\u2019'-]{1,}){0,2}\b/gu)) {
    if (isNameLike(match[0])) out.add(match[0]);
  }
  return [...out].slice(0, 400);
}

export function analyseConflicts(input: ConflictInput): ConflictReport {
  // 1 · Entries whose date runs backwards. Walked in the DOCUMENT'S OWN order, comparing
  // each complete date with the last complete date seen — so a run of undated entries in
  // between neither hides nor creates a break.
  const outOfOrder: ConflictReport['outOfOrder'] = [];
  let previous: Entry | null = null;
  for (const entry of input.entries) {
    if (!entry.date) continue;
    if (previous && entry.date < (previous.date as string)) {
      outOfOrder.push({
        at: entry.index,
        label: labelOf(entry),
        date: entry.date,
        previousDate: previous.date as string,
        previousLabel: labelOf(previous),
      });
    }
    previous = entry;
  }

  // 2 · A name written two ways. A fact about spelling, not a claim about identity.
  //
  // The pool is every capitalised word in the document, not just the names the extractor
  // accepted — see `capitalisedWords` for the measurement that forced this.
  const spelledTwoWays: ConflictReport['spelledTwoWays'] = [];
  const kindOf = (value: string): string => {
    if (input.mentions.places.some((mention) => mention.value === value)) return 'place';
    if (input.mentions.people.some((mention) => mention.value === value)) return 'person';
    return 'name';
  };
  const pool = capitalisedWords(input.documentText);
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const a = pool[i] ?? '';
      const b = pool[j] ?? '';
      // A misspelling almost always keeps the first letter, and this one guard removes
      // most of the pairs that would otherwise be noise.
      if (a[0] !== b[0]) continue;
      if (looksLikeTheSameWord(a, b)) {
        spelledTwoWays.push({ a, b, kind: kindOf(a) === 'name' ? kindOf(b) : kindOf(a) });
      }
    }
  }

  // 3 · Dates the parser refused to resolve, quoted as written.
  const ambiguous: ConflictReport['ambiguous'] = [];
  for (const entry of input.entries) {
    if (!entry.ambiguousDate) continue;
    ambiguous.push({ label: labelOf(entry), raw: entry.dateRaw ?? '(written as a number pair)' });
  }

  return {
    outOfOrder: outOfOrder.slice(0, MAX_OUT_OF_ORDER),
    spelledTwoWays: spelledTwoWays.slice(0, MAX_SPELLINGS),
    ambiguous: ambiguous.slice(0, MAX_AMBIGUOUS),
  };
}
