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

import { dominantYear, entryDate, entryMonth, entryPeriod, findDates } from './dates.js';
import { findAmounts, findPeople, findPlaces, imagesByEntry, tally } from './enrich.js';
import { blocks, cleanHeading, endsInPunctuation, isBodyOf, isSectionName, lines, looksLikeHeadingCandidate } from './text.js';
import type { Chunk, Entry, ImageRef, IndexStats, Mention, NoteMeta } from './types.js';

/** Words per note, and how much of the tail is repeated into the next one. */
export const CHUNK_WORDS = 220;
export const CHUNK_OVERLAP = 40;

/**
 * A document that arrived as ONE solid run of many short lines is a list of records, and it is split.
 *
 * 🔴 WHY, MEASURED. A statement of accounts — one line per transaction, the shape every bank exports —
 * came out as **one entry and one note of about 1,300 characters**. The search then had no granularity
 * at all, and the refusal floor, which is measured against short notes, called the document silent
 * about its own contents: three of the four questions the page offers on a statement were answered
 * *"Nothing in this document matched the question closely enough"* in 0.2 seconds, and one of them
 * (*"What date range does it cover?"*) stayed refused even after that, on a document that opens with
 * *"1 January 2026 to 31 March 2026"*. Found by `tools/judge-answers.mjs` on 22 Sep 2026.
 *
 * ⚠️ **THE FRAGMENT GUARD IS NOT BEING UNDONE.** A document of short standalone lines separated by
 * BLANK lines stays one entry — that rule exists because relaxing it once turned such a document into
 * four entries with three empty bodies. This splits only a **run** of at least 12 consecutive
 * non-blank lines, wherever that run sits, and every piece it makes is non-empty by construction.
 *
 * 🔴 AND THE FIRST VERSION OF IT WAS TOO NARROW, WHICH THE HARNESS CAUGHT THE SAME HOUR. It fired only
 * when the WHOLE document was one block with no blank line anywhere — and the statement in
 * `tools/judge-answers.mjs` has a blank line after its opening paragraph, so nothing split and the
 * document was still one note. Real statements have section breaks AND a solid run of transactions.
 * So the rule is about the RUN, not about the document.
 */
export const LINE_RUN_MIN_LINES = 12;

