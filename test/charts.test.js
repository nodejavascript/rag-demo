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

import {
  axisMonths,
  buildFunnel,
  buildMentionMonths,
  buildNoteMap,
  buildSpans,
  buildSpine,
  continuousMonths,
  emptyMonths,
  gridRows,
} from '../dist/charts.js';

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

/* -------------------------------------------------------------- the timeline */

test('a bar runs from the start an entry states to the end it states', () => {
  // 🔴 THE CLAIM THIS CHART MAKES, IN ONE ASSERTION. George, 20 Sep 2026, on his own resume: *"can
  // you make the width of the bar equal to the start and end for this timeline?? … i suppose i
  // should assume it will not always be a resume."* A resume states periods; the chart used to
  // count them into month buckets, so a career was three lonely months and the width meant nothing.
  const spans = buildSpans([
    { label: 'Senior Software Engineer, First Canadian Title', month: '2021-07', endMonth: '2026-09' },
    { label: 'Software Engineer, Utherverse Digital', month: '2018-03', endMonth: '2021-06' },
    { label: 'Developer, IOU Concepts', month: '2017-01', endMonth: '2018-02' },
  ]);

  assert.equal(spans.hasPeriods, true);
  assert.equal(spans.pointsOnly, false);
  assert.equal(spans.from, '2017-01', 'the axis starts where the earliest entry starts');
  assert.equal(spans.to, '2026-09', 'and ends where the latest one ends');
  assert.equal(axisMonths(spans), 117, 'and covers every month between, inclusively');
  assert.deepEqual(
    spans.spans.map((span) => [span.from, span.to]),
    [
      ['2021-07', '2026-09'],
      ['2018-03', '2021-06'],
      ['2017-01', '2018-02'],
    ],
    'each bar keeps the two dates exactly as the entry wrote them'
  );
  // The width IS the period: `July 2021 to September 2026` is 63 months of axis, not one slot.
  const months = (from, to) => {
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    return ty * 12 + tm - (fy * 12 + fm) + 1;
  };
  assert.deepEqual(spans.spans.map((span) => months(span.from, span.to)), [63, 40, 14]);
  assert.ok(spans.spans.every((span) => !span.point), 'a stated period is a bar, never a tick');
});

test('a diary stays points, and they all share one row', () => {
  // The other half of "it will not always be a resume": days have no length, so two of them cannot
  // overlap, and giving each its own row would turn nine diary entries into nine empty rows.
  const spans = buildSpans([
    { label: '4 March 2026', month: '2026-03' },
    { label: '6 March 2026', month: '2026-03' },
    { label: '17 April 2026', month: '2026-04' },
  ]);
  assert.equal(spans.pointsOnly, true);
  assert.equal(spans.hasPeriods, false);
  assert.equal(spans.lanes, 1, 'one row of ticks');
  assert.deepEqual([...new Set(spans.spans.map((span) => span.lane))], [0]);
  assert.ok(spans.spans.every((span) => span.point));
  assert.equal(spans.from, '2026-03');
  assert.equal(spans.to, '2026-04');
});

test('two periods that overlap in time get a row each', () => {
  // 🔴 Two bars drawn through each other would say the document did two things at once, which is a
  // claim this app must never make by accident.
  const spans = buildSpans([
    { label: 'Job A', month: '2020-01', endMonth: '2022-06' },
    { label: 'Job B', month: '2021-01', endMonth: '2023-01' },
  ]);
  assert.deepEqual(spans.spans.map((span) => span.lane), [0, 1], 'the second overlaps the first');
  assert.equal(spans.lanes, 2);

  // And the reverse: two that do NOT overlap may share a row, so a tidy career is one line of bars.
  const sequential = buildSpans([
    { label: 'Then', month: '2010-01', endMonth: '2012-12' },
    { label: 'Now', month: '2013-01', endMonth: '2015-06' },
  ]);
  assert.deepEqual(sequential.spans.map((span) => span.lane), [0, 0], 'they never overlap');
  assert.equal(sequential.lanes, 1);
});

test('an open-ended period runs to the end of what the document dates, and says so', () => {
  // `July 2021 to Present` has no end date. The bar runs to the axis end — the last thing THE
  // DOCUMENT dates, never today — and the flag is what lets the caption say which bars did that.
  const spans = buildSpans([
    { label: 'Still here', month: '2021-07', openEnded: true },
    { label: 'Before that', month: '2017-01', endMonth: '2021-06' },
  ]);
  const open = spans.spans.find((span) => span.label === 'Still here');
  assert.equal(open.openEnded, true);
  assert.equal(open.to, '2021-07', 'no end month is invented — it is drawn to the axis end instead');
  assert.equal(spans.to, '2021-07');
  assert.equal(spans.spans.find((span) => span.label === 'Before that').openEnded, false);
});

