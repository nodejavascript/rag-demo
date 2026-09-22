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
/* ------------------------------------------------------ a job posting */

/**
 * 🔴 A JOB POSTING IS ITS OWN KIND, AND IT WAS NOT ONE UNTIL 22 SEP 2026.
 *
 * George pasted this posting and the page called it *"a document"*, so it offered the diary's
 * questions — including *"Which month was busiest?"*, on a posting with no dates in it. The posting
 * below is his text, trimmed to the parts that carry the signals; it is the case that found the gap,
 * so it is the case that guards it.
 */
const POSTING = `Senior Software Engineer
Ottawa, Ontario
As a Senior Software Engineer you will own the design, delivery, and evolution of production systems
that integrate AI, automate workflows, and modernize infrastructure so our clients can compete and
grow. Your code and architecture decisions will ship, run in production, and measurably improve how
those organizations operate.
PERFORMANCE OBJECTIVES
Deliver at least two production AI-integrated or automation systems per year that reduce client cycle
times or error rates by 25% or more, measured against pre-project baselines.
Lead the end-to-end modernization of one legacy platform annually, including architecture,
migration, security hardening, and handover so the new system meets 99.9% availability.
Build and maintain cloud-native services and CI/CD pipelines that cut deployment lead time by 40%
while keeping production incidents below an agreed threshold.
ENVIRONMENT & RESOURCES
You will report to the engineering lead inside a compact 11-50 person company based in Ottawa. You
will work with a small, high-ownership team that already uses modern cloud platforms, DevOps tooling,
and AI-assisted development. You will have direct access to clients, architecture decisions, and the
latitude to choose proven technologies that solve the problem.
ESSENTIAL QUALIFICATIONS
Demonstrated track record shipping production software that includes AI integration, system
modernization, or large-scale automation.
Hands-on experience designing and operating cloud architectures and DevOps pipelines that meet
availability and security requirements.
Ability to take ambiguous client problems, produce a technical plan, and deliver working software on
a predictable cadence.`;

/** And a second posting, written in the other common shape, so the detection is not tuned to one. */
const POSTING_TWO = `About the role
We are hiring a Data Platform Engineer to join our team in Burlington. This is a full-time role and
it can be hybrid or fully remote for the right candidate.
What you'll do
Design and run the pipelines that move our clients' data every night.
Own the on-call rotation for the platform, and the runbooks that go with it.
Requirements
Five years building production data systems.
Strong SQL, and one of Python or Go.
Nice to have
Experience with Terraform.
What we offer
A salary range of 140,000 to 175,000, a benefits package, and four weeks of paid time off.
How to apply
Send your resume to the address at the bottom of this posting.`;

/** An employment agreement is the trap: it carries three of the same words a posting does. */
const EMPLOYMENT_CONTRACT = `EMPLOYMENT AGREEMENT
This agreement is made between the Employer and the Employee. The Employee shall commence
employment on a probationary period of three months. Either party may terminate this agreement by
giving notice in writing. The Employee shall be paid a salary, and the notice period shall be four
weeks. This agreement shall be governed by the laws of Ontario, and no clause of it may be varied
except in writing signed by both parties.`;

test('a job posting is recognised as a job posting, and is asked about its requirements', () => {
  const described = describeDocument(POSTING, 0);
  assert.equal(described.kind, 'job', 'a posting must not be read as a general document');
  assert.equal(described.label, 'a job description');
  assert.equal(described.suggestions[0], 'What are the essential qualifications?');
  assert.ok(
    described.suggestions.some((question) => /technologies/i.test(question)),
    'a posting is where the stack is named, so it must be asked about'
  );
  // And it must NOT be offered the diary's questions, which is the fault that produced this kind.
  assert.ok(
    !described.suggestions.includes('Which month was busiest?'),
    'the diary questions must not be offered on a posting'
  );
});

test('a second posting, written in another shape, is recognised too', () => {
  // The detection must not be tuned to one posting's headings: this one uses About the role / What
  // you'll do / Requirements / Nice to have / What we offer, and says nothing the first one says.
  const described = describeDocument(POSTING_TWO, 0);
  assert.equal(described.kind, 'job');
  assert.equal(described.label, 'a job description');
});

