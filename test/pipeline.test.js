/**
 * The whole pipeline, end to end, with a stub model.
 *
 * These tests run in under a second and touch no network, which is the point: the
 * parts that decide an ANSWER's shape — the parser, the fusion, the refusal, the
 * details — are all testable without a model at all. The model is the one component
 * that cannot be deterministic, so it is stubbed and everything around it is asserted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { build } from '../dist/chunk.js';
import { SAMPLES } from '../dist/samples.js';
import { Model } from '../dist/model.js';
import { Store } from '../dist/store.js';
import { indexDocument } from '../dist/indexer.js';
import { answer } from '../dist/answer.js';
import { retrieve } from '../dist/retrieve.js';
import { factsFor, factsAsText, subjectTerms, properNouns } from '../dist/stats.js';
import { buildMessages, isNothingFurther, isRefusal, readShape } from '../dist/prompt.js';

/* ---------------------------------------------------------------- stub model */

const DIM = 64;

/**
 * A bag-of-words embedding, hashed into fixed slots and made unit length.
 *
 * It is not a language model and does not pretend to be one. It is enough to make
 * cosine similarity mean "these two passages share words", which is exactly what the
 * retrieval tests need in order to be deterministic.
 */
function stubVector(text) {
  const vector = new Float64Array(DIM);
  for (const word of text.toLowerCase().matchAll(/[\p{L}\p{N}']{3,}/gu)) {
    let hash = 0;
    for (const ch of word[0]) hash = (hash * 31 + ch.codePointAt(0)) % 100003;
    vector[hash % DIM] += 1;
  }
  let length = 0;
  for (const value of vector) length += value * value;
  length = Math.sqrt(length) || 1;
  for (let i = 0; i < DIM; i += 1) vector[i] /= length;
  return vector;
}

function stubModel(reply = 'WHAT THE DOCUMENT SAYS\nIt rained. [18 March 2026]\n\nWHAT IT SUGGESTS\nNothing further.') {
  const model = new Model({
    provider: 'ollama',
    baseUrl: 'http://stub',
    apiKey: null,
    chatModel: 'stub',
    embedModel: 'stub-embed',
    rerankModel: null,
    embedBatch: 16,
  });
  // 🔴 THE STUB MUST HONOUR THE PROGRESS CALLBACK, OR THE PROGRESS TESTS TEST NOTHING.
  // It replaces `Model.embed` outright, so when the real method grew a second parameter this
  // stub silently kept the old signature and the indexer's reports never fired — which the test
  // below caught immediately, in the shape of "an embedding stage that reports once is not
  // progress". The loop mirrors the real one: the configured batch size, reporting after each.
  model.embed = async (inputs, onBatch) => {
    const batch = model.config.embedBatch;
    const out = [];
    for (let i = 0; i < inputs.length; i += batch) {
      const slice = inputs.slice(i, i + batch);
      out.push(...slice.map(stubVector));
      onBatch?.(Math.min(i + slice.length, inputs.length), inputs.length);
    }
    return out;
  };
  model.chat = async () => reply;
  return model;
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'rag-test-'));
  return { dir, store: new Store(join(dir, 'test.db')), close: () => rmSync(dir, { recursive: true, force: true }) };
}

const diary = SAMPLES.find((sample) => sample.id === 'diary').text;
const resume = SAMPLES.find((sample) => sample.id === 'resume').text;

/* ---------------------------------------------------------------- the parser */

test('a diary becomes one entry per day, each dated', () => {
  const built = build(diary, null, []);
  assert.equal(built.entries.length, 9);
  assert.equal(built.stats.datedEntries, 9);
  assert.equal(built.stats.firstDate, '2026-03-04');
  assert.equal(built.stats.lastDate, '2026-04-17');
  assert.deepEqual(
    built.stats.perMonth.map((point) => point.month),
    ['2026-03', '2026-04']
  );
});

test('a document of short standalone lines stays ONE entry', () => {
  // The fragment bug: with the heading rule relaxed, this became 4 entries with 3
  // EMPTY bodies, and most of the text disappeared.
  const loose = [
    'Alpha',
    '',
    'Bravo',
    '',
    'Charlie',
    '',
    'Delta',
    '',
    'Echo',
  ].join('\n');
  const built = build(loose, null, []);
  assert.equal(built.entries.length, 1);
  assert.match(built.entries[0].text, /Alpha/);
  assert.match(built.entries[0].text, /Echo/);
  assert.equal(built.chunks.length, 1);
});

test('a heading alone in its own paragraph still starts an entry', () => {
  // A resume collapsed into a single entry without this rule.
  const built = build(resume, null, []);
  assert.ok(built.entries.length >= 7, `expected the sections to split, got ${built.entries.length}`);
  const roles = built.entries.filter((entry) => entry.month !== null);
  assert.equal(roles.length, 3, 'three dated roles');
  assert.deepEqual(
    roles.map((entry) => entry.month),
    ['2021-07', '2018-03', '2017-01']
  );
});

test('a resume has a timeline at month precision, and claims no day', () => {
  const built = build(resume, null, []);
  assert.equal(built.stats.datedEntries, 0, 'no complete date anywhere');
  assert.equal(built.stats.monthPrecision, 3, 'but three entries can be placed');
  assert.ok(built.stats.perMonth.length > 0);
});

test('places, people and amounts are found over the WHOLE document', () => {
  const built = build(diary, null, []);
  // Andrea appears once per diary entry, so a per-entry recurrence test would miss her.
  assert.equal(built.people.find((mention) => mention.value === 'Andrea')?.count, 3);
  assert.equal(built.places.find((mention) => mention.value === 'Grimsby')?.count, 1);
  assert.ok(built.amounts.some((mention) => mention.value === '$1,450'));
});

test('the heading line stays in the text, so its date is searchable', () => {
  const built = build(diary, null, []);
  assert.match(built.entries[0].text, /^4 March 2026/);
  assert.equal(built.entries[0].heading, '4 March 2026');
});

/* ---------------------------------------------------------------- the store */

