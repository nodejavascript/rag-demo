/**
 * Retrieval, the facts, the model, and the details that go beside the answer.
 *
 * The shape of a reply is deliberate: the prose is what the model wrote, and
 * everything next to it — the dates, the places, the people, the pictures, the score
 * each note earned — is what the program found. A reader can therefore check the
 * answer two ways: against the notes quoted underneath, and against the counts and
 * mentions that were taken over the whole document rather than over the eight notes
 * the model happened to be shown.
 *
 * A refusal is never dressed up. When the search finds nothing, the model is not
 * called at all: the refusal is a fact about the document, computed in milliseconds,
 * and paying a model to agree with it would only add a chance of it disagreeing.
 */

import { tally } from './enrich.js';
import { buildSpine, type Spine } from './charts.js';
import { buildMessages, isNothingFurther, isRefusal, readShape } from './prompt.js';
import { retrieve, type RetrieveOptions } from './retrieve.js';
import { factsFor } from './stats.js';
import { analyseGaps } from './gaps.js';
import { analyseConflicts } from './conflicts.js';
import { AppError, type Answer, type AnswerDetails, type ComputedFact, type Mention, type Scored, type Source } from './types.js';
import type { Store } from './store.js';
import type { Model } from './model.js';

export interface AnswerOptions {
  retrieve?: RetrieveOptions;
  /** Raise the sampling away from 0 when the words matter more than the repeatability. */
  temperature?: number;
}

/**
 * How much sampling an answer gets.
 *
 * 🔴 **ZERO — RAISED TO 0.3 ON 20 Sep 2026 AND PUT BACK THE SAME DAY, AND THE REASON IS NOT
 * THE ONE IT LOOKS LIKE.** George asked for answers that stop sounding robotic and expand
 * on what they output. Greedy decoding *was* part of why they read like a form — every
 * multi-note question came back as *"cold on 4 March 2026, and rain on 18 March 2026, and
 * frost on 26 March 2026"* — so sampling went up, and the prose did improve.
 *
 * **Then the diary's weather question came back with a fact that is not in the diary:**
 * *"cold on 4 March and 22 March … the weather got cold again on 22 March"*. The 22 March
 * entry is about a cottage and a deposit and says nothing about weather. So the sampling
 * went back to 0 — **and the measurement that matters is that at 0 the invented day was
 * STILL THERE.** Sampling was not what caused it. The cause was the prompt, in rules 13 and
 * 14, which asked for surrounding detail and for notes to be joined into sentences, and so
 * pulled a neighbouring entry into a sentence about the weather. **Those rules were reverted
 * rather than reworded:** two attempts to keep the longer answer while forbidding the fault
 * both still produced it, so the rules are gone and the prompt is byte-for-byte the one that
 * answered correctly.
 *
 * Sampling stays at 0 on its own merits: it bought prose the prompt now produces anyway,
 * and this site's whole promise is that an answer can be checked against the document.
 */
export const DEFAULT_TEMPERATURE = 0;

function sourceOf(scored: Scored): Source {
  return {
    label: scored.chunk.label,
    date: scored.chunk.date,
    dateRaw: scored.chunk.dateRaw,
    text: scored.chunk.text,
    vector: scored.chunk ? scored.vector : 0,
    lexical: scored.lexical,
    fused: scored.fused,
    rerank: scored.rerank,
    both: scored.both,
  };
}

/**
 * The document as one row of cells, with the entries the answer was written from marked.
 *
 * The label is the entry's own heading where it has one, otherwise the date as the document
 * wrote it, otherwise the month it can be placed in, otherwise its position. Nothing here is
 * invented: every cell is an entry the indexer found, and `cited` is true only for entries
 * whose notes were actually handed to the model.
 */
function spineOf(entries: ReturnType<Store['entries']>, citedIndexes: number[]): Spine {
  return buildSpine(
    entries.map((entry) => ({
      index: entry.index,
      label: entry.heading?.trim() || entry.dateRaw?.trim() || entry.month || `Entry ${entry.index + 1}`,
      date: entry.date,
      month: entry.month,
    })),
    citedIndexes
  );
}