test('an employment agreement is NOT mistaken for a job posting', () => {
  // 🔴 THIS IS THE TRAP THE KIND HAD TO BE BUILT AROUND. A contract contains "probationary period",
  // "notice period" and "salary" — three of the posting markers — so a naive marker count reads a
  // contract as a posting. A posting is required to carry its own SECTIONS as well, and a contract
  // has none, so it still falls through to `policy` where its questions are the right ones.
  assert.equal(detectKind(EMPLOYMENT_CONTRACT, 0), 'policy');
});

test('a resume that mentions full-time and remote is still a resume', () => {
  // A resume may carry posting words in its own text; the resume check runs first and must keep
  // winning, because a resume has employers, dates and degrees that a posting never has.
  const resume = `Jane Doe — Senior Software Engineer
EXPERIENCE
Acme Corporation, Hamilton, Ontario — Senior Engineer, permanent full-time role, remote two days a week
2019 to 2024
Led the migration of the billing platform to Kubernetes.
EDUCATION
McMaster University, Bachelor of Engineering, 2015
SKILLS
TypeScript, Node.js, PostgreSQL, Docker, AWS`;
  assert.equal(detectKind(resume, 0), 'resume');
});

/* ------------------------------------------------------ a news article */

/**
 * 🔴 A PASTED NEWS PAGE IS ITS OWN KIND, AND IT WAS NOT ONE UNTIL 22 SEP 2026.
 *
 * George pasted a Fox News page and the page called it *"a document"* — *"it should have said a news
 * article. is the agent even readying the input?"*. The text below is a faithful slice of what a
 * browser paste actually contains: navigation first, then the story, then comments and a footer of
 * forty links. **That junk is the whole difficulty** — the document has no shape for the other kinds
 * to read, which is why the detection leans on the byline and the publication stamp.
 */
const NEWS = `Fox NewsU.S. Politics World OpinionMedia Entertainment OutKick Sports MoreExpand / Collapse searchLog InWatch TV
Recommended VideosRecommended ArticlesWelder-turned-lawmaker warns AI could be 'nuclear bomb' for workers
Trump defends US interventions abroad ahead of 'big decision' on Iran: 'Settling years of unfinished business'
By Eric Mack Fox NewsPublished September 22, 2026 10:51am EDT | Updated September 22, 2026 11:37am EDT
Iran made 'big mistake' before Operation Midnight Hammer, Trump says
President Donald Trump told the United Nations General Assembly Tuesday that the U.S. confronted an Iranian threat that "far too many preferred to ignore."
"I have a big decision to make," Trump told the United Nations General Assembly in his morning address. (Chip Somodevilla/Getty Images)
Trump expressed hope that a deal with the "cowards and traitors" of Iran will come "right after the election."
Eric Mack is a breaking news reporter and writer Sunday through Thursday with a particular interest in stories that lead the news cycle.
CLICK HERE TO DOWNLOAD THE FOX NEWS APP
Sponsored Stories You May LikeIs Leafs captain Auston Matthews engaged?
See MoreReplyView 75 repliesRelated TopicsDonald TrumpUnited NationsWar With Iran1.38K Comments
More From Fox NewsIlhan Omar says she's in dark on criminal investigation confirmed by Homan
Terms of UsePrivacy PolicyHelpContact UsNews SitemapThis material may not be published, broadcast, rewritten, or redistributed.`;

/** A page that says only when it was posted is not a news article — it is something unclassified. */
const FORUM_POST = `Posted 9:30pm
My boiler stopped working this evening and the landlord has not answered. The unit is cold and the
building manager says it is a building-wide problem. I have written down the dates and kept the
messages, and I will try the emergency line in the morning if nothing has changed by then.`;

test('a pasted news page is recognised as a news article', () => {
  const described = describeDocument(NEWS, 1);
  assert.equal(described.kind, 'news', 'a news page must not be read as a general document');
  assert.equal(described.label, 'a news article');
  assert.equal(described.suggestions[0], 'Who wrote it, and when was it published?');
  assert.ok(
    described.suggestions.some((question) => /quoted/i.test(question)),
    'a news story is built on who is quoted, so it must be asked about'
  );
  assert.ok(
    !described.suggestions.includes('Which month was busiest?'),
    'the diary questions must not be offered on a news page'
  );
});

test('a page that only says when it was posted is not a news article', () => {
  // The weak route needs the surrounding words as well, or every forum post and every comment thread
  // becomes "a news article". This is the guard against that.
  assert.equal(detectKind(FORUM_POST, 0), 'general');
});
