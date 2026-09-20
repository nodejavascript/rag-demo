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

import { buildSpine, continuousMonths, emptyMonths } from '../dist/charts.js';

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