test('a document round-trips, and its notes carry their details', () => {
  const { store, close } = scratch();
  try {
    const built = build(diary, null, []);
    const vectors = built.chunks.map((chunk) => stubVector(chunk.text));
    store.insert(
      {
        id: 'doc-one',
        title: 'A diary',
        sourceName: null,
        fingerprint: 'fp-1',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        stats: { ...built.stats, embeddingMs: 1 },
        mentions: { places: built.places, people: built.people, amounts: built.amounts },
        imageCount: built.images.length,
        entries: built.entries.length,
      },
      built.entries,
      built.chunks,
      vectors
    );

    const document = store.getDocument('doc-one');
    assert.equal(document.stats.entries, 9);
    assert.equal(document.mentions.people[0].value, 'Andrea');
    assert.equal(store.entries('doc-one').length, 9);
    assert.equal(store.chunkCount('doc-one'), built.chunks.length);
    assert.ok(store.documentText('doc-one').includes('Rain all day'));
  } finally {
    close();
  }
});

test('TWO documents coexist, which they did not', () => {
  // The per-document chunk numbering collided: "UNIQUE constraint failed: chunks.id".
  const { store, close } = scratch();
  try {
    const insert = (id, text) => {
      const built = build(text, null, []);
      store.insert(
        {
          id,
          title: id,
          sourceName: null,
          fingerprint: `fp-${id}`,
          createdAt: new Date().toISOString(),
          expiresAt: null,
          stats: { ...built.stats, embeddingMs: 1 },
          mentions: { places: built.places, people: built.people, amounts: built.amounts },
          imageCount: 0,
          entries: built.entries.length,
        },
        built.entries,
        built.chunks,
        built.chunks.map((chunk) => stubVector(chunk.text))
      );
    };
    insert('a', diary);
    insert('b', resume);
    assert.equal(store.housekeeping().documents, 2);
    assert.notEqual(store.getDocument('a').stats.entries, 0);
  } finally {
    close();
  }
});

test('deleting a document takes its entries, notes, vectors and search rows with it', () => {
  const { store, close } = scratch();
  try {
    const built = build(diary, null, []);
    store.insert(
      {
        id: 'gone',
        title: 'gone',
        sourceName: null,
        fingerprint: 'fp-gone',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        stats: { ...built.stats, embeddingMs: 1 },
        mentions: { places: [], people: [], amounts: [] },
        imageCount: 0,
        entries: built.entries.length,
      },
      built.entries,
      built.chunks,
      built.chunks.map((chunk) => stubVector(chunk.text))
    );
    assert.equal(store.deleteDocument('gone'), true);
    assert.equal(store.getDocument('gone'), null);
    assert.equal(store.chunkCount('gone'), 0);
    assert.equal(store.entries('gone').length, 0);
    assert.equal(store.lexical('gone', 'boiler', 10).length, 0);
    assert.equal(store.deleteDocument('gone'), false);
  } finally {
    close();
  }
});

test('an expired document is swept away', () => {
  const { store, close } = scratch();
  try {
    const built = build(diary, null, []);
    store.insert(
      {
        id: 'old',
        title: 'old',
        sourceName: null,
        fingerprint: 'fp-old',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
        stats: { ...built.stats, embeddingMs: 1 },
        mentions: { places: [], people: [], amounts: [] },
        imageCount: 0,
        entries: 1,
      },
      [],
      [],
      []
    );
    assert.equal(store.purgeExpired(), 1);
    assert.equal(store.getDocument('old'), null);
  } finally {
    close();
  }
});

/* ---------------------------------------------------------------- indexing */

test('the same text is not indexed twice, and the fingerprint covers the pipeline', async () => {
  const { store, close } = scratch();
  try {
    const model = stubModel();
    const first = await indexDocument(store, model, { text: diary });
    const second = await indexDocument(store, model, { text: diary });
    assert.equal(second.reused, true);
    assert.equal(second.document.id, first.document.id);
    assert.equal(store.housekeeping().documents, 1);
  } finally {
    close();
  }
});

test('a paste too short to answer from is refused', async () => {
  const { store, close } = scratch();
  try {
    await assert.rejects(() => indexDocument(store, stubModel(), { text: 'too short' }), /Paste at least/);
  } finally {
    close();
  }
});

test('the index records how long each of its stages took', async () => {
  // 🔴 George, 22 September 2026: *"is there a new chart you can use to show how it was index"*.
  // The chart draws `stats.stageMs`, so the three figures have to be measured by the indexer and
  // kept on the record — and `saving` cannot be known until the write has happened, which is why
  // the store patches it on afterwards rather than the indexer guessing it beforehand.
  //
  // ⚠ AND `embedding` MUST BE THE SAME NUMBER AS `embeddingMs`. Two stopwatches for one stage is
  // two figures that can disagree, and the page prints both: the document's title line says
  // "indexed in N ms" from `embeddingMs` and the chart draws `stageMs.embedding`.
  const { store, close } = scratch();
  try {
    const { document } = await indexDocument(store, stubModel(), { text: diary });
    const stageMs = document.stats.stageMs;
    assert.ok(stageMs, 'the index recorded no stage timings at all');
    for (const [stage, ms] of Object.entries(stageMs)) {
      assert.equal(typeof ms, 'number', `${stage} is not a number`);
      assert.ok(ms >= 0, `${stage} is negative`);
    }
    assert.equal(stageMs.embedding, document.stats.embeddingMs, 'two different measurements of one stage');
    // It has to survive the write: the whole point is that the chart still draws on a reload, and
    // the timings are patched onto the row after it is inserted.
    const stored = store.getDocument(document.id);
    assert.ok(stored?.stats.stageMs, 'the timings did not survive the write');
    assert.deepEqual(stored.stats.stageMs, stageMs);
  } finally {
    close();
  }
});

/* ---------------------------------------------------------------- retrieval */

test('the keyword half finds an exact word, and fusion keeps it', async () => {
  const { store, close } = scratch();
  try {
    const model = stubModel();
    const { document } = await indexDocument(store, model, { text: diary });
    const result = await retrieve(store, model, document.id, 'boiler');
    assert.equal(result.silent, false);
    assert.ok(result.scored.length > 0);
    assert.ok(result.scored.some((item) => item.lexicalRank > 0), 'the exact word must be ranked');
  } finally {
    close();
  }
});

