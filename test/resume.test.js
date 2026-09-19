/**
 * George's own resume, as the fixture.
 *
 * 🔴 THIS FILE EXISTS BECAUSE THE TOOL GOT HIS RESUME WRONG. He pasted it, asked
 * "where did he go to school", and was told **University of Windsor**. The resume says
 * **St. Clair College**. Two things had gone wrong at once, and neither was visible
 * from the sample documents the suite used:
 *
 *  1. **The parser.** His sections are written the way every resume writes them — a
 *     heading, then fragments with no full stops. The heading rule required the line
 *     beneath to end a SENTENCE, which nothing in his resume does, so `EDUCATION` was
 *     never a heading. It was glued onto the entry before it, and the college ended up
 *     inside an entry labelled with a project's name — so the note was hard to find.
 *     The sample resume the suite used passed only by accident: every one of its
 *     sections happened to end in a full stop.
 *  2. **The model.** Seeing `St. Clair College` above `Windsor, Ontario`, it produced
 *     the name of a real university in that city. A confident invention, which is the
 *     worst thing this tool can do.
 *
 * So these tests assert the STRUCTURE (no model needed) and one asserts the ANSWER
 * (model needed). The structure half is the important half: it is what made the wrong
 * answer possible.
 *
 * The fixture is his real resume with his email address and phone number replaced by
 * `[email redacted]` / `[phone redacted]`. Nothing else is changed — the line count,
 * the blank lines and every word of the structure are exactly as he wrote them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { build } from '../dist/chunk.js';
import { findPeople, findPlaces } from '../dist/enrich.js';
import { findDates } from '../dist/dates.js';
import { isSectionName } from '../dist/text.js';

const RESUME = readFileSync(fileURLToPath(new URL('../fixtures/george-resume.md', import.meta.url)), 'utf8');

/** The entry whose text mentions something, or undefined. */
function entryMentioning(built, needle) {
  return built.entries.find((entry) => new RegExp(needle, 'i').test(entry.text));
}

test('the fixture really is the resume, and carries no contact details', () => {
  assert.ok(RESUME.length > 8000, 'the resume is long');
  assert.match(RESUME, /<redacted>/);
  assert.match(RESUME, /PROFESSIONAL EXPERIENCE/);
  assert.doesNotMatch(RESUME, /georgefielder@gmail\.com/, 'the email must be redacted');
  assert.doesNotMatch(RESUME, /\(548\) 255-2318/, 'the phone must be redacted');
});

