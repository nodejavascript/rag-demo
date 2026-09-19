/**
 * Everything is kept in one SQLite file, and nothing needs installing to read it.
 *
 * The storage choice is forced by the host: the droplet that serves this has 1 GB of
 * RAM shared with nine other sites, so a vector server (Qdrant, pgvector) is a
 * non-starter and even a native SQLite binding is a build risk. Node ships SQLite
 * itself, and its build has **FTS5** — so the lexical half of the search is a real
 * BM25 index maintained by the database, and the vector half is a BLOB scan.
 *
 * Why a BLOB scan is not a compromise here: a note is 1024 floats, unit length, so a
 * cosine is a plain dot product, and 5,000 of them is five million multiply-adds —
 * about five milliseconds. The rows are read in pages so the whole set is never
 * resident; the peak cost of a search is one page, not the corpus.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './types.js';
import type { Chunk, DocumentView, Entry, IndexStats, ImageRef, Mention } from './types.js';

/** How many vector rows are read at a time during a scan. */
const VECTOR_PAGE = 2000;

export interface DocumentRecord {
  id: string;
  title: string;
  sourceName: string | null;
  fingerprint: string;
  createdAt: string;
  expiresAt: string | null;
  stats: IndexStats;
  mentions: { places: Mention[]; people: Mention[]; amounts: Mention[] };
  imageCount: number;
  entries: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A short, URL-safe, unpredictable id. Unpredictable matters: the id is the key. */
export function newDocumentId(): string {
  return randomBytes(9).toString('base64url');
}

export interface StoredChunk extends Chunk {
  documentId: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    // SQLite will not create the directory, and a first run on a fresh machine has
    // no `data/` yet — so make it here rather than making it somebody's setup step.
    if (path !== ':memory:') {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch {
        /* the open below reports the real problem with a better message */
      }
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        source_name  TEXT,
        fingerprint  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        expires_at   TEXT,
        stats_json   TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '{}',
        image_count  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        entry_index  INTEGER NOT NULL,
        part         INTEGER NOT NULL,
        parts        INTEGER NOT NULL,
        date         TEXT,
        date_raw     TEXT,
        inferred     INTEGER NOT NULL DEFAULT 0,
        heading      TEXT,
        label        TEXT NOT NULL,
        text         TEXT NOT NULL,
        start        INTEGER NOT NULL,
        end          INTEGER NOT NULL,
        words        INTEGER NOT NULL,
        places_json  TEXT NOT NULL DEFAULT '[]',
        people_json  TEXT NOT NULL DEFAULT '[]',
        amounts_json TEXT NOT NULL DEFAULT '[]',
        images_json  TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);

