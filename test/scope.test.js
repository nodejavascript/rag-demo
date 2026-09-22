/**
 * Which questions are answered from the WHOLE document, and which from the best-matching notes.
 *
 * 🔴 THE FAILURE THESE TESTS HOLD SHUT. George clicked *"Which employers and job titles are named?"*
 * — a question his own page offered him — on his own resume and got **four employers out of
 * twelve**, ending with *"…are the employers."* The answer was written from 8 of the document's 20
 * notes, and those eight held four employer names; nine were never shown to the model. `scope.ts`
 * carries the full measurement. The fix is that a question asking for a list reads every note, and
 * these tests are what stops that decision from being quietly undone — or quietly widened until
 * every question pays for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIST_QUESTIONS, NOT_LIST_QUESTIONS, offeredQuestions, wantsEverything } from '../dist/scope.js';
import { BY_KIND } from '../dist/kinds.js';

/** The form both registries compare in — kept here so the test does not import a private helper. */
const normalise = (question) => question.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[?!.]+$/, '');

test('every question the page offers is classified, one way or the other', () => {
  // 🔴 THE GUARD THAT MAKES THE REGISTRIES WORTH HAVING. A registry is only a decision if a new
  // question cannot arrive without one: this walks the questions the page actually offers and fails
  // when one of them is in neither list. Add a question to `kinds.ts` and this test tells you to
  // decide, rather than letting it fall through to the patterns — which is how a list question ends
  // up answered from eight notes.
  const offered = offeredQuestions();
  assert.ok(offered.length >= 20, `only ${offered.length} questions were walked, so this test proves little`);
  const unclassified = offered.filter(
    ({ question }) =>
      !LIST_QUESTIONS.some((known) => normalise(known) === normalise(question)) &&
      !NOT_LIST_QUESTIONS.some((known) => normalise(known) === normalise(question))
  );
  assert.deepEqual(
    unclassified.map(({ question }) => question),
    [],
    'these questions are offered to the reader but nobody has decided how they should be read'
  );
});

test('and no question is claimed by both lists', () => {
  // If a question were in both, the answer would depend on which list the code happens to test
  // first — an invisible decision, which is the opposite of the point of having the lists.
  const both = LIST_QUESTIONS.filter((question) =>
    NOT_LIST_QUESTIONS.some((known) => normalise(known) === normalise(question))
  );
  assert.deepEqual(both, [], 'a question is classified as both a list and a single answer');
  for (const question of LIST_QUESTIONS) {
    assert.ok(wantsEverything(question), `"${question}" is in the list registry and does not read as one`);
  }
  for (const question of NOT_LIST_QUESTIONS) {
    assert.equal(wantsEverything(question), false, `"${question}" is in the single-answer registry and reads as a list`);
  }
});

test('the question that was answered with four employers out of twelve reads as a LIST', () => {
  assert.equal(wantsEverything('Which employers and job titles are named?'), true);
  // …and so do the other offered questions that ask for a set, by construction from `kinds.ts`.
  const setOffered = offeredQuestions().filter(({ everything }) => everything).map(({ question }) => question);
  for (const question of [
    'What skills are listed?',
    'Where has this person worked?',
    'What education is listed?',
    'Which employers and job titles are named?',
    'What amounts are listed?',
    'Which payees or merchants are named?',
    'What does each party have to do?',
    'Where do the events take place?',
  ]) {
    assert.ok(setOffered.includes(question), `"${question}" asks for a set and is not classified as one`);
  }
});

test('a question for ONE thing is not widened into a list', () => {
  // The other direction, and it matters as much: reading the whole document costs a longer wait, so
  // a question that wants one name must keep the search it has always had.
  for (const question of [
    'What is this document about?',
    'Who is mentioned most?',
    'Which month was busiest?',
    'What happened first, and what happened last?',
    'What did they do in the most recent role?',
    'What notice is required?',
    'Summarise this.',
    'Tell me about the payment terms.',
    'What happened on 6 March 2026?',
    'Why did the boiler fail?',
    'How long was the contract?',
  ]) {
    assert.equal(wantsEverything(question), false, `"${question}" wants one answer, not the whole document`);
  }
});

test('and a question someone TYPED is read by its shape', () => {
  // No registry can cover what a reader types, so the patterns do it — and they are deliberately
  // narrow in both directions.
  for (const question of [
    'List the employers.',
    'Name all the people mentioned.',
    'How many invoices are in the ledger?',
    'Which payees are named?',
    'What kinds of transactions appear?',
    'Where did he work?',
    'Please enumerate the parties.',
  ]) {
    assert.equal(wantsEverything(question), true, `"${question}" asks for a set and was not read as one`);
  }
  for (const question of [
    '',
    '   ',
    'What does the document say about liability?',
    'When did the lease start?',
    'Who signed it?',
    'Is the deposit refundable?',
    'What was said last?',
    // 🔴 THE JUDGEMENT, STATED. "What are the terms and conditions?" reads as a request for a SET,
    // and it is still answered by search. The distinction is not "does this want more than one
    // thing" — almost every question does — it is **does it ask the document to NAME things**, which
    // is what a complete list rests on. A question about the terms wants the clauses that matter,
    // found by search, and a whole-document read of a forty-page policy to answer it would be a
    // slower answer to a smaller question.
    'What are the terms and conditions?',
  ]) {
    assert.equal(wantsEverything(question), false, `"${question}" was widened into a whole-document read`);
  }
});

test('every kind in kinds.ts is represented in the walk', () => {
  // A kind whose questions are all unclassified would make the first test pass by accident.
  const kinds = Object.keys(BY_KIND);
  const walked = new Set(offeredQuestions().map(({ kind }) => kind));
  assert.deepEqual([...kinds].filter((kind) => !walked.has(kind)), [], 'a document kind offers questions this walk never sees');
});
