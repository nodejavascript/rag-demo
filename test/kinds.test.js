/**
 * What the document is taken for, and what it is then asked.
 *
 * 🔴 THIS FILE EXISTS FOR THE TWO WAYS THIS FEATURE CAN GO WRONG, and both are checkable
 * here rather than by looking at the page.
 *
 *  1. **A resume that is not recognised.** The page would offer a diary's questions to
 *     somebody who has just pasted a resume, which is the thing George asked for
 *     ("*if it detects a resume, can you create better questions, like what are the
 *     skills?*"). The two documents in `SAMPLES` are the ones the page itself offers, so
 *     they are the fixtures: no invented text that only the test has ever seen.
 *
 *  2. **A question that asks for arithmetic.** The prompt forbids the model to count or to
 *     add up, because it cannot, and every number the app shows is computed in code over
 *     the whole document. A suggested question asking for a total would invite exactly the
 *     invention the rest of the app exists to prevent — so the last test walks EVERY set
 *     and fails on one. That test is the reason the sets can be edited without fear.
 *
 * The kind is a heuristic and is allowed to be wrong about a difficult document. It is not
 * allowed to be wrong about the two documents the page puts in front of people.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { build } from '../dist/chunk.js';
import { SAMPLES } from '../dist/samples.js';
import { ALL_SUGGESTIONS, describeDocument, detectKind } from '../dist/kinds.js';

/** Describe a sample exactly as the server does: over the text as the indexer read it. */
function describeSample(id) {
  const sample = SAMPLES.find((entry) => entry.id === id);
  assert.ok(sample, `the ${id} sample still exists`);
  const built = build(sample.text, null, []);
  return describeDocument(sample.text, built.stats.datedEntries);
}

test('the resume sample is recognised as a resume, and is asked about its skills', () => {
  const described = describeSample('resume');
  assert.equal(described.kind, 'resume');
  assert.ok(
    described.suggestions.some((question) => /skills/i.test(question)),
    'a resume is offered a question about its skills'
  );
  assert.ok(described.suggestions.some((question) => /worked|employers/i.test(question)));
});

test('the diary sample is NOT a resume, and is not asked about skills', () => {
  const described = describeSample('diary');
  assert.notEqual(described.kind, 'resume', 'a diary is not a resume');
  assert.equal(
    described.suggestions.some((question) => /skills/i.test(question)),
    false,
    'and it is not asked about skills'
  );
});

test('a contract, a transcript and a set of minutes are each recognised', () => {
  const contract = `1. Term and Termination
This agreement shall commence on the date hereof and shall continue unless terminated. Each party shall give written notice. The obligations of the parties are set out herein. Neither party shall be liable for indirect loss. Clause 4 governs liability and indemnity. The governing law of this agreement is Ontario.`;
  assert.equal(detectKind(contract, 0), 'policy');

  const transcript = [
    'Chair: Thank you all for coming.',
    'Chair: The first item is the budget.',
    'Priya: I think we should defer it.',
    'Priya: The numbers are not ready.',
    'Tom: I agree with Priya.',
    'Tom: Let us come back to it next month.',
  ].join('\n');
  assert.equal(detectKind(transcript, 0), 'transcript');

  const minutes = [
    'Minutes of the meeting held on 4 March 2026',
    'Present: Priya, Tom and Sam',
    'Apologies: Andrea',
    'Agenda: budget, staffing, and the roof',
    'Action items: Tom to price the roof.',
    'The motion was carried.',
  ].join('\n');
  assert.equal(detectKind(minutes, 0), 'minutes');
});

test('an ordinary document falls back to the questions that suit anything', () => {
  const text = 'Tomatoes are a fruit, botanically speaking. Most people treat them as a vegetable. The distinction matters to a tax office and to nobody else.';
  assert.equal(detectKind(text, 0), 'general');
  assert.deepEqual(describeDocument(text, 0).suggestions, ALL_SUGGESTIONS.general);
});

test('NO suggested question ever asks for arithmetic', () => {
  // The prompt forbids the model to count, add up or average, because it cannot reliably do
  // any of the three. A question that asked for one would be the app breaking its own rule
  // before the reader has typed anything.
  const forbidden = /\b(total|totals|sum of|add up|average|mean of|how many|number of|count)\b/i;
  for (const [kind, questions] of Object.entries(ALL_SUGGESTIONS)) {
    assert.ok(questions.length > 0, `${kind} offers something`);
    assert.ok(questions.length <= 5, `${kind} offers a row of buttons, not a wall`);
    for (const question of questions) {
      assert.equal(forbidden.test(question), false, `"${question}" (${kind}) asks for arithmetic`);
      assert.ok(question.trim().endsWith('?'), `"${question}" is a question`);
    }
  }
});