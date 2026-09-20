/**
 * The HTTP server: a handful of routes, no framework, and the whole page served from
 * disk.
 *
 * Four things are enforced here rather than trusted to the page, because the page is
 * not the only client this will ever have:
 *
 *  - **A size cap on the body.** A paste is bounded by `MAX_CHARS`, and the body cap
 *    is set just above it so an oversized request is refused before it is buffered.
 *  - **A rate limit per address.** This is a public page in front of a paid model.
 *    The limits are generous for a person reading a document and impossible for a
 *    script trying to use the endpoint as free inference.
 *  - **A cap on concurrent indexing.** Embedding is the expensive step and the whole
 *    box has 1 GB; ten simultaneous pastes would take the site down for everyone,
 *    including the nine other sites on the same machine.
 *  - **Nothing is logged but metadata.** The document text and the questions are
 *    never written to the log — a privacy promise that the log contradicts is not a
 *    promise.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answer, type AnswerOptions } from './answer.js';
import { indexDocument, MAX_CHARS, MIN_CHARS, DEFAULT_TTL_HOURS } from './indexer.js';
import { modelConfig, Model } from './model.js';
import { DEFAULT_RETRIEVE } from './retrieve.js';
import { Store } from './store.js';
import { AppError, type DocumentView } from './types.js';
import { SAMPLES } from './samples.js';
import { describeDocument } from './kinds.js';
import { continuousMonths } from './charts.js';

const PORT = Number.parseInt(process.env.PORT ?? '4500', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? 'data/rag.db';
const BODY_LIMIT = Number.parseInt(process.env.BODY_LIMIT ?? '900000', 10);
const FILE_LIMIT = Number.parseInt(process.env.FILE_LIMIT ?? '12000000', 10);
const MAX_CONCURRENT_INDEX = Number.parseInt(process.env.MAX_CONCURRENT_INDEX ?? '2', 10);

const SITE_DIR = fileURLToPath(new URL('../site/', import.meta.url));

/**
 * What kind of document this is, and what is worth asking it.
 *
 * 🔴 **COMPUTED ON THE WAY OUT, IN ONE PLACE.** Not stored, because it is a reading of the
 * text and the text is what the store holds; and not computed twice, so the index response
 * and the document response can never describe the same document differently. The page uses
 * it to offer questions that suit what was actually pasted — George, 20 Sep 2026: *"in ask
 * it something, if it detects a resume, can you create better questions, like what are the
 * skills?"*
 */