test('a question naming a day of the month finds THAT day, not a neighbour', async () => {
  // 🔴 THE FAULT THIS HOLDS SHUT. The term extractor required two characters, so
  // "What happened on 6 March 2026?" became "what happened on march 2026" — and every
  // entry in a diary matches `march` and `2026`, so the one token that identified the
  // entry was thrown away. Measured on the real index 2026-09-19: the 6 March entry
  // ranked **8th of 9**, retrieval handed the model the 4 March note, and the demo
  // answered a question about the sixth with the fourth's contents.
  //
  // Asserting on RANK (not merely "some result came back") is the point: the entry was
  // always in the results. It was just never near the top, so the answer was wrong
  // while every other signal looked healthy.
  const { store, close } = scratch();
  try {
    const model = stubModel();
    const { document } = await indexDocument(store, model, { text: diary });
    const ranked = store.lexical(document.id, 'What happened on 6 March 2026?', 20);
    assert.ok(ranked.length > 1, 'the diary must return more than one entry, or the test proves nothing');

    const sixth = store.allChunks(document.id).find((chunk) => chunk.date === '2026-03-06');
    assert.ok(sixth, 'the sample diary must have a 6 March entry for this test to mean anything');
    assert.equal(
      String(ranked[0].chunkId),
      String(sixth.id),
      'the day named in the question must rank first — otherwise the answer comes from the wrong day'
    );
  } finally {
    close();
  }
});

test('a question that asks for a LIST is answered from every note, not the best eight', async () => {
  // 🔴 THE MEASURED FAILURE THIS HOLDS SHUT. *"Which employers and job titles are named?"* is a
  // question the page offers on a resume, and it came back with **four employers out of twelve** —
  // because the order of the day was the eight best-matching notes, and a similarity search has
  // almost nothing to match on when every employment block reads *"IOU Concepts / Hamilton, Ontario
  // / 02/2017 - 05/2022"*. The model was faithful to the notes it was given; the search starved it.
  //
  // 🔴 THE DIARY IS THE DOCUMENT HERE BECAUSE IT HAS **NINE** NOTES AND THE SEARCH SHOWS EIGHT. The
  // sample resume has exactly eight, which is also the number the search returns — so on the resume
  // this assertion would hold whether the fix was in place or not. Chosen to discriminate.
  const { store, close } = scratch();
  try {
    const seen = [];
    const model = stubModel();
    model.chat = async (messages) => {
      seen.push(messages);
      return 'WHAT THE DOCUMENT SAYS\nThe events are in one place.\n\nWHAT IT SUGGESTS\nNothing further.';
    };
    const { document } = await indexDocument(store, model, { text: diary });
    const total = store.chunkCount(document.id);
    assert.ok(total > 8, `this test needs a document with more notes than the search shows (it has ${total})`);

    const reply = await answer(store, model, document.id, 'Where do the events take place?', {
      retrieve: { refusalFloor: 0, useRerank: false },
    });

    assert.equal(reply.sources.length, total, 'the list question did not get every note');
    assert.equal(seen.length, 1, 'the model must be called exactly once');
    const prompt = seen[0].map((message) => message.content).join('\n');
    assert.equal(
      (prompt.match(/--- NOTE /g) ?? []).length,
      total,
      'the prompt does not quote every note, whatever the sources say'
    );
    assert.match(prompt, /EVERY note in the document is quoted below/, 'the model is not told it has the whole document');
    assert.match(String(reply.warnings), /all \d+ notes of the document were read/, 'the reader is not told the whole document was read');

    // In the document's own order, so the model reads the document top to bottom rather than by
    // score — and so the answer can be followed against the page.
    const first = store.allChunks(document.id)[0];
    assert.equal(reply.sources[0].text, first.text, 'the notes are not in document order');
  } finally {
    close();
  }
});

test('and every employer in a resume reaches the model, which is what the list question needs', async () => {
  // The completeness half of the same fix, on the document shape George actually hit. The sample
  // resume names three employers; the assertion is that all three are IN THE PROMPT, because the
  // old path could hand over a handful of employment blocks and leave the rest behind. What the
  // MODEL then writes is not asserted — that is not deterministic — but this program's job is to
  // show it everything it is asked about, and that is asserted here.
  const { store, close } = scratch();
  try {
    const seen = [];
    const model = stubModel();
    model.chat = async (messages) => {
      seen.push(messages);
      return 'WHAT THE DOCUMENT SAYS\nThree employers are named.\n\nWHAT IT SUGGESTS\nNothing further.';
    };
    const { document } = await indexDocument(store, model, { text: resume });
    const reply = await answer(store, model, document.id, 'Which employers and job titles are named?', {
      retrieve: { refusalFloor: 0, useRerank: false },
    });
    const prompt = seen[0].map((message) => message.content).join('\n');
    for (const name of ['First Canadian Title', 'Utherverse Digital', 'IOU Concepts']) {
      assert.match(prompt, new RegExp(name), `${name} is in the document but was not handed to the model`);
    }
    assert.match(prompt, /EVERY note in the document is quoted below/, 'the resume list question was not given the whole document');
    assert.equal(reply.sources.length, store.chunkCount(document.id), 'and the reader is not shown all of the notes it rested on');
  } finally {
    close();
  }
});

test('and an ordinary question still reads the best few — the list path is not the default', async () => {
  // The other half of the fix, and the one that protects the wait: reading every note of a long
  // document costs tokens and seconds, so it must happen for the questions that need it and for no
  // others.
  const { store, close } = scratch();
  try {
    const seen = [];
    const model = stubModel();
    model.chat = async (messages) => {
      seen.push(messages);
      return 'WHAT THE DOCUMENT SAYS\nIt rained.\n\nWHAT IT SUGGESTS\nNothing further.';
    };
    const { document } = await indexDocument(store, model, { text: diary });
    const total = store.chunkCount(document.id);
    assert.ok(total > 8, `this test only means something if the document has more notes than the search shows (${total})`);

    const reply = await answer(store, model, document.id, 'What happened on 6 March 2026?', {
      retrieve: { refusalFloor: 0, useRerank: false },
    });

    assert.ok(reply.sources.length <= 8, `an ordinary question was handed ${reply.sources.length} notes`);
    assert.ok(reply.sources.length < total, 'an ordinary question read the whole document');
    const prompt = seen[0].map((message) => message.content).join('\n');
    assert.doesNotMatch(prompt, /EVERY note in the document is quoted below/, 'an ordinary question was told it had everything');
    assert.doesNotMatch(String(reply.warnings), /asks for a list/, 'an ordinary question was answered down the list path');
  } finally {
    close();
  }
});

