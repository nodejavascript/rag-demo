/**
 * Two searches, fused, and — when the provider has one — a cross-encoder on top.
 *
 * Neither half alone is good enough. A vector search finds a note that says the same
 * thing in different words but happily returns the nearest note in the document even
 * when nothing is close; a keyword search finds the exact name or date but misses a
 * paraphrase. So the question is asked both ways and the two rankings are fused by
 * reciprocal rank, which needs no calibration between two scores that have no
 * common scale — it only looks at where each result placed.
 *
 * The refusal is measured, not felt. An embedding always reports *some* similarity,
 * so the question "is this document about this at all?" has to be answered against a
 * noise floor rather than against zero. Run `npm run calibrate` to measure the floor
 * for a given embedding model — **a different model needs it measured again.**
 */

import { AppError, type Scored } from './types.js';
import { expandQuery } from './intent.js';
import { findDates } from './dates.js';
import { Store, type StoredChunk } from './store.js';
import type { Model } from './model.js';

/** The rank constant. 60 is the value from the original reciprocal-rank paper. */
const RRF_K = 60;

/** How deep each list goes before fusion. */
const LIST_DEPTH = 60;

/** How many notes are handed to the reranker, and how many survive it. */
const RERANK_IN = 30;
const FINAL_NOTES = 8;

export interface RetrieveOptions {
  /** Cosine below which, with no keyword hit at all, the document is judged silent. */
  refusalFloor: number;
  /** Whether to spend the extra call on a cross-encoder when one is configured. */
  useRerank: boolean;
}

export const DEFAULT_RETRIEVE: RetrieveOptions = {
  refusalFloor: Number.parseFloat(process.env.REFUSAL_FLOOR ?? '0.56'),
  useRerank: process.env.RERANK_MODEL !== '',
};

/**
 * How much of a document may be handed to the model when the question asks for a list.
 *
 * Characters, not notes, because that is what the model's window is measured in: the answer call
 * runs at `numCtx: 8192` and leaves 700 tokens for the reply, so 18,000 characters of notes (about
 * 4,500 tokens) leaves room for the rules and the facts. A document longer than this gets its first
 * notes in document order and is TOLD it is reading part of the document — see the warning below.
 */
export const WHOLE_BUDGET_CHARS = Number.parseInt(process.env.WHOLE_BUDGET_CHARS ?? '18000', 10);

export interface RetrieveResult {
  question: string;
  scored: Scored[];
  /** The best cosine anywhere in the document — what the floor is compared to. */
  bestVector: number;
  /** True when nothing matched well enough to be worth a model call. */
  silent: boolean;
  warnings: string[];
  retrieveMs: number;
  rerankMs: number;
  /** How many notes the two searches proposed between them, before any cut. */
  ranked: number;
  /** How many the reranker actually scored — **undefined when no reranker ran at all**,
   * because a stage that never happened must not be drawn as a stage that found nothing. */
  reranked: number | undefined;
}

/**
 * Put a note that IS the date the question asked about in front of the rest.
 *
 * 🔴 WHY THIS IS NEEDED, MEASURED. Asked **"What happened on 6 March 2026?"**, the note
 * that is 6 March scored **0.536 and came LAST of the eight notes offered**, behind
 * 2 April at **0.583**. That is not a bug in the embedding — the entries of a diary are
 * written alike, so every one of them lands within about a tenth of every other, and the
 * order among them is close to arbitrary. The model was handed the right note last and
 * answered with the right event and no date at all.
 *
 * A date written in a question is the least ambiguous thing in the whole request, and the
 * meaning search throws it away. So it is used here instead: a note whose own date equals
 * a date in the question is lifted to the front.
 *
 * **This computes nothing and invents nothing.** It re-orders notes that were already
 * found, which is exactly why it cannot make the model assert something the document does
 * not say — the same safety argument as the query expansion in `intent.ts`.
 */
function byAskedDate(a: Scored, b: Scored, asked: Set<string>): number {
  const aHit = a.chunk.date !== null && asked.has(a.chunk.date) ? 1 : 0;
  const bHit = b.chunk.date !== null && asked.has(b.chunk.date) ? 1 : 0;
  // Array.prototype.sort is stable, so notes that tie keep the ranking they were given.
  return bHit - aHit;
}

/** Fuse two rankings by reciprocal rank. */function fuse(
  vectorRank: Map<number, number>,
  lexicalRank: Map<number, number>
): Map<number, { fused: number; both: boolean }> {
  const out = new Map<number, { fused: number; both: boolean }>();
  const bump = (id: number, rank: number, other: Map<number, number>): void => {
    const entry = out.get(id) ?? { fused: 0, both: false };
    entry.fused += 1 / (RRF_K + rank);
    if (other.has(id)) entry.both = true;
    out.set(id, entry);
  };
  for (const [id, rank] of vectorRank) bump(id, rank, lexicalRank);
  for (const [id, rank] of lexicalRank) bump(id, rank, vectorRank);
  for (const entry of out.values()) if (entry.both) entry.fused += 1 / (2 * RRF_K);
  return out;
}

