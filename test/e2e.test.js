/**
 * The real page, in a real browser, against the real server.
 *
 * This is the only test that proves the CHART and the PANEL actually render — a unit
 * test can prove the numbers are right and still leave the page showing nothing.
 *
 * It needs a model, because the last thing it does is ask a question. **If no model is
 * reachable it SKIPS rather than fails** and says so, because a test that fails for a
 * reason unrelated to the code teaches the reader to ignore failures.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4733;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * George's own resume, with the e-mail address and phone number redacted and nothing
 * else touched. This is here rather than the short built-in sample because the failure
 * it guards against was found on THIS document: the page was asked where he went to
 * school and answered **University of Windsor**, a name that appears nowhere in it.
 */
const RESUME = readFileSync(new URL('../fixtures/george-resume.md', import.meta.url), 'utf8');

let child = null;
let browser = null;
let page = null;
let modelUp = false;
let dir = null;

async function paste(text) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#paste', text);
  await page.waitForFunction(
    (expected) => document.getElementById('paste').value.length === expected,
    text.length
  );
}

/** The built-in diary — dates, a place, a person, an amount and a picture. */
async function diary() {
  const response = await fetch(`${BASE}/api/samples/diary`);
  const sample = await response.json();
  return sample.text;
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok || response.status === 503) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('the server never came up');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rag-e2e-'));
  child = spawn(
    process.execPath,
    ['--experimental-sqlite', 'dist/server.js'],
    {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: join(dir, 'e2e.db'), DOC_TTL_HOURS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  await waitForServer();

  const health = await (await fetch(`${BASE}/healthz`)).json();
  modelUp = health.ok === true;

  // Playwright is a devDependency; if it is not installed the test has nothing to drive
  // with, and saying so is better than a stack trace about a missing module.
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ channel: 'chrome' });
    const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    page = await context.newPage();
  } catch (error) {
    console.warn(`could not launch a browser: ${error.message}`);
  }
});