test('a list question is not refused because the document uses different words', async () => {
  // 🔴 MEASURED ON A STATEMENT OF ACCOUNTS, 22 Sep 2026, BY `tools/judge-answers.mjs`: THREE of the
  // four questions the page offers on a statement were refused in 0.2 s — *"Which payees or merchants
  // are named?", "What amounts are listed?"* and *"What date range does it cover?"* — on a document
  // that names eight payees and thirteen amounts. The words *payee* and *merchant* are not in it, and
  // a note the length of a whole statement dilutes its own cosine, so the search called the document
  // silent about a question the page itself had offered.
  //
  // The floor here is raised to 0.99 on purpose: it means "refuse unless the question is almost the
  // same text as the note", which is the strongest possible pressure to refuse. The list path must
  // ignore it — the only silence it recognises is having nothing to read.
  const { store, close } = scratch();
  try {
    const seen = [];
    const model = stubModel();
    model.chat = async (messages) => {
      seen.push(messages);
      return 'WHAT THE DOCUMENT SAYS\nThe payees are named in the statement.\n\nWHAT IT SUGGESTS\nNothing further.';
    };
    const ledger = [
      'STATEMENT OF ACCOUNTS - 1 January 2026 to 31 March 2026',
      '03/01/2026 DEPOSIT Payroll - Northline Logistics $2,410.55',
      '07/01/2026 DEBIT Hydro One $184.20',
      '11/01/2026 DEBIT Freshmart Groceries $236.77',
      '15/01/2026 DEBIT Rogers Wireless $96.35',
      '22/01/2026 DEBIT Halton Property Tax $512.00',
      '19/03/2026 DEBIT Birchwood Dental $340.00',
    ].join('\n');
    const { document } = await indexDocument(store, model, { text: ledger });
    const reply = await answer(store, model, document.id, 'Which payees or merchants are named?', {
      retrieve: { refusalFloor: 0.99, useRerank: false },
    });
    assert.notEqual(reply.mode, 'refused', 'a list question was refused on similarity alone');
    assert.equal(seen.length, 1, 'the model was not asked, so the document was never read');
    assert.equal(reply.sources.length, store.chunkCount(document.id), 'the notes were not all handed over');
  } finally {
    close();
  }
});

test('the shape of the document reaches the model, instead of being thrown away', () => {
  // 🔴 DEAD CODE FOUND BY A TEST WRITTEN FOR SOMETHING ELSE, 22 Sep 2026. `buildMessages` filled a
  // `shape` array — the entry count, the note count, whether the document carries dates, the year
  // the reader supplied, an ambiguous-date warning, and (new) how much of the document is quoted —
  // and then returned a prompt that contained none of it. The line that reports the whole-document
  // coverage went in there and arrived nowhere.
  const messages = buildMessages({
    question: 'What is this document about?',
    notes: [{ label: '4 March 2026', date: '2026-03-04', dateRaw: '4 March 2026', text: 'Cold.', places: [], people: [] }],
    facts: [],
    stats: {
      characters: 5,
      words: 1,
      entries: 1,
      datedEntries: 1,
      firstDate: '2026-03-04',
      lastDate: '2026-03-04',
      chunks: 1,
      images: 0,
      monthPrecision: 0,
      ambiguousDates: 1,
      assumedYear: false,
      yearUsed: null,
      perMonth: [],
      stages: [],
    },
    assumedYear: false,
    coverage: { shown: 1, total: 1 },
  });
  const user = messages.find((message) => message.role === 'user').content;
  assert.match(user, /THE SHAPE OF THIS DOCUMENT/, 'the shape block is built and not sent');
  assert.match(user, /The document has 1 entries, 1 words, and 1 notes were indexed\./);
  assert.match(user, /a form that can be read two ways/, 'the ambiguous-date warning never reaches the model');
  assert.match(user, /EVERY note in the document is quoted below/, 'the coverage of a whole-document read never reaches the model');
  // …and when it is only PART of the document, the model is told to say so rather than sounding
  // finished. This is the sentence that stops a partial list reading as a complete one.
  const partial = buildMessages({
    question: 'List the employers.',
    notes: [{ label: 'A', date: null, dateRaw: null, text: 'x', places: [], people: [] }],
    facts: [],
    stats: { characters: 1, words: 1, entries: 1, datedEntries: 0, firstDate: null, lastDate: null, chunks: 40, images: 0, monthPrecision: 0, ambiguousDates: 0, assumedYear: false, yearUsed: null, perMonth: [], stages: [] },
    assumedYear: false,
    coverage: { shown: 12, total: 40 },
  });
  const partialUser = partial.find((message) => message.role === 'user').content;
  assert.match(partialUser, /first 12 of them are quoted below/, 'a partial read is not declared to the model');
  assert.match(partialUser, /the list may be incomplete/, 'the model is not told to admit a partial list');
});

test('a solid run of many short lines is split into notes, so a statement can be searched', () => {
  // 🔴 MEASURED, 22 Sep 2026, BY `tools/judge-answers.mjs`. A statement of accounts — one line per
  // transaction, the shape every bank exports — came out as ONE entry and ONE note of about 1,300
  // characters. With a single note the search has no granularity, and the refusal floor (measured
  // against short notes) called the document silent about its own contents: three of the four
  // questions the page offers on a statement were refused in 0.2 s.
  const ledger = [
    'STATEMENT OF ACCOUNTS - 1 January 2026 to 31 March 2026',
    '03/01/2026 DEPOSIT Payroll - Northline Logistics $2,410.55',
    '07/01/2026 DEBIT Hydro One $184.20',
    '11/01/2026 DEBIT Freshmart Groceries $236.77',
    '15/01/2026 DEBIT Rogers Wireless $96.35',
    '22/01/2026 DEBIT Halton Property Tax $512.00',
    '05/02/2026 DEPOSIT Payroll - Northline Logistics $2,410.55',
    '09/02/2026 DEBIT Freshmart Groceries $198.04',
    '14/02/2026 DEBIT Bell Canada $88.10',
    '27/02/2026 DEBIT Home Depot $74.99',
    '06/03/2026 DEPOSIT Payroll - Northline Logistics $2,410.55',
    '12/03/2026 DEBIT Hydro One $201.60',
    '19/03/2026 DEBIT Birchwood Dental $340.00',
    '28/03/2026 DEBIT Freshmart Groceries $255.31',
  ].join('\n');
  const built = build(ledger, null, []);
  assert.ok(built.entries.length > 1, `a 14-line record list became ${built.entries.length} entry`);
  assert.ok(built.chunks.length > 1, 'and one note');
  // 🔴 NOTHING IS LOST AND NOTHING IS DUPLICATED — the property the fragment bug destroyed, asserted
  // as text rather than as counts. The pieces are SLICES of the document, so they concatenate back to
  // it exactly; joining with a separator here would have been an assertion about my own test.
  assert.equal(built.chunks.map((chunk) => chunk.text).join(''), ledger, 'the split lost or repeated part of the document');
  // Every group has to be usable on its own: a body that is not empty, and a label that is not the
  // same as every other note's.
  for (const chunk of built.chunks) assert.ok(chunk.text.trim().length > 0, 'a group came out empty');
  assert.equal(new Set(built.chunks.map((chunk) => chunk.label)).size, built.chunks.length, 'two notes share a label');
  // And the note that carries the account's own date range is now a SHORT one, which is what makes the
  // range findable at all. Before this change that note was the whole statement, about 1,300 characters.
  const carriesTheRange = built.chunks.filter((chunk) => chunk.text.includes('1 January 2026 to 31 March 2026'));
  assert.equal(carriesTheRange.length, 1, `the range appears in ${carriesTheRange.length} notes`);
  assert.ok(
    carriesTheRange[0].text.length < 500,
    `the note carrying the range is ${carriesTheRange[0].text.length} characters`
  );
});

