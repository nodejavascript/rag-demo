/**
 * A command line, so the pipeline can be driven without a browser.
 *
 * It exists for three reasons: to index a document from a file during development, to
 * run the same code the page runs when something looks wrong on the page, and to make
 * the whole thing usable on a machine where the page is not wanted. It shares every
 * module with the server — there is no second implementation that can drift.
 */

import { readFile } from 'node:fs/promises';
import { answer } from './answer.js';
import { indexDocument } from './indexer.js';
import { Model, modelConfig } from './model.js';
import { DEFAULT_RETRIEVE } from './retrieve.js';
import { SAMPLES } from './samples.js';
import { Store } from './store.js';

const DB_PATH = process.env.DB_PATH ?? 'data/rag.db';

function usage(): never {
  console.log(`rag — index a document and ask it questions

  rag index <file> [--year 2026] [--title "..."]   index a file and print its id
  rag sample [diary|resume]                        index a built-in sample
  rag ask <docId> "<question>"                     ask a question
  rag sample-ask [diary|resume] "<question>"       index a sample and ask, in one go

Options
  --year <yyyy>   the year to use for entries that write a day and a month
`);
  process.exit(1);
}

const [, , command, ...rest] = process.argv;

function flag(name: string): string | null {
  const at = rest.indexOf(`--${name}`);
  if (at === -1) return null;
  return rest[at + 1] ?? null;
}

function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const value = rest[i] as string;
    if (value.startsWith('--')) {
      i += 1;
      continue;
    }
    out.push(value);
  }
  return out;
}

async function main(): Promise<void> {
  const store = new Store(DB_PATH);
  const model = new Model(modelConfig());
  const health = await model.health();
  console.log(`model: ${health.ok ? 'ok' : 'NOT OK'} — ${health.detail} (${model.config.provider})`);
  if (!health.ok) {
    console.log('Continuing anyway — the failure will be reported where it happens.');
  }

  if (command === 'index') {
    const [file] = positionals();
    if (!file) usage();
    const text = await readFile(file as string, 'utf8');
    const result = await indexDocument(store, model, {
      text,
      title: flag('title'),
      yearHint: flag('year') ? Number.parseInt(flag('year') as string, 10) : null,
    });
    printDocument(result.document.id, result.document.stats, result.warnings);
  } else if (command === 'sample' || command === 'sample-ask') {
    const [which] = positionals();
    const sample = SAMPLES.find((entry) => entry.id === (which ?? 'diary'));
    if (!sample) usage();
    const result = await indexDocument(store, model, { text: sample.text, title: sample.title });
    printDocument(result.document.id, result.document.stats, result.warnings);

    if (command === 'sample-ask') {
      const question = positionals()[1];
      if (!question) usage();
      await runAsk(store, model, result.document.id, question);
    }
  } else if (command === 'ask') {
    const [docId, question] = positionals();
    if (!docId || !question) usage();
    await runAsk(store, model, docId as string, question as string);
  } else {
    usage();
  }

  store.close();
}

async function runAsk(store: Store, model: Model, docId: string, question: string): Promise<void> {
  const result = await answer(store, model, docId, question, { retrieve: DEFAULT_RETRIEVE });
  console.log(`\n=== ${question}`);
  console.log(`mode: ${result.mode}   total: ${result.timings.totalMs} ms ` +
    `(search ${result.timings.retrieveMs}, rerank ${result.timings.rerankMs}, model ${result.timings.modelMs})`);
  if (result.mode === 'refused') {
    console.log('REFUSED — the document does not address this.');
  } else {
    console.log(`\n${result.prose}`);
  }
  if (result.details.dates.length > 0) {
    console.log(`\ndates rest on: ${result.details.dates.map((d) => d.label).join(' · ')}`);
  }
  if (result.details.places.length > 0) {
    console.log(`places: ${result.details.places.map((p) => `${p.value}(${p.count})`).join(', ')}`);
  }
  if (result.details.people.length > 0) {
    console.log(`people: ${result.details.people.map((p) => `${p.value}(${p.count})`).join(', ')}`);
  }
  if (result.details.images.length > 0) {
    console.log(`images: ${result.details.images.map((i) => i.url ?? i.caption ?? '?').join(', ')}`);
  }
  if (result.warnings.length > 0) console.log(`\nnotes: ${result.warnings.join(' | ')}`);
  if (process.env.RAG_DEBUG) console.log(`\n--- the model's reply, verbatim ---\n${result.raw}\n--- end ---`);
  console.log(`\nsources: ${result.sources.map((s) => `[${s.label}] ${s.vector.toFixed(3)}`).join('  ')}`);
}

function printDocument(id: string, stats: { entries: number; chunks: number; words: number; datedEntries: number; firstDate: string | null; lastDate: string | null; embeddingMs: number }, warnings: string[]): void {
  console.log(`\ndocument ${id}`);
  console.log(
    `  ${stats.entries} entries · ${stats.chunks} notes · ${stats.words} words · ` +
      `${stats.datedEntries} dated · ${stats.firstDate ?? '—'} to ${stats.lastDate ?? '—'} · ` +
      `embedded in ${stats.embeddingMs} ms`
  );
  for (const warning of warnings) console.log(`  note: ${warning}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
