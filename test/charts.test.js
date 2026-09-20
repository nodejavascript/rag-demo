/**
 * The two things the page draws that the document does not hand over: the month series, and
 * the spine the answer is drawn on.
 *
 * 🔴 BOTH EXIST BECAUSE A CHART LIED.
 *
 * The timeline drew only the months that HAD entries, side by side — so a diary with three
 * entries in March and one in November drew as **two adjacent bars**, and a document with
 * nine months of silence in it looked continuous. A missing month is information; a chart is
 * not allowed to hide it.
 *
 * And nothing on the page said where an answer came from. The spine does, and the only thing
 * that can go wrong with it is arithmetic: the cells must account for every entry, and only
 * the entries that were really retrieved may be marked. Both are asserted here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFunnel, buildMentionMonths, buildSpine, continuousMonths, emptyMonths } from '../dist/charts.js';

/* ---------------------------------------------------------------- the month series */

test('the months with nothing in them are filled in', () => {
  // The real shape that caused this: entries in March and November, and nothing between.
  const series = continuousMonths(
    [
      { month: '2026-03', entries: 3 },
      { month: '2026-11', entries: 1 },
    ],
    '2026-03-04',
    '2026-11-18'
  );
  assert.deepEqual(
    series.map((point) => point.month),
    ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'],
    'every month from the first to the last, in order'
  );
  assert.deepEqual(
    series.map((point) => point.entries),
    [3, 0, 0, 0, 0, 0, 0, 0, 1],
    'the quiet months are present and are zero, not missing'
  );
  assert.equal(emptyMonths(series), 7);
});

test('a series with no gaps is left exactly as it was', () => {
  const given = [
    { month: '2026-01', entries: 2 },
    { month: '2026-02', entries: 5 },
  ];
  assert.deepEqual(continuousMonths(given, '2026-01-09', '2026-02-01'), given);
  assert.equal(emptyMonths(given), 0);
});

test('a document with no dates at all yields no series rather than an invented month', () => {
  assert.deepEqual(continuousMonths([], null, null), []);
});

test('a wrong year cannot turn the axis into a loop that never ends', () => {
  // 1200 iterations is the guard. This must return, not hang — it runs in a browser tab.
  const series = continuousMonths([{ month: '1972-01', entries: 1 }], '1972-01-01', '2026-01-01');
  assert.equal(series.length, 649, '1972-01 through 2026-01 inclusive');
  assert.equal(series[0].month, '1972-01');
  assert.equal(series[series.length - 1].month, '2026-01');
});

test('one month is one point', () => {
  const series = continuousMonths([{ month: '2026-05', entries: 4 }], '2026-05-02', '2026-05-30');
  assert.deepEqual(series, [{ month: '2026-05', entries: 4 }]);
});

/* ---------------------------------------------------------------- the spine */

const entries = [
  { index: 0, label: '4 March 2026', date: '2026-03-04', month: '2026-03' },
  { index: 1, label: '6 March 2026', date: '2026-03-06', month: '2026-03' },
  { index: 2, label: '11 March 2026', date: '2026-03-11', month: '2026-03' },
  { index: 3, label: '2 April 2026', date: '2026-04-02', month: '2026-04' },
];

test('only the entries that were retrieved are marked', () => {
  const spine = buildSpine(entries, [1, 3]);
  assert.equal(spine.mode, 'entry');
  assert.deepEqual(
    spine.items.map((item) => item.cited),
    [false, true, false, true],
    'exactly the cited entries, and nothing else'
  );
  assert.equal(spine.total, 4);
});

test('a document too long to draw entry by entry is drawn by span, and loses nothing', () => {
  const many = Array.from({ length: 1000 }, (_, at) => ({
    index: at,
    label: `Entry ${at}`,
    date: null,
    // Ten to a month, so the runs are predictable.
    month: `2026-${String(Math.floor(at / 100) + 1).padStart(2, '0')}`,
  }));
  const spine = buildSpine(many, [7, 640], 400);
  assert.equal(spine.mode, 'month', 'past the limit the cells are spans, and `mode` says so');
  assert.ok(spine.items.length < 400, 'the row is drawable');
  assert.equal(
    spine.items.reduce((sum, item) => sum + item.entries, 0),
    1000,
    'every entry still accounted for — a coarser chart, never a short one'
  );
  assert.equal(
    spine.items.filter((item) => item.cited).length,
    2,
    'the two cited entries light up the two spans they fall in'
  );
  assert.equal(spine.total, 1000);
});

