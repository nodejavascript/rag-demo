/**
 * Where the document disagrees with itself.
 *
 * 🔴 **THE NEGATIVE ASSERTIONS MATTER MOST, HERE MORE THAN ANYWHERE.** A panel that says
 * "your document contradicts itself" and is wrong once asks the reader to distrust their own
 * document on the strength of a guess — which is the opposite of what this app is for. So
 * the bulk of this file is testing that conflicts are **not** reported: an ordered timeline,
 * a run of undated entries, two names that are merely short, two names that are merely
 * different.
 *
 * Only three checks exist and each is arithmetic over what the parser extracted. Anything
 * needing meaning — whether two mentions are the same thing, whether a total matches its
 * parts — is deliberately absent, and that restraint is asserted too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseConflicts } from '../dist/conflicts.js';

const noMentions = { places: [], people: [], amounts: [] };

/** A minimal entry, so each test states only the fields it is about. */
function entry(index, date, extra = {}) {
  return {
    index,
    heading: null,
    date,
    dateRaw: date,
    inferredYear: false,
    ambiguousDate: false,
    monthOnly: false,
    ...extra,
  };
}

test('an entry whose date runs backwards is reported', () => {
  // The useful failure: a diary that goes forward, forward, backwards usually means a page
  // was lost or a block was pasted in the wrong place, and it silently changes the timeline.
  const report = analyseConflicts({
    entries: [entry(0, '2026-03-04'), entry(1, '2026-03-18'), entry(2, '2026-03-06')],
    mentions: noMentions,
    documentText: '',
  });
  assert.equal(report.outOfOrder.length, 1);
  assert.equal(report.outOfOrder[0].date, '2026-03-06');
  assert.equal(report.outOfOrder[0].previousDate, '2026-03-18');
  assert.equal(report.outOfOrder[0].at, 2);
});

test('an ordered timeline reports nothing', () => {
  const report = analyseConflicts({
    entries: [entry(0, '2026-03-04'), entry(1, '2026-03-06'), entry(2, '2026-03-18')],
    mentions: noMentions,
    documentText: '',
  });
  assert.deepEqual(report.outOfOrder, []);
});

test('undated entries between dated ones neither hide nor invent a break', () => {
  // 🔴 The classic false positive: comparing each entry with the one before it, rather than
  // with the last one that HAD a date. A heading or an undated note in between would then
  // reset the comparison and either lose a real break or manufacture one.
  const report = analyseConflicts({
    entries: [
      entry(0, '2026-03-04'),
      entry(1, null),
      entry(2, null),
      entry(3, '2026-03-18'),
      entry(4, null),
      entry(5, '2026-03-06'),
    ],
    mentions: noMentions,
    documentText: '',
  });
  assert.equal(report.outOfOrder.length, 1, 'exactly one break, found through the gaps');
  assert.equal(report.outOfOrder[0].previousDate, '2026-03-18');
});

test('a name written two ways is reported, and worded as a fact about spelling', () => {
  // 🔴 Widened on purpose: the first version compared only names the extractor had ACCEPTED,
  // and found nothing on a document containing `Grimsby` and `Grimbsy` — because a
  // single-word place is only accepted when it is in the gazetteer, so the misspelling is
  // rejected before the check ever sees it. It could only find names already spelled right.
  const report = analyseConflicts({
    entries: [],
    mentions: {
      places: [
        { value: 'Grimsby', count: 3, entries: [0] },
        { value: 'Grimbsy', count: 1, entries: [2] },
      ],
      people: [],
      amounts: [],
    },
    documentText: 'Work in Grimsby. A follow-up at Grimbsy two weeks later.',
  });
  assert.equal(report.spelledTwoWays.length, 1);
  assert.deepEqual(
    [report.spelledTwoWays[0].a, report.spelledTwoWays[0].b].sort(),
    ['Grimbsy', 'Grimsby']
  );
  assert.equal(report.spelledTwoWays[0].kind, 'place');
});

test('two names that are merely SHORT are not reported', () => {
  // 🔴 The floor of five characters, and the reason it exists: at four, `Port` and `Fort`
  // are two edits apart and every place called Port-something would be flagged. A reader who
  // sees one nonsense pairing stops believing the panel.
  const report = analyseConflicts({
    entries: [],
    mentions: {
      places: [
        { value: 'Port', count: 2, entries: [0] },
        { value: 'Fort', count: 2, entries: [1] },
      ],
      people: [],
      amounts: [],
    },
    documentText: 'A visit to Port, then to Fort.',
  });
  assert.deepEqual(report.spelledTwoWays, []);
});

