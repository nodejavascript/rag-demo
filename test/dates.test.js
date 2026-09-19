/**
 * Dates, and the three refusals that make them trustworthy.
 *
 * These tests exist because each rule below was a decision with a cost, and a rule
 * that is not asserted is a rule that quietly reverts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dominantYear,
  entryDate,
  entryMonth,
  findDates,
  monthLabel,
} from '../dist/dates.js';

test('a full written date is claimed', () => {
  const hits = findDates('6 March 2026 the boiler failed');
  assert.equal(hits[0]?.date, '2026-03-06');
  assert.equal(hits[0]?.raw, '6 March 2026');
  assert.equal(hits[0]?.inferredYear, false);
});

test('day-first and month-first both work', () => {
  assert.equal(findDates('on 6 March 2026')[0]?.date, '2026-03-06');
  assert.equal(findDates('on March 6, 2026')[0]?.date, '2026-03-06');
  assert.equal(findDates('on 6th March 2026')[0]?.date, '2026-03-06');
  assert.equal(findDates('on Mar 6 2026')[0]?.date, '2026-03-06');
  assert.equal(findDates('on 2026-03-06')[0]?.date, '2026-03-06');
});

test('a month and a year is a month, never a day', () => {
  const [hit] = findDates('March 2026 was cold');
  assert.equal(hit?.date, null, 'no day may be claimed');
  assert.equal(hit?.monthOnly, true);
  assert.equal(hit?.month, 3);
  assert.equal(hit?.year, 2026);
});

test('a date that reads two ways is left alone', () => {
  const [hit] = findDates('filed 06/03/2026 with the office');
  assert.equal(hit?.date, null, 'the order cannot be guessed');
  assert.equal(hit?.ambiguous, true);
  assert.equal(hit?.raw, '06/03/2026');
});

test('an unambiguous numeric date IS claimed', () => {
  // 25 cannot be a month, so the reading is forced and no guess is involved.
  assert.equal(findDates('filed 25/03/2026')[0]?.date, '2026-03-25');
});

test('an impossible day is not a date', () => {
  assert.equal(findDates('31 February 2026')[0]?.date, null);
});

test('a day and month with no year is dated by the year it was given', () => {
  const hit = entryDate('4 March\nCold again.', 2026);
  assert.equal(hit?.date, '2026-03-04');
  assert.equal(hit?.inferredYear, true, 'the year must be marked as worked out');
});

test('a document that writes no year anywhere yields no claimed date', () => {
  // No year is written and none was supplied, so there is no date to label the entry
  // with at all — the entry is returned undated rather than guessed at.
  assert.equal(entryDate('4 March\nCold again.', null), null);
});

test('the dominant year is the one written most often', () => {
  assert.equal(dominantYear('in 2026 and again in 2026, once in 2025'), 2026);
  assert.equal(dominantYear('no years here at all'), null);
  assert.equal(dominantYear('2,013 and 2,014 are not years'), null);
});

test('a month for the timeline, at month precision only', () => {
  assert.equal(entryMonth('July 2021 to September 2026', null), '2021-07');
  assert.equal(entryMonth('6 March 2026', null), '2026-03');
  assert.equal(entryMonth('nothing dated here', null), null);
});

test('the month label is short enough for an axis', () => {
  assert.equal(monthLabel('2026-03'), 'Mar 26');
});

test('two dates in one entry are both found, in order', () => {
  const hits = findDates('From 3 March 2026 until 9 April 2026 it rained.');
  assert.deepEqual(
    hits.map((hit) => hit.date),
    ['2026-03-03', '2026-04-09']
  );
});