test('and the same lines with blank lines between them are left alone', () => {
  // 🔴 THE FRAGMENT GUARD IS NOT BEING UNDONE, and this is the test that says so. A document of short
  // standalone lines separated by BLANK lines stays one entry: relaxing that rule once turned such a
  // document into four entries with three empty bodies, and most of the text disappeared. The split
  // above fires only on a SOLID run.
  const loose = ['Alpha', '', 'Bravo', '', 'Charlie', '', 'Delta', '', 'Echo', '', 'Foxtrot', '', 'Golf', '', 'Hotel'].join('\n');
  const built = build(loose, null, []);
  assert.equal(built.entries.length, 1, 'a fragment list was split into groups');
  assert.equal(built.chunks.length, 1);
  assert.match(built.entries[0].text, /Hotel/);
});

test('and a statement is searched note by note rather than as one lump', async () => {
  // 🔴 WHY THIS REPLACED A TEST THAT ASSERTED THE REFUSAL WAS GONE. The refusal depends on the
  // EMBEDDING — whether "what date range does it cover" is close in meaning to "1 January 2026 to 31
  // March 2026" — and the stub model in this file is a bag of words with no meaning in it at all. The
  // stub said 0.00 and refused, which says nothing about the real model. So the unit test asserts what
  // a unit test CAN: that the statement is now several notes, that the one carrying the range is
  // short, and that the search can therefore reach it. **Whether the real model then answers is
  // measured against the real model, by `tools/judge-answers.mjs`.**
  const { store, close } = scratch();
  try {
    const model = stubModel();
    const ledger = [
      'STATEMENT OF ACCOUNTS - 1 January 2026 to 31 March 2026',
      '03/01/2026 DEPOSIT Payroll - Northline Logistics $2,410.55',
      '07/01/2026 DEBIT Hydro One $184.20',
      '11/01/2026 DEBIT Freshmart Groceries $236.77',
      '15/01/2026 DEBIT Rogers Wireless $96.35',
      '22/01/2026 DEBIT Halton Property Tax $512.00',
      '05/02/2026 DEPOSIT Payroll - Northline Logistics $2,410.55',
      '09/02/2026 DEBIT Freshmart Groceries $198.04',
      '14/02/2026 DEBIT Bell Canada $88.10',
      '27/02/2026 DEBIT Home Depot $74.99',
      '06/03/2026 DEPOSIT Payroll - Northline Logistics $2,410.55',
      '12/03/2026 DEBIT Hydro One $201.60',
      '19/03/2026 DEBIT Birchwood Dental $340.00',
      '28/03/2026 DEBIT Freshmart Groceries $255.31',
    ].join('\n');
    const { document } = await indexDocument(store, model, { text: ledger });
    const notes = store.allChunks(document.id);
    assert.ok(notes.length > 1, `the statement is still ${notes.length} note`);
    const range = notes.find((note) => note.text.includes('1 January 2026 to 31 March 2026'));
    assert.ok(range, 'the note carrying the range is gone');
    // It no longer carries the whole statement: this is the property the fix delivers, and it is
    // stated against the document's own word count rather than against a number picked by hand — a
    // fourteen-line statement's group is most of the document, and a two-hundred-line one's is not.
    assert.ok(
      range.words < document.stats.words,
      `the note carrying the range is ${range.words} words of the document's ${document.stats.words} — the whole statement again`
    );
    // A search for a merchant's name now lands on the notes that hold it, not on everything. Hydro One
    // is on two lines of this statement, so two notes is CORRECT — what matters is that the keyword
    // half can reach a merchant at all, and that no note carries the whole statement.
    const hydro = notes.filter((note) => note.text.includes('Hydro One'));
    assert.ok(hydro.length >= 1, 'the keyword half cannot reach a merchant');
    assert.ok(
      notes.every((note) => note.words < document.stats.words),
      'a single note still holds the whole statement'
    );
    assert.ok(store.lexical(document.id, 'Hydro One', 5).length > 0, 'the keyword half returns nothing for a merchant');
  } finally {
    close();
  }
});

