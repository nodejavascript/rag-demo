/**
 * Shared types. One place, so the parser, the store, the retriever and the
 * answerer cannot disagree about the shape of a note.
 */

export class AppError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

/** An entry: one dated block of the document, as the writer wrote it. */
export interface Entry {
  index: number;
  /** The heading line exactly as written, or null when the block had none. */
  heading: string | null;
  /** `YYYY-MM-DD` when the day is genuinely known. Null when it is not. */
  date: string | null;
  /** Whatever was written for the date, unedited — "Tuesday 4 March". */
  dateRaw: string | null;
  /** True when the year was worked out from other entries rather than written. */
  inferredYear: boolean;
  /** True when the number order could be read two ways and was left alone. */
  ambiguousDate: boolean;
  /** True when a month and year were written but no day. */
  monthOnly: boolean;
  /**
   * `YYYY-MM` when enough was written to place this entry on a timeline — a full
   * date, or a month and a year. It is NOT a date and is never rendered as one.
   */
  month: string | null;
  /**
   * `YYYY-MM` for the END of a period the entry states — `July 2021 to September 2026`.
   *
   * 🔴 A RESUME IS NOT A DIARY. One timeline serves both: an entry that writes a period gets a bar
   * whose width IS that period, and an entry that writes one day stays a point. Null whenever the
   * entry states no end — and null is the honest answer, never a guess.
   */
  endMonth: string | null;
  /** True when the period was written as still running — `July 2021 to Present`. */
  openEnded: boolean;
  /** The body, with the heading removed. */
  text: string;
  start: number;
  end: number;
}

/** Something a note mentions, found by code and never by the model. */
export interface Mention {
  /** The text exactly as it was written. */
  value: string;
  /** How many times it occurs across the whole document. */
  count: number;
  /** Which entry each occurrence came from. */
  entries: number[];
}

/** An image the document points at. Only a URL is followed, never a bare word. */
export interface ImageRef {
  /** Absolute URL, or a data URI, or null when only a caption was written. */
  url: string | null;
  /** The alt text or caption, when there was one. */
  caption: string | null;
  /** The entry it appeared in. */
  entryIndex: number;
}

/** Everything a note carries besides its text. All of it computed in code. */
export interface NoteMeta {
  places: string[];
  people: string[];
  images: ImageRef[];
  amounts: string[];
}

/** A retrievable note: an entry, or one part of a long entry. */
export interface Chunk extends NoteMeta {
  id: number;
  entryIndex: number;
  /** Which part of the entry this is, from 0. */
  part: number;
  parts: number;
  date: string | null;
  dateRaw: string | null;
  inferredYear: boolean;
  heading: string | null;
  /** What to call this note in the answer and in the source list. */
  label: string;
  text: string;
  start: number;
  end: number;
  words: number;
}

/** A scored search result. */
export interface Scored {
  chunk: Chunk;
  /** 0..1 cosine similarity of the embeddings. */
  vector: number;
  /** Raw BM25 score, negative, lower is better — SQLite's own convention. */
  lexical: number;
  /** 1-based position in the vector ranking, or 0 if it was not in the top slice. */
  vectorRank: number;
  /** 1-based position in the lexical ranking, or 0 if it was not in the top slice. */
  lexicalRank: number;
  /** Reciprocal-rank-fusion score, which is what the results are ordered by. */
  fused: number;
  /** True when both searches ranked this note, which is the strongest signal there is. */
  both: boolean;
  /** A cross-encoder's relevance score, when a reranker was available. */
  rerank: number | null;
}

/** A fact counted by code over the WHOLE document, never by the model. */
export interface ComputedFact {
  kind: 'count' | 'date-range' | 'total' | 'first-last' | 'absent' | 'months';
  /** The word or phrase the fact is about, when the fact is a count. */
  term?: string;
  value: number | string;
  first?: string | null;
  last?: string | null;
  entries?: number;
}

export interface IndexStats {
  characters: number;
  words: number;
  entries: number;
  datedEntries: number;
  /** Entries placed on the timeline by a month and a year, with no day written. */
  monthPrecision: number;
  inferredYears: number;
  ambiguousDates: number;
  chunks: number;
  firstDate: string | null;
  lastDate: string | null;
  months: number;
  /** Entries per `YYYY-MM`, oldest first — what the timeline chart draws. */
  perMonth: { month: string; entries: number }[];
  /** The year the reader supplied, when the document writes none. */
  assumedYear: boolean;
  yearUsed: number | null;
  embeddingMs: number;
  /**
   * How long each stage of the index took, in milliseconds — **measured as it ran, never
   * estimated**, the same way every other figure on this page is.
   *
   * 🔴 OPTIONAL ON PURPOSE. A document indexed before this field existed has no timings, and the
   * chart that draws them hides itself rather than drawing three zeroes: **an empty chart and a
   * chart whose stages really took no time look the same on screen and mean opposite things.**
   * That is the same rule the funnel follows when a stage did not run.
   */
  stageMs?: { reading: number; embedding: number; saving: number };
}