export async function retrieve(
  store: Store,
  model: Model,
  docId: string,
  question: string,
  options: RetrieveOptions = DEFAULT_RETRIEVE
): Promise<RetrieveResult> {
  const started = Date.now();
  const warnings: string[] = [];

  if (!question.trim()) throw new AppError('Ask a question first.', 400);

  const [queryVector] = await model.embed([question]);
  if (!queryVector) throw new AppError('The embedding model returned nothing for the question.', 503);

  // The question's own words, plus the words a document is likely to have used instead —
  // "school" for EDUCATION, "now" for Present. Only the word search is widened: the
  // embedding and the refusal floor above it stay exactly as calibrated.
  const intentTerms = expandQuery(question);
  // A date the question names outright. Only a complete date counts — "March 2026" or an
  // ambiguous `06/03/2026` identifies no single day, so it lifts nothing.
  const askedDates = new Set(
    findDates(question)
      .map((hit) => hit.date)
      .filter((date): date is string => date !== null)
  );  const lexicalRows = store.lexical(docId, question, LIST_DEPTH, intentTerms);
  if (lexicalRows.length === 0) {
    warnings.push('The keyword search found nothing — this answer rests on the meaning search alone.');
  } else if (intentTerms.length > 0) {
    warnings.push(`Searched for ${intentTerms.slice(0, 6).join(', ')} as well, because the document may use those words.`);
  }

  const vectorRows = store
    .vector(docId, queryVector)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIST_DEPTH);
  const bestVector = vectorRows[0]?.score ?? 0;

  const vectorRank = new Map<number, number>();
  vectorRows.forEach((row, at) => vectorRank.set(row.chunkId, at + 1));
  const lexicalRank = new Map<number, number>();
  lexicalRows.forEach((row, at) => lexicalRank.set(row.chunkId, at + 1));

  const fused = fuse(vectorRank, lexicalRank);
  const ranked = [...fused.entries()]
    .map(([chunkId, entry]) => ({
      chunkId,
      fused: entry.fused,
      both: entry.both,
      vector: vectorRows.find((row) => row.chunkId === chunkId)?.score ?? 0,
      lexical: lexicalRows.find((row) => row.chunkId === chunkId)?.score ?? 0,
      vectorRank: vectorRank.get(chunkId) ?? 0,
      lexicalRank: lexicalRank.get(chunkId) ?? 0,
    }))
    .sort((a, b) => b.fused - a.fused);

  // Nothing matched by word and nothing matched by meaning: the document is silent,
  // and saying so from the search is instant and certain. No model call is made.
  const silent = lexicalRows.length === 0 && bestVector < options.refusalFloor;

  const retrieveMs = Date.now() - started;

  if (silent) {
    return { question, scored: [], bestVector, silent: true, warnings, retrieveMs, rerankMs: 0, ranked: 0, reranked: undefined };
  }

  const candidates = ranked.slice(0, options.useRerank ? RERANK_IN : FINAL_NOTES);
  const chunks = store.chunksByIds(candidates.map((candidate) => candidate.chunkId));

  let rerankMs = 0;
  let rerankScores: number[] | null = null;
  if (options.useRerank && candidates.length > 1 && model.rerankAvailable) {
    const rerankStarted = Date.now();
    rerankScores = await model.rerank(
      question,
      candidates.map((candidate) => chunks.get(candidate.chunkId)?.text ?? '')
    );
    rerankMs = Date.now() - rerankStarted;
    if (rerankScores === null) {
      warnings.push('The reranker did not answer, so the ranking is the fused one.');
    }
  }

  const withRerank = candidates.map((candidate, at) => ({
    candidate,
    chunk: chunks.get(candidate.chunkId),
    rerank: rerankScores ? (rerankScores[at] ?? null) : null,
  }));

  const ordered = rerankScores
    ? [...withRerank].sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0))
    : withRerank;

  const scored: Scored[] = ordered
    .slice(0, FINAL_NOTES)
    .filter((row): row is { candidate: (typeof withRerank)[number]['candidate']; chunk: StoredChunk; rerank: number | null } =>
      Boolean(row.chunk)
    )
    .map((row) => ({
      chunk: row.chunk,
      vector: row.candidate.vector,
      lexical: row.candidate.lexical,
      vectorRank: row.candidate.vectorRank,
      lexicalRank: row.candidate.lexicalRank,
      fused: row.candidate.fused,
      both: row.candidate.both,
      rerank: row.rerank,
    }))
    .sort((a, b) => byAskedDate(a, b, askedDates));

  if (askedDates.size > 0) {
    const lifted = scored.filter((note) => note.chunk.date && askedDates.has(note.chunk.date)).length;
    if (lifted > 0) {
      warnings.push(
        `The question names a date, so ${lifted === 1 ? 'the note dated it' : `${lifted} notes dated it`} ${lifted === 1 ? 'was' : 'were'} put first.`
      );
    }
  }

  return { question, scored, bestVector, silent: false, warnings, retrieveMs, rerankMs, ranked: ranked.length, reranked: rerankScores ? candidates.length : undefined };
}