test('a question about the document\u2019s own date range is not refused, because the range is counted', async () => {
  // 🔴 MEASURED ON A STATEMENT OF ACCOUNTS, 22 Sep 2026: *"What date range does it cover?"* — one of the
  // questions the page itself offers on a statement — was refused in 0.3 s with *"Nothing in this
  // document matched the question closely enough"*, on a document whose first line is *"1 January 2026
  // to 31 March 2026"*. The range had ALREADY been computed in code (`factsFor` pushes a date-range
  // fact for every dated document) and the similarity search threw it away.
  //
  // The stub model is exactly the right instrument for this test, and unusually so: its bag-of-words
  // cosine for this question is ZERO, so the search says "silent" every time. If the answer comes back
  // grounded, it can only be because the computed fact overruled the search.
  const { store, close } = scratch();
  try {
    const seen = [];
    const model = stubModel();
    model.chat = async (messages) => {
      seen.push(messages);
      return 'WHAT THE DOCUMENT SAYS\nIt covers January to March 2026.\n\nWHAT IT SUGGESTS\nNothing further.';
    };
    // 🔴 THE LEDGER, NOT THE DIARY, AND THAT MATTERS. On the diary the search finds a note for this
    // question and the answer is grounded whatever this rule says — a test that would have passed
    // with the overrule switched off, which I checked and then replaced. The ledger's notes contain
    // no word from the question at all (*date*, *range*, *cover* appear nowhere in a statement), so
    // the search says "silent" and only the computed fact can save it.
    const ledger = [
      'STATEMENT OF ACCOUNTS - 1 January 2026 to 31 March 2026',
      '03/01/2026 DEPOSIT Payroll - Northline Logistics $2,410.55',
      '07/01/2026 DEBIT Hydro One $184.20',
      '11/01/2026 DEBIT Freshmart Groceries $236.77',
      '15/01/2026 DEBIT Rogers Wireless $96.35',
      '22/01/2026 DEBIT Halton Property Tax $512.00',
      '19/03/2026 DEBIT Birchwood Dental $340.00',
    ].join('\n');
    const { document } = await indexDocument(store, model, { text: ledger });
    const range = await answer(store, model, document.id, 'What date range does it cover?');
    assert.notEqual(range.mode, 'refused', 'the range question was refused on a similarity score');
    assert.equal(seen.length, 1, 'the model was never asked');
    assert.match(
      seen[0].map((message) => message.content).join('\n'),
      /date-range|January|March/i,
      'the computed range is not in front of the model'
    );
    assert.ok(
      range.computed.some((fact) => fact.kind === 'date-range'),
      'the computed date range is not part of the answer'
    );

    // 🔴 AND THE REFUSAL IS STILL A REFUSAL when the facts do not answer the question: a question the
    // document says nothing about must still cost nothing, which is the rule this one bends. One model
    // call, not two, means the overrule has not leaked into everything.
    const nonsense = await answer(store, model, document.id, 'quantum chromodynamics lattice gauge');
    assert.equal(nonsense.mode, 'refused', 'a question the document cannot answer was sent to the model');
    assert.equal(seen.length, 1, 'the model was asked about something the facts do not cover');
  } finally {
    close();
  }
});

test('a lone letter is still dropped, and a lone digit is still kept', () => {
  // Both halves of the rule, because the fix was a loosening and the guard against
  // loosening too far is the reason the original filter existed. A single letter is
  // noise; a single digit is a day of the month.
  const { store, close } = scratch();
  try {
    assert.deepEqual(store.termsFor('a 6 b'), ['6'], 'one digit survives, one letter does not');
    assert.deepEqual(store.termsFor('x and 27 y'), ['and', '27'], 'words and two-digit days both survive');
  } finally {
    close();
  }
});

test('a question the document says nothing about is refused WITHOUT the model', async () => {
  const { store, close } = scratch();
  try {
    const model = stubModel();
    const { document } = await indexDocument(store, model, { text: diary });
    const result = await retrieve(store, model, document.id, 'quantum chromodynamics lattice gauge', {
      refusalFloor: 0.56,
      useRerank: false,
    });
    assert.equal(result.silent, true);
    assert.deepEqual(result.scored, []);
  } finally {
    close();
  }
});

/* ---------------------------------------------------------------- the answer */

test('a grounded answer carries its dates, places, people and pictures', async () => {
  const { store, close } = scratch();
  try {
    const model = stubModel();
    const { document } = await indexDocument(store, model, { text: diary });
    const result = await answer(store, model, document.id, 'What was the weather like in March?');
    assert.equal(result.mode, 'grounded');
    assert.ok(result.prose.includes('rained'));
    assert.ok(result.sources.length > 0);
    assert.ok(result.details.dates.length > 0, 'the dates it rests on');
    assert.ok(result.details.places.some((mention) => mention.value === 'Grimsby'));
    assert.ok(result.details.people.some((mention) => mention.value === 'Andrea'));
    assert.ok(result.details.images.length > 0, 'the picture in the document');
    assert.ok(result.details.images[0].url.startsWith('https://'));
  } finally {
    close();
  }
});

test('a refusal is a refusal, and the model is not asked', async () => {
  const { store, close } = scratch();
  try {
    const model = stubModel();
    let called = 0;
    const inner = model.chat;
    model.chat = async (...args) => {
      called += 1;
      return inner(...args);
    };
    const { document } = await indexDocument(store, model, { text: diary });
    const result = await answer(store, model, document.id, 'quantum chromodynamics lattice gauge');
    assert.equal(result.mode, 'refused');
    assert.equal(result.prose, '');
    assert.equal(called, 0, 'the model must not be called to agree with the search');
  } finally {
    close();
  }
});

test('a reply the model refuses is reported as a refusal', async () => {
  const { store, close } = scratch();
  try {
    const model = stubModel("The document doesn't say.\n\nNothing further.");
    const { document } = await indexDocument(store, model, { text: diary });
    const result = await answer(store, model, document.id, 'Who is Cecilia?');
    assert.equal(result.mode, 'refused');
    assert.equal(result.raw, "The document doesn't say.\n\nNothing further.");
  } finally {
    close();
  }
});

test('an unknown document is a 404, not a crash', async () => {
  const { store, close } = scratch();
  try {
    await assert.rejects(() => answer(store, stubModel(), 'nope', 'anything'), /no longer here/);
  } finally {
    close();
  }
});

/* ---------------------------------------------------------------- the facts */

test('an ABSENT fact is only ever asserted for a proper noun', () => {
  // The failure this guards: asked "what was the weather like", the tool reported that
  // the word "weather" appears nowhere — true, and completely misleading, because an
  // entry reads "Rain all day". The model believed it and refused the question.
  const built = build(diary, null, []);
  const weather = factsFor('What was the weather like in March?', built.entries, diary);
  assert.equal(
    weather.some((fact) => fact.kind === 'absent' && fact.term === 'weather'),
    false,
    'a common noun must never produce an absent fact'
  );

  const cecilia = factsFor("What is Cecilia's maiden name?", built.entries, diary);
  assert.ok(
    cecilia.some((fact) => fact.kind === 'absent' && fact.term === 'cecilia'),
    'a name that appears nowhere IS a fact worth asserting'
  );
});

test('counts are computed over the whole document, never by the model', () => {
  const built = build(diary, null, []);
  const facts = factsFor('How often is the boiler mentioned?', built.entries, diary);
  const count = facts.find((fact) => fact.kind === 'count' && fact.term === 'boiler');
  assert.ok(count, 'the count must be supplied as a fact');
  assert.equal(count.value, 2);
  assert.equal(count.entries, 2);
  assert.match(factsAsText(facts), /never recount|appears 2 times/);
});

test('a comparison question gets counts for BOTH months', () => {
  const built = build(diary, null, []);
  const facts = factsFor('Which month was worse, March or April?', built.entries, diary);
  const months = facts.filter((fact) => fact.kind === 'months');
  assert.deepEqual(
    months.map((fact) => fact.term),
    ['March', 'April']
  );
  assert.match(months[0].value, /6 entries/);
  assert.match(months[1].value, /3 entries/);
});