test('two genuinely different names are not reported', () => {
  const report = analyseConflicts({
    entries: [],
    mentions: {
      places: [],
      people: [
        { value: 'Andrea', count: 4, entries: [0] },
        { value: 'Cecilia', count: 2, entries: [1] },
      ],
      amounts: [],
    },
    documentText: 'Andrea came over. Cecilia rang later the same week.',
  });
  assert.deepEqual(report.spelledTwoWays, []);
});

test('a shared opening letter is required, so unrelated nouns are left alone', () => {
  // `Hamilton` and `Samilton` are two edits apart but no reader would call the second a
  // misspelling of the first, and the first-letter guard is what removes that class.
  const report = analyseConflicts({
    entries: [],
    mentions: { places: [], people: [], amounts: [] },
    documentText: 'Hamilton was quiet. Samilton was not.',
  });
  assert.deepEqual(report.spelledTwoWays, []);
});

test('an identical name repeated is not "written two ways"', () => {
  // The tally already collapses duplicates, and a pair of equal strings is a distance of
  // zero — the check must not treat that as a difference.
  const report = analyseConflicts({
    entries: [],
    mentions: { places: [], people: [], amounts: [] },
    documentText: 'Hamilton in the morning, Hamilton again at noon.',
  });
  assert.deepEqual(report.spelledTwoWays, []);
});

test('a near-identical pair is reported whatever buckets the counts landed in', () => {
  // 🔴 THIS TEST WAS REWRITTEN, NOT DELETED, WHEN THE CHECK WAS WIDENED. It used to assert
  // that a place and a person were "never compared with each other" — which was true while
  // the check walked the extracted mention lists. It no longer does: the pool is every
  // capitalised word in the document, because the extractor REJECTS a misspelling and so the
  // old version could never find one. So the honest assertion is now the opposite — a
  // near-identical pair is reported, and which bucket it was filed under is irrelevant.
  const report = analyseConflicts({
    entries: [],
    mentions: {
      places: [{ value: 'Andrea', count: 1, entries: [0] }],
      people: [{ value: 'Andres', count: 1, entries: [1] }],
      amounts: [],
    },
    documentText: 'Andrea came over. Andres was not there.',
  });
  assert.equal(report.spelledTwoWays.length, 1, 'one letter apart is worth showing');
  assert.deepEqual(
    [report.spelledTwoWays[0].a, report.spelledTwoWays[0].b].sort(),
    ['Andrea', 'Andres']
  );
});

test('a date that can be read two ways is named, with the words as written', () => {
  const report = analyseConflicts({
    entries: [
      entry(0, null, { ambiguousDate: true, dateRaw: '06/03/2026' }),
      entry(1, '2026-03-18'),
    ],
    mentions: noMentions,
    documentText: '',
  });
  assert.equal(report.ambiguous.length, 1);
  assert.equal(report.ambiguous[0].raw, '06/03/2026');
});

test('two weekdays are not one name written two ways', () => {
  // 🔴 THE FALSE POSITIVE THE DIARY FOUND, kept as a test. `tuesday` and `thursday` really
  // are two edits apart — the arithmetic was right and the conclusion was wrong, which is
  // the one way this check must never fail. Tightening the distance would not have helped:
  // `Grimsby`/`Grimbsy` is also two edits, and that is the case this exists for.
  const report = analyseConflicts({
    entries: [],
    mentions: noMentions,
    documentText: 'On Tuesday it rained. On Thursday it was cold.',
  });
  assert.deepEqual(report.spelledTwoWays, []);
});

test('two months are not one name written two ways', () => {
  const report = analyseConflicts({
    entries: [],
    mentions: noMentions,
    documentText: 'In March it rained. In April it was cold.',
  });
  assert.deepEqual(report.spelledTwoWays, []);
});

test('a place that is a real misspelling IS still reported', () => {
  // The counterpart, and the reason the weekday list is a list rather than a tighter
  // distance: this pair must survive.
  const report = analyseConflicts({
    entries: [],
    mentions: noMentions,
    documentText: 'Work in Grimsby. A follow-up at Grimbsy.',
  });
  assert.equal(report.spelledTwoWays.length, 1);
});

test('nothing at all reports nothing at all', () => {
  const report = analyseConflicts({ entries: [], mentions: noMentions, documentText: '' });
  assert.deepEqual(report, { outOfOrder: [], spelledTwoWays: [], ambiguous: [] });
});