/** How many lines go into one group — about ten records, which is a note a reader can recognise. */
export const LINE_RUN_GROUP_LINES = 10;

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
    //     the line beneath ending in a full stop, holding a date, or naming a section.
    //  2. A heading ALONE in its own paragraph, with a body in the next one. This is the
    //     shape almost every real document uses:
    //         EXPERIENCE
    //         <blank>
    //         Senior Software Engineer, …
    //     and missing it collapsed an entire resume into a single entry.
    //  3. A title line followed by a date line — how a resume writes a job, and how a
    //     list of fragments never reads.
    //
    // `isBodyOf` is the guard that keeps a document of short standalone lines whole —
    // see the note on it in text.ts, and the failure on George's own resume that made
    // it necessary.
    const nextBlock = blockList[position + 1] as { text: string } | undefined;
    const startsEntry =
      blockLines.length > 1
        ? looksLikeHeadingCandidate(first) &&
          (endsInPunctuation(body) ||
            isSectionName(first) ||
            (body !== null && findDates(body, null).length > 0))
        : looksLikeHeadingCandidate(first) &&
          nextBlock !== undefined &&
          isBodyOf(nextBlock.text, first);

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

  const splitEntries = splitLineRun(rawEntries);

  const entries: Entry[] = splitEntries.map((entry, index) => {
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
      // The other half of the entry's dates: the END of a period, when one is written with a range
      // word. Read from the same body, by the same parser, so the start and the end cannot
      // disagree about what the document says.
      ...entryPeriod(body, year),
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

/**
 * Split one solid run of many short lines into groups of lines — see `LINE_RUN_MIN_LINES`.
 *
 * The offsets matter and are computed rather than assumed: each group has to point at the exact slice
 * of the ORIGINAL text it came from, because `start` and `end` are what the page uses to place an
 * entry against the document. Each search starts where the previous one ended, so the groups can only
 * move forwards.
 */
function splitLineRun<Row extends { heading: string | null; text: string; start: number; end: number }>(
  raw: Row[]
): Row[] {
  const out: Row[] = [];
  for (const entry of raw) {
    const pieces = splitRuns(entry.text);
    if (pieces.length === 1) {
      out.push(entry);
      continue;
    }
    // Each piece points at the exact slice of the ORIGINAL text it came from — `start` and `end` are
    // what the page uses to place a note against the document — and the search for each one starts
    // where the previous ended, so the pieces can only move forwards.
    let cursor = 0;
    pieces.forEach((piece, at) => {
      const found = entry.text.indexOf(piece, cursor);
      const start = found === -1 ? entry.start : entry.start + found;
      cursor = (found === -1 ? cursor : found) + piece.length;
      out.push({
        // The heading belongs to the top of the entry and is not repeated on every piece: a label
        // that says the same thing on ten notes tells the reader nothing.
        heading: at === 0 ? entry.heading : null,
        text: piece,
        start,
        end: start + piece.length,
      } as Row);
    });
  }
  return out;
}

/**
 * Break a note's text into pieces: every run of at least `LINE_RUN_MIN_LINES` consecutive non-blank
 * lines is cut into groups of `LINE_RUN_GROUP_LINES`, and everything else is left exactly as written.
 *
 * Returns ONE piece — the text unchanged — when there is no such run, which is the case for every
 * entry of a diary or a resume, and for a list of fragments separated by blank lines.
 */
function splitRuns(text: string): string[] {
  // Every row with its own offsets into the ORIGINAL text; the pieces are SPANS of that text rather
  // than strings rebuilt from pieces, which is what turns "nothing is lost" into a property instead of
  // a hope. Three versions of this function failed their own check and refused to split, and each one
  // was right to: the first dropped the newline at every join, the second dropped the blank lines
  // between runs, and the third split a diary in two at every blank line — because it treated EVERY
  // run as a cut point instead of only a run long enough to be a record list.
  const rows: { start: number; end: number; blank: boolean }[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    rows.push({ start: at, end: at + line.length, blank: line.trim().length === 0 });
    at += line.length + 1; // the newline that followed it
  }

  // `end` is exclusive, and `+ 1` takes the newline that ended the row. `cutAfter` marks the only place
  // a note is allowed to end.
  const units: { start: number; end: number; cutAfter: boolean }[] = [];
  const add = (from: number, to: number, cutAfter: boolean): void => {
    units.push({ start: from, end: Math.min(text.length, to + 1), cutAfter });
  };

  let run: { start: number; end: number }[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const first = run[0] as { start: number };
    const last = run[run.length - 1] as { end: number };
    if (run.length < LINE_RUN_MIN_LINES) {
      // Too short to be a record list, so it is one unit and NEVER a cut point: two short paragraphs
      // either side of a blank line stay one note, exactly as they always were.
      add(first.start, last.end, false);
    } else {
      // Balanced groups rather than ten-and-a-tail: a fourteen-line run becomes 7 and 7.
      const groups = Math.ceil(run.length / LINE_RUN_GROUP_LINES);
      const per = Math.ceil(run.length / groups);
      for (let cut = 0; cut < run.length; cut += per) {
        const group = run.slice(cut, cut + per);
        add((group[0] as { start: number }).start, (group[group.length - 1] as { end: number }).end, true);
      }
    }
    run = [];
  };

  for (const row of rows) {
    if (row.blank) {
      flush();
      // The blank line belongs to the unit before it, so the spans still cover the whole text.
      const previous = units[units.length - 1];
      if (previous) previous.end = Math.min(text.length, row.end + 1);
      continue;
    }
    run.push({ start: row.start, end: row.end });
  }
  flush();

  if (!units.some((unit) => unit.cutAfter)) return [text];

  const pieces: string[] = [];
  let from = 0;
  for (const unit of units) {
    if (!unit.cutAfter) continue;
    pieces.push(text.slice(from, unit.end));
    from = unit.end;
  }
  if (from < text.length) pieces.push(text.slice(from));
  if (pieces.length <= 1) return [text];
  // 🔴 SPLITTING A DOCUMENT ONCE LOST MOST OF IT, so this checks its own work and refuses to change
  // anything at all if the pieces do not add back up to the text it was given.
  return pieces.join('') === text ? pieces : [text];
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
    endMonth: null,
    openEnded: false,
    text: entry.text,
    start: entry.start,
    end: entry.end,
  };
}

export { countWords };