test('a document with no entries draws nothing rather than crashing', () => {
  const spine = buildSpine([], [1, 2]);
  assert.deepEqual(spine.items, []);
  assert.equal(spine.total, 0);
});

/* ---------------------------------------------------------------- who appears when */

const MONTHS = ['2026-03', '2026-04'];
const ENTRIES = [{ month: '2026-03' }, { month: '2026-04' }, { month: null }];
const TOP = [
  { value: 'Grimsby', kind: 'place' },
  { value: 'Andrea', kind: 'person' },
];

function chunk(entryIndex, people = [], places = [], amounts = []) {
  return { entryIndex, people, places, amounts };
}

test('a mention is counted in the month its note belongs to', () => {
  const grid = buildMentionMonths(
    [chunk(0, [], ['Grimsby']), chunk(0, [], ['Grimsby']), chunk(1, ['Andrea'])],
    MONTHS,
    ENTRIES,
    TOP
  );
  assert.deepEqual(grid.months, MONTHS, 'nothing landed in the undated column, so it is not in the axis');
  const grimsby = grid.series.find((row) => row.name === 'Grimsby');
  const andrea = grid.series.find((row) => row.name === 'Andrea');
  assert.deepEqual(grimsby.counts, [2, 0], 'two notes in March name Grimsby, none in April');
  assert.deepEqual(andrea.counts, [0, 1]);
});

test('a mention with no month is shown as undated, never given one', () => {
  // 🔴 The tempting shortcut is to drop it or to file it under the nearest month. Both would
  // put a place somewhere the document never wrote it, on a chart that exists to say where
  // things are written.
  const grid = buildMentionMonths([chunk(2, [], ['Grimsby'])], MONTHS, ENTRIES, TOP);
  assert.deepEqual(grid.months, [...MONTHS, 'undated'], 'the column appears because something is in it');
  assert.deepEqual(grid.series.find((row) => row.name === 'Grimsby').counts, [0, 0, 1]);
  assert.equal(grid.series.find((row) => row.name === 'Andrea').counts.length, 3, 'every row is as wide as the axis');
});

test('a name is matched whatever case it was written in', () => {
  const grid = buildMentionMonths([chunk(0, [], ['GRIMSBY'])], MONTHS, ENTRIES, TOP);
  assert.deepEqual(grid.series.find((row) => row.name === 'Grimsby').counts, [1, 0]);
});

test('no mentions and no notes both give an empty grid rather than a broken chart', () => {
  assert.deepEqual(buildMentionMonths([], MONTHS, ENTRIES, TOP), { months: [], series: [] });
  assert.deepEqual(buildMentionMonths([chunk(0, [], ['Grimsby'])], MONTHS, ENTRIES, []), {
    months: [],
    series: [],
  });
});

/* ---------------------------------------------------------------- the funnel */

test('the funnel narrows, and every stage reports what the stage before it passed on', () => {
  const stages = buildFunnel({ notes: 29, ranked: 60, reranked: 30, shown: 8 });
  assert.deepEqual(
    stages.map((stage) => stage.notes),
    [29, 60, 30, 8],
    'the document, what the two searches proposed, what the reranker weighed, what was shown'
  );
  assert.equal(stages[0].notes >= stages[stages.length - 1].notes, true, 'it ends with fewer than it started');
});

test('a stage that never ran is left out, not drawn as a stage that found nothing', () => {
  // 🔴 A reranker that was never configured and a reranker that scored nothing look
  // identical on a chart, and mean opposite things.
  const stages = buildFunnel({ notes: 29, ranked: 12, shown: 8 });
  assert.equal(stages.some((stage) => /reranker/i.test(stage.label)), false, 'no reranker in the list');
  assert.equal(stages.length, 3);
});

test('a refusal stops the funnel where the refusal was decided', () => {
  const stages = buildFunnel({ notes: 29, shown: 0, silent: true });
  assert.equal(stages.length, 2, 'the document, and the stage that said no');
  assert.equal(stages[1].notes, 0);
  assert.match(stages[1].note, /no model was called/i);
});
