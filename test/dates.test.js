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
  entryPeriod,
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

/* ------------------------------------------------------- the period of an entry */

test('a period is read from what the entry actually writes', () => {
  // 🔴 A RESUME IS NOT A DIARY. George, 20 Sep 2026, on his own resume: *"can you make the width of
  // the bar equal to the start and end for this timeline?? … i suppose i should assume it will not
  // always be a resume."* The parser kept only the FIRST date, so a career timeline was three lonely
  // months — `July 2021`, `March 2018`, `January 2017` — and the width of a bar meant nothing.
  assert.deepEqual(entryPeriod('Senior Software Engineer | July 2021 to September 2026, Remote'), {
    endMonth: '2026-09',
    openEnded: false,
  });
  assert.deepEqual(entryPeriod('March 2018 to June 2021, Remote'), { endMonth: '2021-06', openEnded: false });
  assert.deepEqual(entryPeriod('January 2017 – February 2018, Windsor'), { endMonth: '2018-02', openEnded: false });
  assert.deepEqual(entryPeriod('6 March 2026 until 9 April 2026'), { endMonth: '2026-04', openEnded: false });
  // ⚠ A BARE YEAR IS NOT PLACEABLE ANYWHERE IN THIS PARSER, AND THAT IS A LIMIT, NOT A CHOICE MADE
  // HERE. `findDates` has no pattern for a year on its own — so `2017 to 2019` yields no period AND
  // no month, and the entry is not on the timeline at all. Written down rather than guessed at:
  // giving a bare year a place on the axis is a change to the date rules, not to this.
  assert.deepEqual(entryPeriod('2017 to 2019'), { endMonth: null, openEnded: false });
});

test('and a day with no end stays a day', () => {
  // The diary case, which is the same rule read the other way: one date is a point, not a period.
  assert.deepEqual(entryPeriod('4 March 2026\nCold again. The boiler made the noise it makes.'), {
    endMonth: null,
    openEnded: false,
  });
  assert.deepEqual(entryPeriod('Nothing here is dated at all.'), { endMonth: null, openEnded: false });
});

test('two dates near each other are not joined into a period', () => {
  // 🔴 THE GUARD THAT MAKES THE FEATURE HONEST. A range word has to be THERE. Two dates in one
  // paragraph are two facts, and joining them would invent a period the document never wrote —
  // which is the one thing a timeline must not do.
  assert.deepEqual(entryPeriod('I saw Sam on 4 March 2026, and again on 9 April 2026.'), {
    endMonth: null,
    openEnded: false,
  });
  assert.deepEqual(entryPeriod('March 2018 was cold. June 2021 was not.'), { endMonth: null, openEnded: false });
});

test('a period written as still running says so instead of inventing an end', () => {
  // `to Present` has no end date, and the honest answer is to say the end was never written — the
  // page draws the bar to the end of the document's own timeline and tells the reader that is what
  // it did.
  assert.deepEqual(entryPeriod('Senior Engineer | July 2021 to Present'), { endMonth: null, openEnded: true });
  assert.deepEqual(entryPeriod('Developer, February 2019 — Current'), { endMonth: null, openEnded: true });
});

test('a period with no year anywhere is left alone', () => {
  // Half a period cannot be placed on an axis. A bar drawn from a guess is worse than no bar, so
  // the end is refused and the entry stays whatever the start made it.
  assert.deepEqual(entryPeriod('March to April, cold throughout.'), { endMonth: null, openEnded: false });
});