/** The details a note carries, gathered for the whole answer. */
export interface AnswerDetails {  dates: { date: string | null; dateRaw: string | null; label: string; inferred: boolean }[];
  places: Mention[];
  people: Mention[];
  amounts: Mention[];
  images: ImageRef[];
  /** The span the used notes cover. */
  first: string | null;
  last: string | null;
}

export interface Source {
  label: string;
  date: string | null;
  dateRaw: string | null;
  text: string;
  vector: number;
  lexical: number;
  fused: number;
  rerank: number | null;
  both: boolean;
}

/**
 * What the document does NOT say, counted in code over its whole text. See `gaps.ts`.
 *
 * It lives here with the other shared shapes rather than in `gaps.ts` so that `types.ts`
 * does not have to import from a module that imports from it.
 */
export interface GapReport {
  /** Words the question used that appear nowhere in the document, capped for the page. */
  absent: string[];
  /** How many there were before that cut, so the page can say "and N more". */
  absentTotal: number;
  /** How many of the question's content words the document does hold. */
  presentCount: number;
  /** Things the answer rests on that the whole document says exactly once. */
  once: { value: string; kind: string }[];
}

/**
 * Where the document disagrees with itself, counted in code. See `conflicts.ts`.
 *
 * Lives here with the other shared shapes for the same reason `GapReport` does — so that
 * `types.ts` does not import from a module that imports from it.
 */
export interface ConflictReport {
  /** Entries whose date runs backwards against the entry before them. */
  outOfOrder: { at: number; label: string; date: string; previousDate: string; previousLabel: string }[];
  /** The same word written two different ways — a fact about spelling, not identity. */
  spelledTwoWays: { a: string; b: string; kind: string }[];
  /** Dates the parser refused to resolve, quoted as written. */
  ambiguous: { label: string; raw: string }[];
}

import type { FunnelStage, MentionMonths, Spine } from './charts.js';

export interface Answer {
  question: string;
  /** The model's reply as it came back, before it was read into shape. */
  raw: string;
  /** The answer as the reader sees it, without the contract's headings. */
  prose: string;
  /** `grounded` when the model wrote it, `refused` when nothing matched. */
  mode: 'grounded' | 'refused';
  sources: Source[];
  /**
   * What the document does NOT say — counted in code over its whole text, never generated.
   * See `gaps.ts`. Shown beside the answer precisely because it is not the model's word.
   */
  gaps: GapReport;
  /**
   * Where the document disagrees with itself — also counted in code. See `conflicts.ts`.
   */
  conflicts: ConflictReport;
  details: AnswerDetails;
  /**
   * The whole document as one row of cells, with the entries this answer was written from
   * marked — so a reader can see whether it came from one passage or from all over. Built
   * in code from the entries and the notes that were actually retrieved. See `charts.ts`.
   */
  spine: Spine;
  /**
   * How the whole document became the handful of notes the model was shown — each number
   * counted by the stage that produced it, and a stage that did not run left out rather
   * than drawn as a zero. See `buildFunnel`.
   */
  funnel: FunnelStage[];
  /** Facts counted in code over the whole document. */
  computed: ComputedFact[];
  /** How long each stage took, in milliseconds. */
  timings: { retrieveMs: number; rerankMs: number; modelMs: number; totalMs: number };
  /** Anything the reader must know — a missing reranker, a truncated document. */
  warnings: string[];
}

/** What a stored document looks like from outside. */
export interface DocumentView {
  id: string;
  title: string;
  characters: number;
  words: number;
  createdAt: string;
  expiresAt: string | null;
  stats: IndexStats;
  /**
   * The document's places, people and amounts, tallied over the whole of it.
   *
   * Carried on the document rather than recomputed by the page, because a second
   * implementation of a count is a second chance for the two to disagree — and the
   * reader would have no way to tell which of them was wrong.
   */
  mentions: {
    places: Mention[];
    people: Mention[];
    amounts: Mention[];
    /**
     * Who and what appears WHEN — the same mentions, laid out over the document's own
     * months, counted at index time by the code that produced the tally above. See
     * `buildMentionMonths`. Absent on a document indexed before this existed.
     */
    byMonth?: MentionMonths;
  };
  /** How many pictures the document pointed at. */
  imageCount: number;
}