after(async () => {
  if (browser) await browser.close();
  if (child) child.kill('SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the page loads, and says whether the model is up', async (t) => {
  if (!page) return t.skip('no browser');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  assert.match(await page.title(), /Ask any document/);
  await page.waitForFunction(() => document.getElementById('health').innerHTML.length > 0);
  const health = await page.locator('#health').innerText();
  assert.ok(health.length > 0, 'the model status must be reported on arrival');
});

test('a document can be pasted and indexed, and the charts draw', async (t) => {
  if (!page) return t.skip('no browser');
  await paste(await diary());
  const stat = await page.locator('#paste-stat').innerText();
  assert.match(stat, /characters/);

  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  const cards = await page.locator('#shape-cards .card').allInnerTexts();
  assert.ok(cards.some((card) => /ENTRIES/i.test(card)), 'the shape must be reported');
  assert.ok(cards.some((card) => /SPAN/i.test(card)));

  // A canvas that was never drawn has zero painted pixels; one that was drawn does not.
  const painted = await page.evaluate(() => {
    const canvas = document.getElementById('timeline');
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  assert.equal(painted, true, 'the timeline chart must actually be drawn');
});

test('a question gets an answer with its details and sources', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip('no model is reachable, so no question can be answered');

  await paste(await diary());
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  await page.fill('#question', 'What did Andrea bring?');
  await page.evaluate(() => document.getElementById('ask').click());
  await page.waitForFunction(
    () => !document.getElementById('answer-wrap').hidden && document.getElementById('answer-prose').innerText.length > 0,
    null,
    { timeout: 180000 }
  );

  const prose = await page.locator('#answer-prose').innerText();
  assert.ok(prose.length > 20, 'the answer must have words in it');

  const headings = await page.locator('#answer-details .detail h4').allInnerTexts();
  assert.ok(headings.some((heading) => /dates/i.test(heading)), 'the dates it rests on');
  assert.ok(headings.some((heading) => /people/i.test(heading)), 'the people it mentions');
  assert.ok(headings.some((heading) => /matched/i.test(heading)), 'the retrieval chart');

  const sources = await page.locator('#sources li').count();
  assert.ok(sources > 0, 'the notes it came from must be listed');
});

test('a question the document does not answer is refused on the page', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip('no model is reachable, so no question can be answered');

  await paste(await diary());
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  await page.fill('#question', 'quantum chromodynamics lattice gauge theory');
  await page.evaluate(() => document.getElementById('ask').click());
  await page.waitForFunction(() => !document.getElementById('answer-wrap').hidden, null, { timeout: 60000 });

  const classes = await page.locator('#answer').getAttribute('class');
  assert.match(classes, /refused/, 'the refusal must be shown as a refusal');
  const prose = await page.locator('#answer-prose').innerText();
  assert.match(prose, /does not say/i);
});

/**
 * 🔴 DELETING A DOCUMENT MUST PUT THE PAGE BACK AS IT WAS.
 *
 * George found this by using it: after a delete, **step 4 — the panel carrying the delete
 * button — was still on the screen**, so the page went on offering to delete a document
 * that no longer existed, with an empty paste box above it. `delete` and `clear` each had
 * their own list of what to hide, and the lists had drifted.
 *
 * So this asserts the whole state, not just that the data went: every step that only
 * exists while a document does is hidden, the boxes are empty, the page is looking at the
 * top again, and the reader is told what happened.
 */
test('deleting a document puts the page back to its home state', async (t) => {
  if (!page) return t.skip('no browser');

  await paste(await diary());
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  const shown = () =>
    page.evaluate(() => {
      const id = (name) => !document.getElementById(name).hidden;
      return { step2: id('step-2'), step3: id('step-3'), step4: id('step-4') };
    });

  assert.deepEqual(await shown(), { step2: true, step3: true, step4: true }, 'all three steps appear once a document exists');

  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.evaluate(() => document.getElementById('delete').click());
  await page.waitForFunction(() => document.getElementById('step-4').hidden, null, { timeout: 15000 });

  assert.deepEqual(
    await shown(),
    { step2: false, step3: false, step4: false },
    'step 4 carries the delete button, so leaving it up offers to delete what is already gone'
  );

  const after = await page.evaluate(() => ({
    paste: document.getElementById('paste').value.length,
    question: document.getElementById('question').value.length,
    scrollY: Math.round(window.scrollY),
    toast: document.getElementById('toast').textContent,
    toastOn: document.getElementById('toast').classList.contains('on'),
  }));

  assert.equal(after.paste, 0, 'the pasted text must go, or the next question would be asked of a deleted document');
  assert.equal(after.question, 0);
  assert.equal(after.scrollY, 0, 'the page must look at the top again, which is what "looks like the home page" means');
  assert.equal(after.toastOn, true, 'the panel that used to carry the news is gone, so the news must float');
  assert.match(after.toast, /deleted/i);
});

/**
 * 🔴 THE REGRESSION THAT STARTED THIS FILE.
 *
 * George pasted his own resume and asked where he went to school. The page answered
 * **"University of Windsor"**. The word *University* does not occur anywhere in the
 * resume — it says **St. Clair College**, under `Windsor, Ontario`. Two separate faults
 * produced that answer, and this test covers both at once:
 *
 *   1. the parser never split his sections, because his headings are fragments with no
 *      full stop, so `EDUCATION` was glued onto the project above it and the school
 *      line was indexed as part of a project note;
 *   2. the model, shown `St. Clair College` and then a line reading `Windsor, Ontario`,
 *      combined the two.
 *
 * It is asserted on the PAGE and not in a unit test because the unit tests were all
 * green while the page gave the wrong answer.
 */
test('the school in the resume is the one the resume names', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip('no model is reachable, so no question can be answered');

  assert.match(RESUME, /St\.?\s*Clair/i, 'the fixture must still name the college');
  assert.doesNotMatch(RESUME, /University/i, 'and must still contain no such word');

  await paste(RESUME);
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  await page.fill('#question', 'Where did he go to school?');
  await page.evaluate(() => document.getElementById('ask').click());
  await page.waitForFunction(() => !document.getElementById('answer-wrap').hidden, null, { timeout: 60000 });

  const answer = await page.locator('#answer-prose').innerText();
  assert.match(answer, /St\.?\s*Clair/i, `the answer must name the college the resume names, but it read: ${answer}`);
  assert.doesNotMatch(
    answer,
    /University of Windsor/i,
    `the answer must not invent a university the resume never mentions, but it read: ${answer}`
  );
});