function describe(store: Store, document: DocumentView): {
  kind: string;
  kindLabel: string;
  suggestions: string[];
  timeline: { month: string; entries: number }[];
} {
  const described = describeDocument(store.documentText(document.id), document.stats.datedEntries);
  return {
    kind: described.kind,
    kindLabel: described.label,
    suggestions: described.suggestions,
    // Every month from the first to the last, INCLUDING the empty ones — `stats.perMonth`
    // holds only the months with entries, and drawing those side by side closes the gaps
    // and shows a document written continuously where the truth was silence. See
    // `continuousMonths` in charts.ts.
    timeline: continuousMonths(document.stats.perMonth, document.stats.firstDate, document.stats.lastDate),
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const store = new Store(DB_PATH);
const model = new Model(modelConfig());

/** How many pastes are being embedded right now. */
let indexing = 0;

/** A small fixed-window limiter — enough to stop a script, kind to a reader. */
interface Window {
  count: number;
  resetAt: number;
}
const windows = new Map<string, Window>();

function limited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = windows.get(key);
  if (!current || current.resetAt < now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  current.count += 1;
  return current.count > limit;
}

function clientOf(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(',')[0] ?? request.socket.remoteAddress ?? 'unknown').trim();
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return (await readRawBody(request, limit)).toString('utf8');
}

async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AppError(`That file is larger than ${Math.round(limit / 1000000)} MB.`, 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/**
 * Read a PDF with `pdftotext`, in the container, rather than in JavaScript.
 *
 * A resume arrives as a PDF, and a PDF is not text — it is a layout program. Poppler's
 * `pdftotext` is the tool that has been reading them for twenty years; the JavaScript
 * parsers are slower, heavier and worse, and this host has 1 GB of RAM. `-layout`
 * keeps the columns and line breaks, which is what the chunker needs in order to see a
 * resume's title line above its date line.
 *
 * Nothing about the file is written to disk. It arrives in memory, is piped through the
 * converter, and is gone.
 */
function pdfToText(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AppError('That PDF took too long to read. Try a smaller one.', 504));
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', () => {
      clearTimeout(timer);
      reject(new AppError('This server has no PDF reader installed.', 501));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new AppError(`The PDF could not be read: ${Buffer.concat(err).toString().slice(0, 200)}`, 400));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
    child.stdin.on('error', () => {
      /* the close handler reports the real problem */
    });
    child.stdin.end(buffer);
  });
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<boolean> {
  // Only ever from the site directory — `..` is stripped rather than resolved.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = safe === '/' || safe === '.' ? 'index.html' : safe.replace(/^\//, '');
  if (file.includes('..')) return false;
  try {
    const body = await readFile(join(SITE_DIR, file));
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      // The page itself is never cached, so a deploy is visible immediately; the
      // generated app.js is keyed by the page's own query string when it needs to be.
      'cache-control': file === 'index.html' ? 'no-store' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    response.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const client = clientOf(request);

    try {
      if (path === '/healthz') {
        const health = await model.health();
        sendJson(response, health.ok ? 200 : 503, {
          ok: health.ok,
          model: health.detail,
          provider: model.config.provider,
          chatModel: model.config.chatModel,
          embedModel: model.config.embedModel,
          rerank: model.rerankAvailable ? model.config.rerankModel : null,
          housekeeping: store.housekeeping(),
        });
        return;
      }

      if (path === '/api/extract' && request.method === 'POST') {
        const raw = await readRawBody(request, FILE_LIMIT);
        if (!raw.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
          sendJson(response, 400, {
            error: 'Only a PDF is read this way. Paste the text, or drop a .txt, .md, .csv or .html file.',
          });
          return;
        }
        const text = (await pdfToText(raw)).trim();
        if (text.length === 0) {
          sendJson(response, 400, {
            error:
              'That PDF has no text in it. If it is a scan, the pages are pictures rather than words, and it needs to be run through OCR first.',
          });
          return;
        }
        console.log(`extracted pdf bytes=${raw.length} pages≈${(text.match(/\f/g)?.length ?? 0) + 1} chars=${text.length}`);
        sendJson(response, 200, { text });
        return;
      }

      if (path === '/api/samples' && request.method === 'GET') {
        sendJson(response, 200, {
          samples: SAMPLES.map((sample) => ({
            id: sample.id,
            title: sample.title,
            blurb: sample.blurb,
            characters: sample.text.length,
          })),
        });
        return;
      }

      if (path.startsWith('/api/samples/') && request.method === 'GET') {
        const id = path.slice('/api/samples/'.length);
        const sample = SAMPLES.find((entry) => entry.id === id);
        if (!sample) {
          sendJson(response, 404, { error: 'No such sample.' });
          return;
        }
        sendJson(response, 200, { id: sample.id, title: sample.title, text: sample.text });
        return;
      }

      if (path === '/api/limits' && request.method === 'GET') {
        sendJson(response, 200, {
          minCharacters: MIN_CHARS,
          maxCharacters: MAX_CHARS,
          ttlHours: DEFAULT_TTL_HOURS,
          refusalFloor: DEFAULT_RETRIEVE.refusalFloor,
        });
        return;
      }

      if (path === '/api/index' && request.method === 'POST') {
        if (limited(`index:${client}`, Number.parseInt(process.env.INDEX_PER_HOUR ?? '40', 10), 3600_000)) {
          sendJson(response, 429, { error: 'That is a lot of documents in an hour. Try again a little later.' });
          return;
        }
        if (indexing >= MAX_CONCURRENT_INDEX) {
          sendJson(response, 503, {
            error: `The machine is already indexing ${indexing} documents. Try again in a moment.`,
          });
          return;
        }
        const raw = await readBody(request, BODY_LIMIT);
        const payload = JSON.parse(raw || '{}') as {
          text?: string;
          title?: string;
          year?: number | string | null;
          sourceName?: string;
        };
        const year = payload.year === null || payload.year === undefined || payload.year === ''
          ? null
          : Number.parseInt(String(payload.year), 10);

        indexing += 1;
        try {
          const result = await indexDocument(store, model, {
            text: payload.text ?? '',
            title: payload.title ?? null,
            sourceName: payload.sourceName ?? null,
            yearHint: Number.isFinite(year as number) ? (year as number) : null,
          });
          console.log(
            `indexed doc=${result.document.id} reused=${result.reused} entries=${result.document.stats.entries} chunks=${result.document.stats.chunks} embedMs=${result.document.stats.embeddingMs}`
          );
          sendJson(response, 200, {
            document: result.document,
            ...describe(store, result.document),
            reused: result.reused,
            warnings: result.warnings,
          });
        } finally {
          indexing -= 1;
        }
        return;
      }

      if (path === '/api/ask' && request.method === 'POST') {
        if (limited(`ask:${client}`, Number.parseInt(process.env.ASK_PER_HOUR ?? '240', 10), 3600_000)) {
          sendJson(response, 429, { error: 'That is a lot of questions in an hour. Try again a little later.' });
          return;
        }
        const raw = await readBody(request, 20_000);
        const payload = JSON.parse(raw || '{}') as { docId?: string; question?: string };
        if (!payload.docId) {
          sendJson(response, 400, { error: 'Which document? No document id was sent.' });
          return;
        }
        const started = Date.now();
        const result = await answer(store, model, payload.docId, (payload.question ?? '').trim(), {
          retrieve: DEFAULT_RETRIEVE,
        } satisfies AnswerOptions);
        console.log(
          `asked doc=${payload.docId} mode=${result.mode} notes=${result.sources.length} ms=${Date.now() - started}`
        );
        sendJson(response, 200, result);
        return;
      }

      if (path.startsWith('/api/document/')) {
        const id = path.slice('/api/document/'.length).split('/')[0] ?? '';
        if (request.method === 'GET') {
          const document = store.getDocument(id);
          if (!document) {
            sendJson(response, 404, { error: 'That document is not here. It may have expired.' });
            return;
          }
          sendJson(response, 200, {
            document,
            ...describe(store, document),
            images: store.images(id),
            housekeeping: store.housekeeping(),
          });
          return;
        }
        if (request.method === 'DELETE') {
          const gone = store.deleteDocument(id);
          console.log(`deleted doc=${id} found=${gone}`);
          sendJson(response, gone ? 200 : 404, { deleted: gone });
          return;
        }
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        if (await serveStatic(response, path)) return;
      }

      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const message =
        error instanceof Error ? error.message : 'Something went wrong on the server.';
      if (status >= 500) console.error(`error ${status} on ${path}: ${message}`);
      sendJson(response, status, { error: message });
    }
  })();
});

/** Sweep expired documents every ten minutes, and once at start-up. */
function sweep(): void {
  try {
    const gone = store.purgeExpired();
    if (gone > 0) console.log(`swept ${gone} expired document(s)`);
  } catch (error) {
    console.error('sweep failed:', error instanceof Error ? error.message : error);
  }
}
sweep();
const sweeper = setInterval(sweep, 600_000);
sweeper.unref();

server.listen(PORT, HOST, () => {
  console.log(`rag-demo listening on http://${HOST}:${PORT}`);
  console.log(
    `provider=${model.config.provider} chat=${model.config.chatModel} embed=${model.config.embedModel} rerank=${model.config.rerankModel ?? 'none'}`
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal} — closing`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
