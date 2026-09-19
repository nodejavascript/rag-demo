/**
 * Entries and notes.
 *
 * Two shapes, and the difference matters:
 *
 *  - an **entry** is a block of the document as the writer wrote it — one diary
 *    day, one section, one resume role. It is what the answer cites and what the
 *    timeline counts.
 *  - a **note** (a `Chunk`) is what actually gets embedded and searched. A short
 *    entry is one note. A long entry is split into several, because an embedding
 *    is a summary of everything in it and a 2,000-word entry summarises to mud.
 *
 * The splitter's one hard rule is inherited from the fragment bug: a heading only
 * starts a new entry when the line beneath the blank **ends in a full stop**. A
 * document of short standalone lines is therefore ONE entry, not fifty empty ones.
 */

import { dominantYear, entryDate, entryMonth, findDates } from './dates.js';
import { findAmounts, findPeople, findPlaces, imagesByEntry, tally } from './enrich.js';
import { blocks, cleanHeading, containsProse, endsInPunctuation, lines, looksLikeHeadingCandidate } from './text.js';
import type { Chunk, Entry, ImageRef, IndexStats, Mention, NoteMeta } from './types.js';

/** Words per note, and how much of the tail is repeated into the next one. */
export const CHUNK_WORDS = 220;
export const CHUNK_OVERLAP = 40;

export interface Built {
  entries: Entry[];
  chunks: Chunk[];
  stats: Omit<IndexStats, 'embeddingMs'>;
  images: ImageRef[];
  places: Mention[];
  people: Mention[];
  amounts: Mention[];
}

function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}'\u2019-]+/gu);
  return matches ? matches.length : 0;
}

/**
 * Cut a long entry into overlapping notes.
 *
 * The window is measured in WORDS, not characters, because "220 words" is roughly
 * one idea in every language and "1,200 characters" is not. The cut is pushed to the
 * end of the sentence when a sentence ends within the next stretch, so a note does
 * not stop mid-clause; and the next note begins a little before the cut, so a fact
 * that straddles the seam is still whole in one of them.
 *
 * Termination is guaranteed by construction: every pass advances at least one word,
 * because the overlap is always smaller than the window.
 */