test('stopwords do not become subjects', () => {
  const terms = subjectTerms('What was the weather like in March?');
  assert.equal(terms.includes('the'), false);
  assert.equal(terms.includes('like'), false);
});

test('only capitals may be proper nouns', () => {
  assert.deepEqual(properNouns('Who is Cecilia?'), ['cecilia']);
  assert.equal(properNouns('what was the weather like').length, 0);
});

/* ---------------------------------------------------------------- the reply shape */

test('the two headings are read, loosely', () => {
  const shape = readShape('WHAT THE DOCUMENT SAYS\nIt rained.\n\nWHAT IT SUGGESTS\nBring a coat.');
  assert.equal(shape.says, 'It rained.');
  assert.equal(shape.suggests, 'Bring a coat.');
});

test('a reply with no headings is still shown rather than swallowed', () => {
  assert.equal(readShape('It rained.').says, 'It rained.');
});

test('the old wording is still accepted, so a cached reply cannot break the page', () => {
  assert.equal(readShape('WHAT THE DIARY SAYS\nIt rained.').says, 'It rained.');
  assert.equal(isRefusal("The diary doesn't say."), true);
  assert.equal(isRefusal('It rained.'), false);
});

test('a heading written on the SAME LINE as the answer is still a heading', () => {
  // 🔴 MEASURED ON THE LIVE SITE, 20 Sep 2026. The model wrote the second heading on the
  // end of the answer's own line — "…watched the ice breaking up. WHAT IT SUGGESTS Nothing
  // further." — and the reader was shown the words **WHAT IT SUGGESTS** inside their
  // answer, because the parser wanted a newline before the heading and there was none.
  const shape = readShape('The ice was breaking up. WHAT IT SUGGESTS Nothing further.');
  assert.equal(shape.says, 'The ice was breaking up.', 'the heading is not part of the answer');
  assert.equal(isNothingFurther(shape.suggests), true, 'and the empty second half is dropped');
});

test('an ordinary sentence mentioning what it suggests is left alone', () => {
  // The fix above matches in CAPITALS on purpose. Without that, this sentence — which is
  // prose, not a heading — would be cut in half.
  const shape = readShape('WHAT THE DOCUMENT SAYS\nIt rained hard, and what it suggests is a wet week.');
  assert.equal(shape.says, 'It rained hard, and what it suggests is a wet week.');
});

test('isNothingFurther accepts every form the empty second half arrives in', () => {
  assert.equal(isNothingFurther(null), true, 'no second half at all');
  assert.equal(isNothingFurther('Nothing further.'), true);
  assert.equal(isNothingFurther('  nothing further  '), true, 'however it is spaced or cased');
  assert.equal(isNothingFurther('Read together, the notes suggest nothing further.'), true, 'the form the model wrote');
  assert.equal(isNothingFurther('Read together, the notes suggest a wet month.'), false);
});

test('a refusal is still a refusal when the model invents a heading above it', () => {
  // 🔴 MEASURED LIVE, 20 Sep 2026. Asked something the diary does not answer, the model
  // wrote its OWN heading — "WHAT THE DOCUMENT DOESN'T SAY" — above the refusal. The check
  // read line one, saw a heading, and called the reply **grounded**; the refusal never
  // reached the refusal path, which is the one path this app is built around.
  assert.equal(isRefusal("WHAT THE DOCUMENT DOESN'T SAY\nThe document doesn't say."), true);
  assert.equal(isRefusal("WHAT THE DOCUMENT DOESN'T SAY\nThe document doesn't say.\n\nWHAT IT SUGGESTS Nothing further."), true);
});

test('a grounded answer that merely mentions the refusal words is not a refusal', () => {
  // The other half of the same rule. This must stay strict, or a real answer gets thrown
  // away and the reader is told the document is silent when it was not.
  assert.equal(isRefusal("The document doesn't say when the boiler was fixed, but it was cold on 4 March."), true, 'the refusal still leads');
  assert.equal(isRefusal('It was cold on 4 March, and the diary does not say why.'), false, 'the phrase is not the answer');
});

/* --------------------------------------------------------------- the grid */

test('a document indexed before the heat map existed still gets one', async () => {
  // 🔴 THE FAULT THIS GUARDS, measured on the live demo on 20 September 2026. The built-in diary
  // came back `reused: true` from an index written by the older build, `mentions.byMonth` was
  // absent from the record, and the heat map therefore hid itself. The chart was written, tested,
  // deployed and correct — and no visitor could ever have seen it.
  //
  // So what is asserted is not "the grid is right when the indexer builds it" (the chart tests
  // cover that). It is: **a record that never had a grid gets one on read, and it agrees with the
  // one the indexer would have built.**
  const { dir, store, close } = scratch();
  try {
    const model = stubModel();
    const { document } = await indexDocument(store, model, { text: diary });
    const fresh = store.getDocument(document.id).mentions.byMonth;
    assert.ok(fresh && fresh.series.length > 0, 'a freshly indexed document has no grid at all');

    // Put the row back the way the old build left it: tallies present, no grid.
    const db = new DatabaseSync(join(dir, 'test.db'));
    const row = db.prepare('SELECT mentions_json AS j FROM documents WHERE id = ?').get(document.id);
    const stripped = JSON.parse(row.j);
    delete stripped.byMonth;
    db.prepare('UPDATE documents SET mentions_json = ? WHERE id = ?').run(
      JSON.stringify(stripped),
      document.id
    );
    db.close();

    const filled = store.getDocument(document.id).mentions.byMonth;
    assert.deepEqual(
      filled,
      fresh,
      'the grid filled in on read disagrees with the one the indexer built'
    );

    // And it is written back, so the work is done once rather than on every read.
    const check = new DatabaseSync(join(dir, 'test.db'));
    const kept = JSON.parse(
      check.prepare('SELECT mentions_json AS j FROM documents WHERE id = ?').get(document.id).j
    );
    check.close();
    assert.deepEqual(kept.byMonth, fresh, 'the filled-in grid was not written back to the record');
  } finally {
    close();
  }
});