      CREATE TABLE IF NOT EXISTS entries (
        id          INTEGER PRIMARY KEY,
        doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        idx         INTEGER NOT NULL,
        heading     TEXT,
        date        TEXT,
        date_raw    TEXT,
        inferred    INTEGER NOT NULL DEFAULT 0,
        ambiguous   INTEGER NOT NULL DEFAULT 0,
        month_only  INTEGER NOT NULL DEFAULT 0,
        month       TEXT,
        text        TEXT NOT NULL,
        start       INTEGER NOT NULL,
        end         INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS entries_doc ON entries(doc_id);

      CREATE TABLE IF NOT EXISTS vectors (
        chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        doc_id   TEXT NOT NULL,
        dim      INTEGER NOT NULL,
        vec      BLOB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS vectors_doc ON vectors(doc_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, doc_id UNINDEXED, chunk_id UNINDEXED
      );
    `);

    // `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
    // column added later never arrives on a database that has already been used. That
    // is exactly how this broke once — the deploy had a document in it and every
    // index call failed with "no such column". Add the missing columns explicitly.
    this.#ensureColumn('documents', 'mentions_json', "TEXT NOT NULL DEFAULT '{}'");
    this.#ensureColumn('documents', 'image_count', 'INTEGER NOT NULL DEFAULT 0');
    this.#ensureColumn('entries', 'month', 'TEXT');
  }

  /** Add a column only when it is genuinely absent. */
  #ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** Insert a document, all of its entries and all of its notes in one transaction. */
  insert(record: DocumentRecord, entries: Entry[], chunks: Chunk[], vectors: Float64Array[]): void {
    if (chunks.length !== vectors.length) {
      throw new AppError('The notes and their vectors do not line up — refusing to index.', 500);
    }
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO documents (id, title, source_name, fingerprint, created_at, expires_at, stats_json,
                                  mentions_json, image_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.title,
          record.sourceName,
          record.fingerprint,
          record.createdAt,
          record.expiresAt,
          JSON.stringify(record.stats),
          JSON.stringify(record.mentions),
          record.imageCount
        );

      const insertEntry = this.db.prepare(
        `INSERT INTO entries (doc_id, idx, heading, date, date_raw, inferred, ambiguous, month_only, month, text, start, end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const entry of entries) {
        insertEntry.run(
          record.id,
          entry.index,
          entry.heading,
          entry.date,
          entry.dateRaw,
          entry.inferredYear ? 1 : 0,
          entry.ambiguousDate ? 1 : 0,
          entry.monthOnly ? 1 : 0,
          entry.month,
          entry.text,
          entry.start,
          entry.end
        );
      }

      const insertChunk = this.db.prepare(
        `INSERT INTO chunks (doc_id, entry_index, part, parts, date, date_raw, inferred, heading,
                             label, text, start, end, words, places_json, people_json, amounts_json, images_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertVector = this.db.prepare(
        'INSERT INTO vectors (chunk_id, doc_id, dim, vec) VALUES (?, ?, ?, ?)'
      );
      const insertFts = this.db.prepare(
        'INSERT INTO chunks_fts (rowid, text, doc_id, chunk_id) VALUES (?, ?, ?, ?)'
      );

      chunks.forEach((chunk, at) => {
        const vector = vectors[at] as Float64Array;
        // The id is the database's to give, and it must be — a per-document numbering
        // collides the moment a second document is indexed. This was a real fault:
        // "UNIQUE constraint failed: chunks.id", on the second paste.
        const written = insertChunk.run(
          record.id,
          chunk.entryIndex,
          chunk.part,
          chunk.parts,
          chunk.date,
          chunk.dateRaw,
          chunk.inferredYear ? 1 : 0,
          chunk.heading,
          chunk.label,
          chunk.text,
          chunk.start,
          chunk.end,
          chunk.words,
          JSON.stringify(chunk.places),
          JSON.stringify(chunk.people),
          JSON.stringify(chunk.amounts),
          JSON.stringify(chunk.images)
        );
        const rowId = Number(written.lastInsertRowid);
        insertVector.run(
          rowId,
          record.id,
          vector.length,
          Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
        );
        insertFts.run(rowId, chunk.text, record.id, rowId);
      });

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getDocument(id: string): DocumentView | null {
    const row = this.db
      .prepare(
        'SELECT id, title, created_at, expires_at, stats_json, mentions_json, image_count FROM documents WHERE id = ?'
      )
      .get(id) as
      | {
          id: string;
          title: string;
          created_at: string;
          expires_at: string | null;
          stats_json: string;
          mentions_json: string;
          image_count: number;
        }
      | undefined;
    if (!row) return null;
    const stats = JSON.parse(row.stats_json) as IndexStats;
    const mentions = JSON.parse(row.mentions_json || '{}') as DocumentView['mentions'];
    return {
      id: row.id,
      title: row.title,
      characters: stats.characters,
      words: stats.words,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      stats,
      mentions: {
        places: mentions.places ?? [],
        people: mentions.people ?? [],
        amounts: mentions.amounts ?? [],
      },
      imageCount: row.image_count,
    };
  }

  /** The whole document as it was indexed, for the counts taken over all of it. */
  documentText(id: string): string {
    return this.entries(id)
      .map((entry) => entry.text)
      .join('\n\n');
  }

  /**
   * The document's entries, whole and unoverlapped.
   *
   * Counts are taken over THESE rather than over the notes, because a note repeats
   * the tail of the note before it — counting the notes would count that tail twice
   * and quietly inflate every figure the reader is shown.
   */
  entries(id: string): Entry[] {
    const rows = this.db
      .prepare('SELECT * FROM entries WHERE doc_id = ? ORDER BY idx')
      .all(id) as Record<string, unknown>[];
    return rows.map((row) => ({
      index: Number(row.idx),
      heading: (row.heading as string | null) ?? null,
      date: (row.date as string | null) ?? null,
      dateRaw: (row.date_raw as string | null) ?? null,
      inferredYear: Number(row.inferred) === 1,
      ambiguousDate: Number(row.ambiguous) === 1,
      monthOnly: Number(row.month_only) === 1,
      month: (row.month as string | null) ?? null,
      text: String(row.text),
      start: Number(row.start),
      end: Number(row.end),
    }));
  }

  chunkCount(id: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?').get(id) as { n: number };
    return row.n;
  }

  deleteDocument(id: string): boolean {
    const ids = (this.db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(id) as { id: number }[]).map(
      (row) => row.id
    );
    this.db.exec('BEGIN');
    try {
      const dropFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
      for (const chunkId of ids) dropFts.run(chunkId);
      this.db.prepare('DELETE FROM vectors WHERE doc_id = ?').run(id);
      this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM entries WHERE doc_id = ?').run(id);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Drop everything that is past its expiry. Returns how many documents went. */
  purgeExpired(at: string = nowIso()): number {
    const rows = this.db
      .prepare('SELECT id FROM documents WHERE expires_at IS NOT NULL AND expires_at < ?')
      .all(at) as { id: string }[];
    for (const row of rows) this.deleteDocument(row.id);
    return rows.length;
  }

  /** How many documents are held, and when the oldest expires. */
  housekeeping(): { documents: number; chunks: number } {
    const docs = this.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number };
    const chunks = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    return { documents: docs.n, chunks: chunks.n };
  }

  /**
   * The lexical half of the search: SQLite's own BM25.
   *
   * Every term is quoted, because a question is typed text and FTS5's query language
   * has operators in it — an unquoted `and` or `-` is a syntax error rather than a
   * word. Terms are then OR-ed so a question with one unknown word still finds the
   * notes that share the others, and terms of four letters or more also match as a
   * prefix so a plural finds its singular.
   */
  lexical(docId: string, question: string, limit: number, extraTerms: string[] = []): { chunkId: number; score: number }[] {
    const terms = [...question.toLowerCase().matchAll(/[\p{L}\p{N}'\u2019-]{2,}/gu)]
      .map((m) => m[0].replace(/['\u2019-]+$/, ''))
      .filter((term) => term.length >= 2)
      // Words the DOCUMENT may use where the QUESTION used another — see intent.ts. They
      // are OR-ed in beside the question's own words, so this can only add candidates.
      .concat(extraTerms.map((term) => term.toLowerCase()));
    if (terms.length === 0) return [];

    const seen = new Set<string>();
    const parts: string[] = [];
    for (const term of terms) {
      if (seen.has(term)) continue;
      seen.add(term);
      const clean = term.replace(/"/g, '');
      parts.push(clean.length >= 4 ? `"${clean}"*` : `"${clean}"`);
    }

    try {
      const rows = this.db
        .prepare(
          `SELECT chunk_id AS id, bm25(chunks_fts) AS score
             FROM chunks_fts
            WHERE chunks_fts MATCH ? AND doc_id = ?
            ORDER BY score
            LIMIT ?`
        )
        .all(parts.join(' OR '), docId, limit) as { id: number; score: number }[];
      return rows.map((row) => ({ chunkId: row.id, score: row.score }));
    } catch {
      // A query FTS5 cannot parse must not take the answer down with it: the vector
      // half still runs, and the run reports that the lexical half was unavailable.
      return [];
    }
  }

  /**
   * The vector half: a paged dot-product scan over the document's own notes.
   *
   * Paged on purpose. Reading 5,000 rows in one go would pull about 20 MB into a
   * process that shares a 1 GB box with nine other sites; reading 2,000 at a time
   * caps the peak at one page and costs nothing, because the arithmetic is the same.
   */
  vector(docId: string, query: Float64Array): { chunkId: number; score: number }[] {
    const scored: { chunkId: number; score: number }[] = [];
    let offset = 0;
    const page = this.db.prepare(
      'SELECT chunk_id, dim, vec FROM vectors WHERE doc_id = ? ORDER BY chunk_id LIMIT ? OFFSET ?'
    );
    for (;;) {
      const rows = page.all(docId, VECTOR_PAGE, offset) as { chunk_id: number; dim: number; vec: Uint8Array }[];
      if (rows.length === 0) break;
      for (const row of rows) {
        if (row.dim !== query.length) {
          throw new AppError(
            `This document was indexed with ${row.dim}-dimension vectors and the model now returns ` +
              `${query.length}. Re-index it — an old index cannot be searched with a new model.`,
            409
          );
        }
        const view = new Float64Array(row.vec.buffer, row.vec.byteOffset, row.dim);
        let dot = 0;
        for (let i = 0; i < row.dim; i += 1) dot += (view[i] as number) * (query[i] as number);
        scored.push({ chunkId: row.chunk_id, score: dot });
      }
      offset += rows.length;
      if (rows.length < VECTOR_PAGE) break;
    }
    return scored;
  }

  /** Fetch whole notes by id, in one query, keeping the order asked for. */
  chunksByIds(ids: number[]): Map<number, StoredChunk> {
    const out = new Map<number, StoredChunk>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
    for (const row of rows) {
      const chunk = rowToChunk(row);
      out.set(chunk.id, chunk);
    }
    return out;
  }

  /** Every note of a document, in order — used by the eval and by export. */
  allChunks(docId: string): StoredChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE doc_id = ? ORDER BY id')
      .all(docId) as Record<string, unknown>[];
    return rows.map(rowToChunk);
  }

  /** Every picture the document pointed at. */
  images(docId: string): ImageRef[] {
    const chunks = this.allChunks(docId);
    const out: ImageRef[] = [];
    const seen = new Set<string>();
    for (const chunk of chunks) {
      for (const image of chunk.images) {
        const key = `${image.url ?? ''}|${image.caption ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(image);
      }
    }
    return out;
  }

  /** Documents with the same content, so an identical paste is never indexed twice. */
  findByFingerprint(fingerprint: string): string | null {
    const row = this.db
      .prepare('SELECT id FROM documents WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1')
      .get(fingerprint) as { id: string } | undefined;
    return row?.id ?? null;
  }

  close(): void {
    this.db.close();
  }
}

function rowToChunk(row: Record<string, unknown>): StoredChunk {
  return {
    id: Number(row.id),
    documentId: String(row.doc_id),
    entryIndex: Number(row.entry_index),
    part: Number(row.part),
    parts: Number(row.parts),
    date: (row.date as string | null) ?? null,
    dateRaw: (row.date_raw as string | null) ?? null,
    inferredYear: Number(row.inferred) === 1,
    heading: (row.heading as string | null) ?? null,
    label: String(row.label),
    text: String(row.text),
    start: Number(row.start),
    end: Number(row.end),
    words: Number(row.words),
    places: JSON.parse(String(row.places_json ?? '[]')) as string[],
    people: JSON.parse(String(row.people_json ?? '[]')) as string[],
    amounts: JSON.parse(String(row.amounts_json ?? '[]')) as string[],
    images: JSON.parse(String(row.images_json ?? '[]')) as ImageRef[],
  };
}

export { nowIso };