/**
 * Retrieve by STRUCTURE instead of by similarity: every note, in the document's own order.
 *
 * 🔴 **THIS IS THE FIX FOR *"Which employers and job titles are named?"* ANSWERING WITH FOUR**
 * **EMPLOYERS OUT OF TWELVE** — the whole story is in `scope.ts`. The short version: similarity
 * search cannot answer a question about a set, because the answer is not the notes that match the
 * words, it is every note that holds one of the things asked for. The eight best-matching notes of a
 * 20-note resume held four employer names; the other nine were never shown to the model.
 *
 * What this function does NOT do, and must not:
 *   · it does not score anything differently — the cosine for every note is still measured and still
 *     drawn, so the "how well each note matched" chart stays honest and still shows that a list
 *     question matches its own document only weakly;
 *   · it does not count anything — the facts section is unchanged, and the model is still forbidden
 *     to add up;
 *   · it does not hide the difference. The warning says the whole document was read, or says exactly
 *     how much of it was, and the prompt tells the model the same thing in the same words.
 *
 * A document bigger than `WHOLE_BUDGET_CHARS` is read from the top, in order, and the warning and
 * the prompt both say how many of how many notes were used — because a partial list presented as a
 * complete one is the exact failure this whole path exists to end.
 */
export async function retrieveEverything(
  store: Store,
  model: Model,
  docId: string,
  question: string,
  options: RetrieveOptions = DEFAULT_RETRIEVE
): Promise<RetrieveResult> {
  const started = Date.now();

  // One embedding call, then a dot product against every note the document holds.
  const [query] = await model.embed([question]);
  if (!query) throw new AppError('The embedding model returned nothing for the question.', 503);
  const rows = store.vector(docId, query);
  const cosine = new Map(rows.map((row) => [row.chunkId, row.score]));
  const all = store.allChunks(docId);

  const kept: StoredChunk[] = [];
  let chars = 0;
  for (const chunk of all) {
    // At least one note is always kept, even when it alone is larger than the budget: an empty
    // context is a refusal, and refusing a question the page itself offered would be worse than a
    // short answer. The prompt is told the coverage either way.
    if (kept.length > 0 && chars + chunk.text.length > WHOLE_BUDGET_CHARS) break;
    kept.push(chunk);
    chars += chunk.text.length;
  }

  const scored: Scored[] = kept.map((chunk) => ({
    chunk,
    vector: cosine.get(chunk.id) ?? 0,
    lexical: 0,
    vectorRank: 0,
    lexicalRank: 0,
    fused: 0,
    both: false,
    rerank: null,
  }));

  const bestVector = rows.reduce((best, row) => Math.max(best, row.score), 0);
  const retrieveMs = Date.now() - started;

  // 🔴 A LIST QUESTION IS NOT REFUSED ON SIMILARITY, AND THAT IS A MEASURED DECISION.
  //
  // The first version of this function kept the matching path's refusal rule — nothing found by word
  // AND the best cosine below the floor — and `tools/judge-answers.mjs` immediately showed what that
  // costs. On a statement of accounts written for the tool, THREE of the four questions the page
  // itself offers were refused in 0.2 s with *"Nothing in this document matched the question closely
  // enough"*: **"Which payees or merchants are named?", "What amounts are listed?" and "What date
  // range does it cover?"** — on a document that lists eight payees, thirteen amounts and both ends
  // of a date range. The word *payee* is not in the document, the word *merchant* is not in it, and
  // a note the length of the whole statement dilutes its own cosine, so the search said "silent"
  // about a question the page had offered the reader.
  //
  // It is the same mistake as the one this path was built to fix, one layer down: **the search is
  // the wrong instrument for a question about what the document NAMES.** So on this path the
  // document is read, and the only thing that counts as silence is having nothing to read. The
  // prompt's own refusal rule does the rest — if the document really does not name any of them, the
  // model says so in one line, having actually looked.
  const silent = all.length === 0;

  const warnings = [
    kept.length === all.length
      ? `Your question asks for a list, so all ${all.length} notes of the document were read, in its own order — not the ${FINAL_NOTES} that matched best. A list answered from the best matches is a list with holes in it.`
      : `Your question asks for a list, and this document is longer than one model call can hold: the first ${kept.length} of its ${all.length} notes were read, in document order. The answer was told to say that the list may be incomplete.`,
  ];

  if (silent) {
    return { question, scored: [], bestVector, silent: true, warnings, retrieveMs, rerankMs: 0, ranked: all.length, reranked: undefined };
  }
  return { question, scored, bestVector, silent: false, warnings, retrieveMs, rerankMs: 0, ranked: all.length, reranked: undefined };
}
