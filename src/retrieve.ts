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
}

/** Fuse two rankings by reciprocal rank. */
function fuse(
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
  if (!queryVector) throw new AppError('The embedding model returned nothing for the question.', 502);

  const lexicalRows = store.lexical(docId, question, LIST_DEPTH);
  if (lexicalRows.length === 0) {
    warnings.push('The keyword search found nothing — this answer rests on the meaning search alone.');
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
    return { question, scored: [], bestVector, silent: true, warnings, retrieveMs, rerankMs: 0 };
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
    }));

  return { question, scored, bestVector, silent: false, warnings, retrieveMs, rerankMs };
}
