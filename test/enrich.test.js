/**
 * Places, people and amounts.
 *
 * Every assertion here is a case that was got WRONG once and cost real quality — a
 * resume that reported being located "in TypeScript", a person called "Built", a
 * person called "Better. Fixed". They are written down so the heuristics cannot
 * quietly drift back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findAmounts, findPeople, findPlaces, tally } from '../dist/enrich.js';

test('a place after a preposition is found when the gazetteer knows it', () => {
  const places = findPlaces('She is still in Grimsby and will not move.');
  assert.ok(places.includes('Grimsby'));
});

test('a TECHNOLOGY after a preposition is not a place', () => {
  // "written in TypeScript and PostgreSQL" produced "in TypeScript" as a location.
  const places = findPlaces('Led the migration in TypeScript and PostgreSQL for the payment team.');
  assert.equal(
    places.some((place) => /typescript|postgresql/i.test(place)),
    false
  );
});

test('a multi-word place needs no gazetteer', () => {
  const places = findPlaces('We drove to Port Dover on the Saturday.');
  assert.ok(places.some((place) => /Port Dover/i.test(place)));
});

test('a gazetteer name is found wherever it is written', () => {
  const places = findPlaces('Hamilton, Ontario — the office moved there.');
  assert.ok(places.includes('Hamilton'));
  assert.ok(places.includes('Ontario'));
});

test('a full name is a person', () => {
  const people = findPeople('Necole Fielder signed the form.');
  assert.ok(people.includes('Necole Fielder'));
});

test('an honorific yields a person', () => {
  assert.ok(findPeople('Dr. Whitfield reviewed it.').includes('Whitfield'));
});

test('a software pair is not a person', () => {
  // A resume produced *Software Engineer* and *Computer Science* as people.
  const people = findPeople('Senior Software Engineer, First Canadian Title. Honours Bachelor of Computer Science.');
  assert.equal(
    people.some((person) => /Software Engineer|Computer Science|Canadian Title/i.test(person)),
    false
  );
});

test('a sentence-opening verb is not a person', () => {
  // "Built the GraphQL layer." ×3 produced a person called *Built*.
  const people = findPeople(
    'Built the asset pipeline. Built the caching layer. Built the internal tools for the operations team.'
  );
  assert.equal(
    people.some((person) => person === 'Built'),
    false
  );
});

test('an abbreviation does not glue two sentences into a name', () => {
  // "Better. Fixed the fence." produced *Better. Fixed*.
  const people = findPeople('Better. Fixed the fence. Andrea brought the dog over and we walked.');
  assert.equal(
    people.some((person) => /Better/.test(person)),
    false,
    'a full stop must never be part of a name'
  );
});

test('a recurring first name IS a person, even in a diary', () => {
  const people = findPeople(
    '18 March 2026\nRead the report Andrea sent.\n\n22 March 2026\nAndrea came over with the paperwork.'
  );
  assert.ok(people.includes('Andrea'), 'the most-mentioned person must not be dropped');
});

test('a street is not a person', () => {
  const people = findPeople('Sat outside the cafe on James Street with a coffee.');
  assert.equal(
    people.some((person) => /James Street/.test(person)),
    false
  );
});

test('amounts keep the symbol, because the symbol is part of the fact', () => {
  const amounts = findAmounts('It cost $1,450 for the week and £0 for the repair.');
  assert.deepEqual(amounts, ['$1,450', '£0']);
});

test('a tally counts occurrences and remembers which entries', () => {
  const result = tally([
    { value: 'Grimsby', entryIndex: 0 },
    { value: 'grimsby', entryIndex: 1 },
    { value: 'Hamilton', entryIndex: 1 },
  ]);
  assert.deepEqual(result[0], { value: 'Grimsby', count: 2, entries: [0, 1] });
  assert.equal(result[1]?.value, 'Hamilton');
});
