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
  details: AnswerDetails;
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
  mentions: { places: Mention[]; people: Mention[]; amounts: Mention[] };
  /** How many pictures the document pointed at. */
  imageCount: number;
}
