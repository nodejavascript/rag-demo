/**
 * From a paste to a searchable document.
 *
 * The order is fixed and each step depends on the one before: normalise the text,
 * build the entries, take the details out of them, embed the notes, write it all
 * down. Embedding is the only slow part — roughly eight seconds for a 25-page diary
 * on a local model — and it is the only part that costs money on a hosted one.
 *
 * Two limits are enforced here rather than discovered later: a paste that is too
 * short has nothing to answer from, and a paste that is too long would put a worse
 * experience in front of a reader than a plain refusal to accept it. The second one
 * is a product decision, and the message says exactly what the limit is.
 */

import { createHash } from 'node:crypto';
import { build } from './chunk.js';
import { guessTitle, prepare } from './text.js';
import { newDocumentId, nowIso, Store, type DocumentRecord } from './store.js';
import { AppError, type DocumentView, type IndexStats } from './types.js';
import { buildMentionMonths, continuousMonths } from './charts.js';
import type { Model } from './model.js';

/** Shortest paste worth indexing, and the longest one accepted. */
export const MIN_CHARS = 200;
export const MAX_CHARS = Number.parseInt(process.env.MAX_DOCUMENT_CHARS ?? '400000', 10);

/** How long an anonymous paste is kept before it is swept away. */
export const DEFAULT_TTL_HOURS = Number.parseFloat(process.env.DOC_TTL_HOURS ?? '24');

export interface IndexInput {
  text: string;
  title?: string | null;
  sourceName?: string | null;
  yearHint?: number | null;
  ttlHours?: number;
}

export interface IndexResult {
  document: DocumentView;
  /** True when an identical paste was already indexed and was not indexed again. */
  reused: boolean;
  warnings: string[];
}

/**
 * The version of everything that turns a paste into an index.
 *
 * 🔴 This is in the fingerprint on purpose, and leaving it out is a bug that has now
 * been paid for twice. The fingerprint used to hash only the text and the embedding
 * model — so a document indexed with an OLD splitter, or before a column existed, was
 * still considered "already indexed" and was served from the cache forever. The
 * symptom is the worst kind: the fix is deployed, the answer is still wrong, and
 * nothing in the code looks wrong. **Bump this whenever the chunker, the date parser,
 * the enrichment or the stored schema changes.**
 */
export const PIPELINE_VERSION = 5;

export function fingerprintOf(text: string, embedModel: string): string {
  return createHash('sha256').update(`${PIPELINE_VERSION}\u0000${embedModel}\u0000${text}`).digest('hex');
}

export async function indexDocument(
  store: Store,
  model: Model,
  input: IndexInput
): Promise<IndexResult> {
  const warnings: string[] = [];
  const prepared = prepare(input.text ?? '');

  if (prepared.text.length < MIN_CHARS) {
    throw new AppError(
      `That is ${prepared.text.length} characters. Paste at least ${MIN_CHARS} — there has to be ` +
        `something to answer from.`,
      400
    );
  }
  if (prepared.text.length > MAX_CHARS) {
    throw new AppError(
      `That is ${prepared.text.length.toLocaleString()} characters, over the ${MAX_CHARS.toLocaleString()} ` +
        `limit. Split it and ask about one part at a time — an index this size would be slow to search and ` +
        `would crowd out the other sites on this machine.`,
      413
    );
  }

  const fingerprint = fingerprintOf(prepared.text, model.config.embedModel);
  const existing = store.findByFingerprint(fingerprint);
  if (existing) {
    const document = store.getDocument(existing);
    // A stored document with no mentions at all cannot be trusted to have been built
    // by this pipeline, so it is rebuilt rather than served from the cache.
    const usable = document && (document.stats.entries === 0 || document.mentions.places.length + document.mentions.people.length + document.mentions.amounts.length > 0);
    if (document && usable) {
      return {
        document,
        reused: true,
        warnings: ['This text was already indexed, so the existing index was reused.'],
      };
    }
    store.deleteDocument(existing);
  }

  const built = build(prepared.text, input.yearHint ?? null, prepared.images);

  if (built.stats.entries === 0 || built.chunks.length === 0) {
    throw new AppError('Nothing in that text could be read as an entry. Is it really text?', 400);
  }
  if (built.stats.perMonth.length === 0) {
    warnings.push(
      'Nothing in this text can be placed on a timeline — no entry writes a month and a year together. The tool will not guess one.'
    );
  } else if (built.stats.datedEntries === 0) {
    warnings.push(
      'No entry writes a complete date (a day, a month and a year), so nothing here can be quoted as a particular day. The timeline places entries by month and year only, which is all the document says.'
    );
  }
  if (built.stats.ambiguousDates > 0) {
    warnings.push(
      `${built.stats.ambiguousDates} date is written in a form that can be read two ways, such as 06/03/2026. It is quoted as written and left alone.`
    );
  }

  const started = Date.now();
  const vectors = await model.embed(built.chunks.map((chunk) => searchableText(chunk.heading, chunk.text)));
  const embeddingMs = Date.now() - started;

  const stats: IndexStats = { ...built.stats, embeddingMs };

  const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS;
  const createdAt = nowIso();
  const expiresAt = ttlHours > 0 ? new Date(Date.now() + ttlHours * 3600_000).toISOString() : null;

  const record: DocumentRecord = {
    id: newDocumentId(),
    title: (input.title?.trim() || guessTitle(prepared.text)).slice(0, 200),
    sourceName: input.sourceName ?? null,
    fingerprint,
    createdAt,
    expiresAt,
    stats,
    // The mention grid is built here, at index time, from the notes the indexer itself
    // extracted — never recomputed later by a second implementation that could disagree
    // with the tally beside it on the same page. Only the top few are kept: a heat map is
    // for the things that recur, and eight rows is all a chart can show.
    mentions: {
      places: built.places,
      people: built.people,
      amounts: built.amounts,
      byMonth: buildMentionMonths(
        built.chunks,
        continuousMonths(built.stats.perMonth, built.stats.firstDate, built.stats.lastDate).map(
          (point) => point.month
        ),
        built.entries,
        [
          ...built.people.slice(0, 3).map((mention) => ({ value: mention.value, kind: 'person' as const })),
          ...built.places.slice(0, 3).map((mention) => ({ value: mention.value, kind: 'place' as const })),
          ...built.amounts.slice(0, 2).map((mention) => ({ value: mention.value, kind: 'amount' as const })),
        ]
      ),
    },
    imageCount: built.images.length,
    entries: built.stats.entries,
  };

  store.insert(record, built.entries, built.chunks, vectors);

  const document = store.getDocument(record.id);
  if (!document) throw new AppError('The document was written but could not be read back.', 500);

  return { document, reused: false, warnings };
}

/**
 * What gets embedded.
 *
 * The heading is put back in front for the embedding only — a diary writes its date
 * in the heading, and without it a question about a date has nothing in the vector
 * to match against. The note's own text is unchanged, so what the reader is shown is
 * still exactly what was written.
 */
export function searchableText(heading: string | null, text: string): string {
  if (!heading) return text;
  return text.startsWith(heading) ? text : `${heading}\n${text}`;
}