test('and a document with nothing to grid gets no grid, rather than an empty axis', async () => {
  const { store, close } = scratch();
  try {
    const model = stubModel();
    // Undated and nameless: no months, no people, no places, no amounts.
    const text = [
      'Some notes about the thing, and a little more of the same, and then a third line so the',
      'document is long enough to index at all. Nothing here is dated, nothing is named, and',
      'nothing is bought, which is exactly the case the chart has to decline.',
      'It goes on for a while so that the length rule is satisfied and the text is real prose.',
      'A fourth line, and a fifth, and a sixth, so there is something to read.',
      'A seventh line. An eighth line. A ninth line, which is enough.',
    ].join('\n');
    const { document } = await indexDocument(store, model, { text });
    assert.equal(document.stats.months, 0, 'the fixture is meant to have no months');
    assert.equal(
      store.getDocument(document.id).mentions.byMonth,
      undefined,
      'a chart was produced for a document with nothing to put on it'
    );
  } finally {
    close();
  }
});

/* ------------------------------------------------------------ while it reads */

test('the indexer reports what it is doing, in counts that are real', async () => {
  // 🔴 THIS IS WHAT THE CHART ON THE PAGE PLOTS. George, 20 Sep 2026: *"can we show a chart while
  // its indexing?"* — and a chart is only worth showing if its points mean something. So the
  // assertions are about the MEANING: three stages in order, a total that is the note count, a
  // count that never goes backwards, and a first report before any batch has been sent.
  const { store, close } = scratch();
  try {
    const seen = [];
    await indexDocument(store, stubModel(), { text: diary }, (progress) => seen.push(progress));

    assert.deepEqual(
      [...new Set(seen.map((p) => p.stage))],
      ['reading', 'embedding', 'saving'],
      'the stages should be reported in the order the work happens'
    );

    const embedding = seen.filter((p) => p.stage === 'embedding');
    assert.ok(embedding.length >= 2, 'an embedding stage that reports once is not progress');
    assert.equal(embedding[0].done, 0, 'the first report must come before any batch is sent');
    assert.equal(embedding[0].total, 9, 'the diary is nine notes, and the total is known up front');
    assert.equal(embedding[embedding.length - 1].done, 9, 'and the last report must arrive at the total');
    for (let i = 1; i < embedding.length; i += 1) {
      assert.ok(embedding[i].done >= embedding[i - 1].done, 'a count that goes backwards is not a count');
      assert.ok(embedding[i].ms >= embedding[i - 1].ms, 'and neither is a clock that goes backwards');
    }
    assert.ok(
      seen.every((p) => Number.isFinite(p.ms) && p.ms >= 0 && p.done <= p.total),
      'every report carries a real elapsed time and never overshoots its own total'
    );
  } finally {
    close();
  }
});

test('and an index that is reused says so instead of pretending to work', async () => {
  const { store, close } = scratch();
  try {
    const model = stubModel();
    await indexDocument(store, model, { text: diary });
    const seen = [];
    const again = await indexDocument(store, model, { text: diary }, (progress) => seen.push(progress));
    assert.equal(again.reused, true);
    assert.deepEqual(
      [...new Set(seen.map((p) => p.stage))],
      ['reading'],
      'a reused index does no embedding, and must not report a stage it never ran'
    );
  } finally {
    close();
  }
});

/* ------------------------------------------------- while a question is answered */

test('an answer reports the stages it really went through, with their measured times', async () => {
  // 🔴 THE CHART THE READER SEES WHILE WAITING IS ONLY WORTH SHOWING IF ITS NUMBERS ARE REAL. George,
  // 20 Sep 2026: *"when i ask a question, is there some sort of progress chart that can be applied?"*
  // So the assertions are about meaning, not shape: three stages in the order the work happens, a
  // search that hands over what it found and what it kept, and a model stage reported TWICE — once
  // before the call, with no duration, because a running stage must not claim one, and once after.
  const { store, close } = scratch();
  try {
    const model = stubModel();
    const { document } = await indexDocument(store, model, { text: diary });
    const seen = [];
    await answer(store, model, document.id, 'What did Andrea bring?', {
      onStage: (stage) => seen.push({ ...stage }),
    });

    assert.deepEqual(
      [...new Set(seen.map((stage) => stage.stage))],
      ['search', 'notes', 'model'],
      'the stages are reported in the order the work happens'
    );

    const search = seen.find((stage) => stage.stage === 'search');
    assert.ok(Number.isFinite(search.tookMs) && search.tookMs >= 0, 'the search carries its own time');
    assert.ok(search.found > 0, 'and what it found');
    assert.ok(search.kept > 0 && search.kept <= search.found, 'and what it kept, which cannot exceed it');

    const notes = seen.filter((stage) => stage.stage === 'notes');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].silent, false, 'this question is answerable, so no model was skipped');

    const modelStages = seen.filter((stage) => stage.stage === 'model');
    assert.equal(modelStages.length, 2, 'the model is announced before the call and reported after it');
    assert.equal(
      modelStages[0].tookMs,
      undefined,
      'the running report must NOT claim a duration — that is the one thing it cannot know'
    );
    assert.ok(modelStages[1].tookMs >= 0, 'and the finished one carries a real number');

    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i].ms >= seen[i - 1].ms, 'and the clock never goes backwards');
    }
  } finally {
    close();
  }
});

test('and a question with nothing to answer from reports no model stage at all', async () => {
  // The silent path: the search found nothing close enough, so no model was called. The chart must
  // show exactly the stages that ran — a row for a stage that never happened would be a picture of
  // work that was never done.
  const { store, close } = scratch();
  try {
    const model = stubModel();
    const { document } = await indexDocument(store, model, { text: diary });
    const seen = [];
    // 🔴 FORCED, NOT HOPED FOR. A question of words that appear nowhere in the notes gets no keyword
    // hit, so an impossible `refusalFloor` makes the document silent by construction — the first
    // version of this test asked an ordinary question and RETURNED EARLY if the retrieval happened
    // to find something, which is a check that passes by doing nothing. (An ordinary question cannot
    // be used: `refusalFloor: 2` alone did NOT silence it, because a keyword hit outranks the floor.)
    const result = await answer(store, model, document.id, 'Zzyzx quokka perihelion?', {
      retrieve: { refusalFloor: 2, useRerank: false },
      onStage: (stage) => seen.push({ ...stage }),
    });
    assert.equal(result.mode, 'refused', 'nothing matched and the floor was impossible, so it must refuse');
    assert.equal(
      seen.some((stage) => stage.stage === 'model'),
      false,
      'no model was called, so no model stage may be reported'
    );
    assert.equal(seen.find((stage) => stage.stage === 'notes')?.silent, true, 'and the reason is said out loud');
  } finally {
    close();
  }
});
