/**
 * What the document does not say.
 *
 * 🔴 **THE ASSERTIONS THAT MATTER HERE ARE THE NEGATIVE ONES.** The panel this feeds makes a
 * strong claim — *"the document never uses this word"* — and a wrong version of that claim
 * would be worse than having no panel at all, because it would teach the reader to distrust
 * a feature whose only value is being checkable. So most of this file is not testing that an
 * absence is found; it is testing that absences are **refused** whenever the document holds
 * the word in another form.
 *
 * That is not hypothetical. The first version of the matcher reported `study` as absent from
 * *"He studied engineering and his studies ended in 1993"* — a prefix test cannot see a word
 * that changes its ending, and `studied` does not begin with `study`. The test below is that
 * exact sentence, because it caught the bug once and it should catch it again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseGaps } from '../dist/gaps.js';

const none = { places: [], people: [], amounts: [] };

function gapsFor(question, documentText) {
  return analyseGaps({ question, documentText, mentions: none });
}

test('a word the document holds in another form is never called absent', () => {
  // Each pair is a real English inflection, and every one of them defeated a naive check.
  const cases = [
    ['What did he study?', 'He studied engineering and his studies ended in 1993.', 'study'],
    ['Did any bills get paid?', 'The bill arrived and the bills were paid.', 'bills'],
    ['Was the colour mentioned?', 'The color of the door was blue.', 'colour'],
    ['What did she sign?', 'She signed the lease and kept her signature.', 'sign'],
    ['Who owns the properties?', 'He owned one property for years.', 'properties'],
    ['When did they marry?', 'They married in June and the marriage lasted.', 'marry'],
  ];
  for (const [question, documentText, word] of cases) {
    const report = gapsFor(question, documentText);
    assert.equal(
      report.absent.includes(word),
      false,
      `"${word}" must not be reported absent — the document says: ${documentText}`
    );
  }
});

test('a word the document genuinely lacks IS reported absent', () => {
  // The other half of the claim, and it has to work: a refusal needs a reason.
  const report = gapsFor('What colour was the front door?', 'The boiler failed and the technician came.');
  assert.deepEqual(report.absent, ['colour', 'front', 'door']);
  assert.equal(report.presentCount, 0);
});

test('question scaffolding is never reported, however absent it is', () => {
  // "what", "did", "was" are true of every question, so naming them would be noise on every
  // single answer — and worse, it would look like a finding.
  const report = gapsFor('What did she say about the weather?', 'Nothing here about it.');
  assert.equal(report.absent.includes('what'), false);
  assert.equal(report.absent.includes('did'), false);
  assert.equal(report.absent.includes('about'), false);
  assert.equal(report.absent.includes('say'), false);
});

test('a word too short to be worth a claim is left alone', () => {
  // A three-letter word is more often an inflection than a subject, and this module may not
  // risk a false absence to gain a trivial one.
  const report = gapsFor('Did the car start?', 'The van would not go.');
  assert.equal(report.absent.includes('car'), false);
});

test('an absence is counted even when the list shown is capped', () => {
  // The page says "and N more", so the total must be the real total and not the shown count.
  const report = gapsFor(
    'Which elephants migrated through thunderous valleys during winter?',
    'A short note about nothing in particular.'
  );
  assert.ok(report.absentTotal > report.absent.length, 'the total must exceed the shown slice');
  assert.ok(report.absent.length > 0);
});

test('a thing said exactly once is reported, and a thing said twice is not', () => {
  // "Mentioned once" is the whole claim — it is the thing easiest to miss — so a count of two
  // must not slip in.
  const report = analyseGaps({
    question: 'Where did she go?',
    documentText: 'Grimsby, then Grimsby again. Dover once.',
    mentions: {
      places: [
        { value: 'Grimsby', count: 2, entries: [0] },
        { value: 'Dover', count: 1, entries: [1] },
      ],
      people: [{ value: 'Andrea', count: 1, entries: [2] }],
      amounts: [{ value: '$40', count: 3, entries: [3] }],
    },
  });
  assert.deepEqual(
    report.once.map((item) => item.value).sort(),
    ['Andrea', 'Dover']
  );
  assert.equal(report.once.some((item) => item.value === 'Grimsby'), false, 'a count of two is not once');
});

test('a correct answer can coexist with an absent word, and the report says so plainly', () => {
  // 🔴 THE SUBTLETY THIS FILE EXISTS TO PROTECT. A resume answers "where did he go to
  // school?" while never containing the word *school* — it heads that section EDUCATION.
  // The report may say the word is missing; it must be equally true that an answer is
  // still possible, which is why `presentCount` is reported beside the absent list and
  // why the page words this as "words the document does not use", never "cannot answer".
  const resume = 'EDUCATION\n\nSt. Clair College\nWindsor, Ontario\nChemical Engineering Technology';
  const report = gapsFor('Where did he go to school?', resume);
  assert.deepEqual(report.absent, ['school']);
  assert.equal(report.presentCount, 0, 'nothing in that question is in the document either');
});