/** The dates, places, people, amounts and pictures the answer actually rests on. */
function detailsFrom(scored: Scored[]): AnswerDetails {
  const dates: AnswerDetails['dates'] = [];
  const seen = new Set<string>();
  const places: { value: string; entryIndex: number }[] = [];
  const people: { value: string; entryIndex: number }[] = [];
  const amounts: { value: string; entryIndex: number }[] = [];
  const images: AnswerDetails['images'] = [];

  for (const item of scored) {
    const chunk = item.chunk;
    if (!seen.has(chunk.label)) {
      seen.add(chunk.label);
      dates.push({
        date: chunk.date,
        dateRaw: chunk.dateRaw,
        label: chunk.label,
        inferred: chunk.inferredYear,
      });
    }
    for (const value of chunk.places) places.push({ value, entryIndex: chunk.entryIndex });
    for (const value of chunk.people) people.push({ value, entryIndex: chunk.entryIndex });
    for (const value of chunk.amounts) amounts.push({ value, entryIndex: chunk.entryIndex });
    for (const image of chunk.images) {
      if (!images.some((other) => (other.url ?? '') === (image.url ?? '') && other.caption === image.caption)) {
        images.push(image);
      }
    }
  }

  const dated = scored.map((item) => item.chunk.date).filter((date): date is string => date !== null).sort();

  return {
    dates: dates.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999')),
    places: tally(places).slice(0, 12),
    people: tally(people).slice(0, 12),
    amounts: tally(amounts).slice(0, 12),
    images: images.slice(0, 12),
    first: dated[0] ?? null,
    last: dated[dated.length - 1] ?? null,
  };
}

export async function answer(
  store: Store,
  model: Model,
  docId: string,
  question: string,
  options: AnswerOptions = {}
): Promise<Answer> {
  const started = Date.now();
  const document = store.getDocument(docId);
  if (!document) {
    throw new AppError('That document is no longer here. It may have expired, or been deleted.', 404);
  }

  const retrieval = await retrieve(store, model, docId, question, options.retrieve);
  const warnings = [...retrieval.warnings];

  // Read once, here, because both paths need it: the refusal draws the same spine, with
  // nothing marked on it — which is a true picture of a document that answered nothing.
  const entries = store.entries(docId);

  // Computed once, over the document's whole text, and attached to BOTH a refusal and a
  // grounded answer — a refusal is where it is worth the most, because it turns "the
  // document does not say" into the reason why.
  const gaps = analyseGaps({
    question,
    documentText: store.documentText(docId),
    mentions: document.mentions,
  });

  // Also computed, and also attached to both paths: a document that contradicts itself is
  // worth knowing before you read any answer it gives.
  const conflicts = analyseConflicts({
    entries: store.entries(docId),
    mentions: document.mentions,
    documentText: store.documentText(docId),
  });

  if (retrieval.silent) {
    return {
      question,
      raw: '',
      prose: '',
      mode: 'refused',
      sources: [],
      gaps,
      conflicts,
      details: {
        dates: [],
        places: [],
        people: [],
        amounts: [],
        images: [],
        first: document.stats.firstDate,
        last: document.stats.lastDate,
      },
      computed: [],
      spine: spineOf(entries, []),
      timings: {
        retrieveMs: retrieval.retrieveMs,
        rerankMs: 0,
        modelMs: 0,
        totalMs: Date.now() - started,
      },
      warnings: [
        'Nothing in this document matched the question closely enough to answer from, so the model was not called. That is a fact from the search, in milliseconds.',
        ...warnings,
      ],
    };
  }

  const docText = entries.map((entry) => entry.text).join('\n\n');
  const computed = factsFor(question, entries, docText);

  const messages = buildMessages({
    question,
    notes: retrieval.scored.map((item) => ({
      label: item.chunk.label,
      date: item.chunk.date,
      dateRaw: item.chunk.dateRaw,
      text: item.chunk.text,
      places: item.chunk.places,
      people: item.chunk.people,
    })),
    facts: computed,
    stats: document.stats,
    assumedYear: document.stats.assumedYear,
  });

  const modelStarted = Date.now();
  const reply = await model.chat(messages, {
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    numCtx: 8192,
    numPredict: 700,
  });
  const modelMs = Date.now() - modelStarted;

  const refused = isRefusal(reply);
  const shape = readShape(reply);
  const prose = [shape.says, isNothingFurther(shape.suggests) ? null : shape.suggests]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');

  const sources = retrieval.scored.map(sourceOf);

  return {
    question,
    raw: reply,
    prose: refused ? '' : prose || reply,
    mode: refused ? 'refused' : 'grounded',
    sources,
    gaps,
    conflicts,
    details: detailsFrom(retrieval.scored),
    computed: refused ? [] : computed,
    spine: spineOf(
      entries,
      retrieval.scored.map((item) => item.chunk.entryIndex)
    ),
    timings: {
      retrieveMs: retrieval.retrieveMs,
      rerankMs: retrieval.rerankMs,
      modelMs,
      totalMs: Date.now() - started,
    },
    warnings,
  };
}

export { detailsFrom };
export type { ComputedFact, Mention };