test('every section and every job is its own entry', () => {
  const built = build(RESUME, null, []);
  // Before the fix this was ONE entry: the whole resume glued together.
  assert.ok(built.entries.length >= 15, `expected the resume to split, got ${built.entries.length}`);

  const headings = built.entries.map((entry) => entry.heading ?? '').join(' | ');
  for (const section of ['PROFESSIONAL SUMMARY', 'SKILLS', 'PROFESSIONAL EXPERIENCE', 'EDUCATION', 'SELECTED PROJECTS']) {
    assert.match(headings, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${section} must be its own entry`);
  }
});

test('🔴 the EDUCATION entry names St. Clair College, in its own entry', () => {
  const built = build(RESUME, null, []);
  const education = built.entries.find((entry) => (entry.heading ?? '').toUpperCase() === 'EDUCATION');
  assert.ok(education, 'EDUCATION must be an entry of its own, not glued to the entry before it');
  assert.match(education.text, /St\.?\s*Clair College/i, 'the college must be inside the EDUCATION entry');
  assert.match(education.text, /Chemical Engineering Technology/i);
  assert.doesNotMatch(
    education.text,
    /University/i,
    'the resume never says University — nothing may put one in the education entry'
  );
});

test('the resume never mentions a university at all', () => {
  // The guard on the hallucination itself. If this ever fails, the fixture changed,
  // not the code — and the answer test below would be testing the wrong thing.
  assert.doesNotMatch(RESUME, /University/i);
  assert.doesNotMatch(RESUME, /Windsor, Ontario, Canada\n.*University/i);
});

test('the college is not left inside a project entry', () => {
  const built = build(RESUME, null, []);
  const owners = built.entries
    .filter((entry) => /St\.?\s*Clair College/i.test(entry.text))
    .map((entry) => (entry.heading ?? '').toUpperCase());
  assert.deepEqual(owners, ['EDUCATION'], 'the college belongs to EDUCATION and to nothing else');
});

test('a heading that names a section is recognised as one', () => {
  assert.equal(isSectionName('EDUCATION'), true);
  assert.equal(isSectionName('SKILLS'), true);
  assert.equal(isSectionName('PROFESSIONAL SUMMARY'), true);
  assert.equal(isSectionName('PROFESSIONAL EXPERIENCE'), true);
  assert.equal(isSectionName('SELECTED PROJECTS'), true);
  // Not section names — these are lines inside blocks, and treating them as headings
  // is how a document of short standalone lines gets shredded.
  assert.equal(isSectionName('Alpha'), false);
  assert.equal(isSectionName('Work model: Hybrid'), false);
  assert.equal(isSectionName('Core Stack'), false);
});

test('the jobs each carry their own month, from MM/YYYY', () => {
  const built = build(RESUME, null, []);
  const roles = built.entries.filter((entry) => entry.month !== null);
  assert.ok(roles.length >= 10, `expected the jobs to be placed on a timeline, got ${roles.length}`);
  // MM/YYYY is the shape a resume uses, and it was not parsed before.
  assert.ok(roles.some((entry) => entry.month === '2026-09'), '09/2026 must be read as a month');
  assert.ok(roles.some((entry) => entry.month === '2026-07'), '07/2026 must be read as a month');
});

test('a month and a year is still never a day', () => {
  const built = build(RESUME, null, []);
  assert.equal(built.stats.datedEntries, 0, 'the resume writes no day anywhere');
  assert.ok(built.stats.monthPrecision >= 10, 'but it can be placed by month');
});

test('no day is invented for a month-and-year line', () => {
  const hits = findDates('07/2026 - 08/2026');
  assert.equal(hits.length, 2);
  for (const hit of hits) {
    assert.equal(hit.date, null, 'a day must never be claimed from a month and a year');
    assert.equal(hit.monthOnly, true);
  }
});

test('places are real places, not technologies', () => {
  const places = findPlaces(RESUME).map((place) => place.toLowerCase());
  assert.ok(places.some((place) => place.includes('hamilton')));
  assert.ok(places.some((place) => place.includes('windsor')));
  for (const wrong of ['typescript', 'node.js', 'react', 'postgresql', 'docker', 'graphql']) {
    assert.equal(places.includes(wrong), false, `${wrong} is a technology, not a place`);
  }
});

test('a resume names no people at all', () => {
  // 🔴 The second half of the same failure. Once the sections split properly this
  // resume was read as **44 people**, and almost none of them were people: *Model Context
  // Protocol*, *Google Workspace*, *RESTful API*, *British Columbia*, *Built*(7),
  // *Created*, *Worked*, *Led*, *Managed*. A resume names its author and nobody else,
  // so the honest answer for this document is an EMPTY list — and that is a stronger
  // claim than "no job titles", which is why it is the one asserted.
  const people = findPeople(RESUME);
  assert.equal(
    people.length,
    0,
    `a resume names no one, but the list is: ${[...new Set(people)].slice(0, 12).join(', ')}`
  );
});

test('a diary still finds the person in it', () => {
  // The other side of the trade. Tightening the rules must not cost the case they were
  // written for — a diary names somebody, and the count is what proves it is a person
  // and not a coincidence.
  const diary =
    '4 March 2026\nCold again. Andrea came over with the paperwork for the cottage.\n\n' +
    '18 March 2026\nRain all day. Read the report Andrea sent and made notes in the margin.';
  const people = findPeople(diary);
  assert.deepEqual([...new Set(people)], ['Andrea']);
});

test('the notes that get searched can still find the college', () => {
  // The practical consequence of the parser fix: a note must exist whose text contains
  // the school, so the search has something to return at all.
  const built = build(RESUME, null, []);
  const notes = built.chunks.filter((chunk) => /St\.?\s*Clair/i.test(chunk.text));
  assert.equal(notes.length, 1, 'exactly one note carries the college');
  assert.equal(notes[0].heading?.toUpperCase(), 'EDUCATION');
  assert.ok(notes[0].words < 60, 'and it is a small, focused note rather than a whole section');
});