function splitEntryText(text: string, start: number): { text: string; start: number; end: number }[] {
  if (countWords(text) <= CHUNK_WORDS) return [{ text, start, end: start + text.length }];

  const words = [...text.matchAll(/[\p{L}\p{N}'\u2019-]+/gu)].map((m) => ({
    at: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  const back = Math.min(CHUNK_OVERLAP, Math.floor(CHUNK_WORDS / 2));
  const pieces: { text: string; start: number; end: number }[] = [];

  let cursor = 0;
  while (cursor < words.length) {
    const limit = Math.min(cursor + CHUNK_WORDS, words.length);
    let cut = words[limit - 1]?.end ?? text.length;
    let covered = limit;

    // Reach for the end of the sentence, but not more than sixty words past.
    if (limit < words.length) {
      const look = Math.min(limit + 60, words.length);
      for (let i = limit; i < look; i += 1) {
        const between = text.slice(words[i - 1]?.end ?? 0, words[i]?.at ?? 0);
        if (/[.!?]/.test(between)) {
          cut = words[i - 1]?.end ?? cut;
          covered = i;
          break;
        }
      }
      while (covered < words.length && (words[covered]?.at ?? 0) < cut) covered += 1;
    }

    const from = words[cursor]?.at ?? 0;
    pieces.push({ text: text.slice(from, cut).trim(), start: start + from, end: start + cut });

    if (covered >= words.length) break;
    cursor = Math.max(cursor + 1, covered - back);
  }

  return pieces.filter((piece) => piece.text.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The values a finder accepts for the WHOLE document, as lowercase → as written.
 *
 * This is where acceptance happens, and it is the only place it happens. A single
 * name in a single note is not enough to be sure of anything; the same name written
 * across a document is.
 */
function acceptedIndex(text: string, finder: (input: string) => string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const value of finder(text)) {
    const key = value.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, value.trim());
  }
  return map;
}

/** Which of the accepted values appear in this piece of text. */
function presentIn(text: string, accepted: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of accepted) {
    if (new RegExp(`\\b${escapeRegExp(key)}\\b`, 'i').test(text)) out.push(value);
  }
  return out;
}

/**
 * Build the entries, the notes and the counts for one document.
 *
 * `yearHint` is the year the reader typed. When it is null the document's own most
 * common year is used instead, and the result says so — a document that writes no
 * year anywhere is dated by the year the reader supplied and only by that.
 */
export function build(text: string, yearHint: number | null, imagesIn: ImageRef[] = []): Built {
  const own = dominantYear(text);
  const year = yearHint ?? own;
  const assumedYear = own === null && year !== null;

  const rawEntries: Entry[] = [];
  const blockList = blocks(text);
  let current: { heading: string | null; text: string; start: number; end: number } | null = null;

  blockList.forEach((block, position) => {
    const blockLines = lines(block);
    const first = blockLines[0]?.text ?? '';
    const body = blockLines[1]?.text ?? null;

    // Three ways a block announces a new entry.
    //
    //  1. A heading with its body in the same paragraph — the ordinary case, judged by
    //     the line beneath ending in a full stop.
    //  2. A heading ALONE in its own paragraph, with prose in the next one. This is the
    //     shape almost every real document uses:
    //         EXPERIENCE
    //         <blank>
    //         Senior Software Engineer, …
    //     and missing it collapsed an entire resume into a single entry. A fragment
    //     list fails this test because its next block holds no sentence at all.
    //  3. A title line followed by a date line — how a resume writes a job, and how a
    //     list of fragments never reads.
    const startsEntry =
      blockLines.length > 1
        ? looksLikeHeadingCandidate(first) &&
          (endsInPunctuation(body) || (body !== null && findDates(body, null).length > 0))
        : looksLikeHeadingCandidate(first) &&
          blockList[position + 1] !== undefined &&
          containsProse((blockList[position + 1] as { text: string }).text);

    if (startsEntry) {
      if (current) rawEntries.push(finish(current));
      // The heading line stays IN the text. It is where a diary writes its date, so
      // removing it would take the date out of the searchable words and out of every
      // count taken over the document — a question about "the sixth of March" would
      // then find nothing. It is recorded separately as well, so it can label a note.
      current = {
        heading: cleanHeading(first),
        text: block.text.trim(),
        start: block.start,
        end: block.end,
      };
      return;
    }

    if (!current) {
      current = { heading: null, text: block.text, start: block.start, end: block.end };
      return;
    }
    current = {
      heading: current.heading,
      text: `${current.text}\n\n${block.text}`,
      start: current.start,
      end: block.end,
    };
  });
  if (current) rawEntries.push(finish(current));

  const entries: Entry[] = rawEntries.map((entry, index) => {
    const body = entry.text || entry.heading || '';
    const hit = entryDate(body, year);
    return {
      index,
      heading: entry.heading,
      date: hit?.date ?? null,
      dateRaw: hit?.raw ?? null,
      inferredYear: hit?.inferredYear ?? false,
      ambiguousDate: hit?.ambiguous ?? false,
      monthOnly: hit?.monthOnly ?? false,
      month: entryMonth(body, year),
      text: body,
      start: entry.start,
      end: entry.end,
    };
  });

  const images = imagesByEntry(imagesIn, entries.map((entry) => ({ index: entry.index, text: entry.text })));

  // Acceptance, over the WHOLE document, once — see the note at the top of the file.
  const wholeText = entries.map((entry) => entry.text).join('\n\n');
  const acceptedPlaces = acceptedIndex(wholeText, findPlaces);
  const acceptedPeople = acceptedIndex(wholeText, findPeople);

  const chunks: Chunk[] = [];
  for (const entry of entries) {
    const pieces = splitEntryText(entry.text, entry.start);
    pieces.forEach((piece, part) => {
      const meta: NoteMeta = {
        places: presentIn(piece.text, acceptedPlaces),
        people: presentIn(piece.text, acceptedPeople),
        images: images.filter((image) => image.entryIndex === entry.index),
        amounts: findAmounts(piece.text),
      };
      const base = entry.date ?? entry.dateRaw ?? entry.heading ?? `Entry ${entry.index + 1}`;
      chunks.push({
        id: chunks.length + 1,
        entryIndex: entry.index,
        part,
        parts: pieces.length,
        date: entry.date,
        dateRaw: entry.dateRaw,
        inferredYear: entry.inferredYear,
        heading: entry.heading,
        label: pieces.length > 1 ? `${base} (${part + 1}/${pieces.length})` : base,
        text: piece.text,
        start: piece.start,
        end: piece.end,
        words: countWords(piece.text),
        ...meta,
      });
    });
  }

  const dated = entries.filter((entry) => entry.date !== null);
  const placed = entries.filter((entry) => entry.month !== null);
  const perMonthMap = new Map<string, number>();
  for (const entry of placed) {
    const key = entry.month as string;
    perMonthMap.set(key, (perMonthMap.get(key) ?? 0) + 1);
  }
  const perMonth = [...perMonthMap.entries()]
    .map(([month, count]) => ({ month, entries: count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const stats: Omit<IndexStats, 'embeddingMs'> = {
    characters: text.length,
    words: countWords(text),
    entries: entries.length,
    datedEntries: dated.length,
    monthPrecision: placed.length - dated.length,
    inferredYears: entries.filter((entry) => entry.inferredYear).length,
    ambiguousDates: entries.filter((entry) => entry.ambiguousDate).length,
    chunks: chunks.length,
    firstDate: dated.length ? (dated[0]?.date ?? null) : null,
    lastDate: dated.length ? (dated[dated.length - 1]?.date ?? null) : null,
    months: perMonth.length,
    perMonth,
    assumedYear,
    yearUsed: year,
  };

  return {
    entries,
    chunks,
    stats,
    images,
    places: tally(
      entries.flatMap((entry) =>
        presentIn(entry.text, acceptedPlaces).map((value) => ({ value, entryIndex: entry.index }))
      )
    ),
    people: tally(
      entries.flatMap((entry) =>
        presentIn(entry.text, acceptedPeople).map((value) => ({ value, entryIndex: entry.index }))
      )
    ),
    amounts: tally(
      entries.flatMap((entry) => findAmounts(entry.text).map((value) => ({ value, entryIndex: entry.index })))
    ),
  };
}

function finish(entry: { heading: string | null; text: string; start: number; end: number }): Entry {
  return {
    index: 0,
    heading: entry.heading,
    date: null,
    dateRaw: null,
    inferredYear: false,
    ambiguousDate: false,
    monthOnly: false,
    month: null,
    text: entry.text,
    start: entry.start,
    end: entry.end,
  };
}

export { countWords };
