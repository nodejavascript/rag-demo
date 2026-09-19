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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4733;
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let browser = null;
let page = null;
let modelUp = false;
let dir = null;

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
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.getElementById('use-diary').click());
  await page.waitForFunction(() => document.getElementById('paste').value.length > 500);

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

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.getElementById('use-diary').click());
  await page.waitForFunction(() => document.getElementById('paste').value.length > 500);
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

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.getElementById('use-diary').click());
  await page.waitForFunction(() => document.getElementById('paste').value.length > 500);
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
