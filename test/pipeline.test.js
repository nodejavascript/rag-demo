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
import { isNothingFurther, isRefusal, readShape } from '../dist/prompt.js';

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