test('an entry with no placeable month is left off the timeline entirely', () => {
  // A heading with no date on it is not a point in time, and a bar for it would be an invention.
  const spans = buildSpans([
    { label: 'SKILLS', month: null },
    { label: 'Real job', month: '2020-05', endMonth: '2021-05' },
  ]);
  assert.equal(spans.spans.length, 1);
  assert.equal(spans.spans[0].label, 'Real job');
});

test('and a document with no dates at all yields no timeline rather than an empty axis', () => {
  const spans = buildSpans([{ label: 'Terms', month: null }, { label: 'More terms', month: null }]);
  assert.deepEqual(spans.spans, []);
  assert.equal(spans.from, '', 'no axis is claimed');
  assert.equal(axisMonths(spans), 0);
});

/* ------------------------------------------------- and what the heat map ranks */

test('the heat map\u2019s rows are ranked by how much the document mentions them', () => {
  // 🔴 George, 22 September 2026: *"Who and what appears when could sort my the value highest on
  // top"*. The rows used to keep the tally's own grouping — every person, then every place, then
  // every amount — so the chart's order said which KIND each thing was rather than which one the
  // document is most about.
  //
  // The counts are deliberately out of step with the kinds here: sorting within a kind, or sorting
  // the kinds, cannot produce this order. Only ranking all five rows by count can.
  const rows = gridRows({
    people: [
      { value: 'Necole', count: 4 },
      { value: 'Kennedy', count: 1 },
    ],
    places: [
      { value: 'Windsor', count: 9 },
      { value: 'Hamilton', count: 2 },
    ],
    amounts: [{ value: '$1,200', count: 6 }],
  });
  assert.deepEqual(
    rows.map((row) => row.value),
    ['Windsor', '$1,200', 'Necole', 'Hamilton', 'Kennedy'],
    'the rows are not ranked highest-first across kinds'
  );
  // And the kind travels with the value, because the grid draws from this list and nothing else.
  assert.deepEqual(rows.map((row) => row.kind), ['place', 'amount', 'person', 'place', 'person']);
});

test('the note map counts what the search actually has to work with', () => {
  // 🔴 THE CHART THAT WAS MISSING. Two faults on 22 Sep 2026 were invisible without it: a statement of
  // accounts that came out as ONE note of about 1,300 characters — nothing inside it could be found on
  // its own, and the document was refused its own date range — and a resume question answered from
  // eight notes of twenty. The numbers here are counted in code and the caption is written from them;
  // the model has no part in either.
  const notes = [
    { label: 'a', text: 'x'.repeat(100), words: 10 },
    { label: 'b', text: 'y'.repeat(300), words: 30 },
    { label: 'c', text: 'z'.repeat(600), words: 60 },
  ];
  const map = buildNoteMap(notes);
  assert.equal(map.total, 3);
  assert.equal(map.words, 100);
  assert.equal(map.cells[1].chars, 300);
  assert.ok(
    Math.abs(map.cells.reduce((sum, cell) => sum + cell.share, 0) - 1) < 1e-9,
    'the shares must add up to one document'
  );
  assert.ok(Math.abs(map.cells[2].share - 0.6) < 1e-9, 'the widest cell must be 60% of the strip');
  assert.equal(map.longest, 0.6);
  assert.equal(map.dominated, true, 'a note holding most of the document was not flagged');
  assert.match(map.caption, /3 notes/);
  assert.match(map.caption, /60% of the document/, 'the caption must say what the chart shows');

  // One note IS the fault this chart exists to expose, so it says so in words rather than drawing a
  // single bar and leaving the reader to work it out.
  const one = buildNoteMap([{ label: 'all', text: 'x'.repeat(1300), words: 220 }]);
  assert.equal(one.total, 1);
  assert.equal(one.dominated, false, 'a single note is not "dominated" — there is nothing to compare it with');
  assert.match(one.caption, /One note, holding all 220 words/);
  assert.match(one.caption, /nothing inside it can be found on its own/);

  // And no notes at all is a failure of the index, not a document with nothing in it.
  assert.equal(buildNoteMap([]).total, 0);
  assert.match(buildNoteMap([]).caption, /No notes/);
});
