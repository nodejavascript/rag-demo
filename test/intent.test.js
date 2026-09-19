/**
 * The two mechanisms that fixed the wrong answer, and the guarantee that neither can
 * invent anything.
 *
 * Both of them are GUESSES about words — "school" probably means the document said
 * EDUCATION; "now" probably means it said Present. A guess about words is safe to make
 * only because of what these do with it: **they add a note to the list the model reads.
 * They never add a sentence to the answer.** Every assertion below is written to hold that
 * line, not just to check the happy path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandQuery } from '../dist/intent.js';
import { buildMessages } from '../dist/prompt.js';

test('a question about school is widened to the words a resume uses', () => {
  // The failure in full: the resume's only mention of the subject is a heading reading
  // EDUCATION, so a search for the question's own words found no education note at all
  // and the model — shown no note — refused. The refusal was honest. The retrieval was
  // the bug.
  const terms = expandQuery('Where did he go to school?');
  assert.ok(terms.includes('education'), 'EDUCATION is the heading a resume uses');
  assert.ok(terms.includes('college'), 'and college is what it names');
});

test('a question about now is widened to the way a resume writes a continuing role', () => {
  // The other direction of the same fault. Asked who he works for NOW, the model was given
  // an entry reading `01/2000 - 08/2026` and never shown `09/2026 - Present`, so it named
  // an employer whose contract had ended.
  const terms = expandQuery('Who does he work for now?');
  assert.ok(terms.includes('present'), 'a continuing role is written as Present');
});

test('a question this list knows nothing about is left exactly alone', () => {
  // The list must not become a net that catches everything. If every question produced
  // terms, every question would drag the same common notes into view and the refusal floor
  // would be measuring noise.
  assert.deepEqual(expandQuery('quantum chromodynamics lattice gauge theory'), []);
  assert.deepEqual(expandQuery('What colour was the front door?'), []);
});

test('the widening never repeats a term', () => {
  const terms = expandQuery('What school did he attend, and where did he study?');
  assert.equal(terms.length, new Set(terms).size, 'a duplicated term would skew BM25');
});

test('a question that names a date is told to open with it', () => {
  // 🔴 Measured, three runs out of three: with the correct note moved to the front and a
  // rule in the list already requiring it, qwen2.5:7b still answered the 6 March question
  // without ever writing "6 March". The instruction has to sit directly under the question.
  const messages = buildMessages({
    question: 'What happened on 6 March 2026?',
    notes: [{ label: '2026-03-06', text: '6 March 2026\nThe technician arrived.', places: [], people: [] }],
    facts: [],
    stats: {},
    assumedYear: false,
  });
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  assert.match(user, /Begin your answer with the date this question asks about/);
  assert.match(user, /6 March 2026/, 'and it must echo the date as the question wrote it');
});

test('a question that names no date is not told to invent one', () => {
  // The mirror of the rule, and the one that matters more: a document with no dates must
  // never be prompted for one.
  const messages = buildMessages({
    question: 'What did Andrea bring?',
    notes: [{ label: 'note', text: 'Andrea brought paperwork.', places: [], people: [] }],
    facts: [],
    stats: {},
    assumedYear: false,
  });
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  assert.doesNotMatch(user, /Begin your answer with the date/);
});

test('an ambiguous date in the question does not become an instruction', () => {
  // `06/03/2026` can be read as two different days. The retrieval is allowed to ignore it
  // — it lifts nothing — and the model must not be told to open with a date nobody can
  // resolve.
  const messages = buildMessages({
    question: 'What happened on 06/03/2026?',
    notes: [{ label: 'note', text: 'Something happened.', places: [], people: [] }],
    facts: [],
    stats: {},
    assumedYear: false,
  });
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  assert.doesNotMatch(user, /Begin your answer with the date/);
});

test('a month and a year in the question does become an instruction', () => {
  // The counterpart to the test above, and the reason it is not written as `hit.date`
  // alone: `09/2026` names one period and one period only, so it is honest to ask for it.
  const messages = buildMessages({
    question: 'What happened in 09/2026?',
    notes: [{ label: 'note', text: 'Something happened.', places: [], people: [] }],
    facts: [],
    stats: {},
    assumedYear: false,
  });
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  assert.match(user, /Begin your answer with the date this question asks about/);
  assert.match(user, /09\/2026/);
});
