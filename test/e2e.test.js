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
const RESUME = readFileSync(new URL('../fixtures/sample-resume.md', import.meta.url), 'utf8');

let child = null;
let browser = null;
let page = null;
let modelUp = false;
let modelNote = 'no model is reachable, so no question can be answered';
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

/**
 * No chart is drawn at one width and shown at another.
 *
 * 🔴 **THIS IS THE WHOLE OF "STRETCHED", AS A CHECK.** A canvas is measured at the moment it is
 * drawn — `fit()` reads `clientWidth` — so a chart drawn while its section was still HIDDEN was
 * laid out at the 320-pixel fallback and then scaled to the full column. Measured on the live site
 * on 20 Sep 2026: the heat map was stretched **2.56×** and the timeline 1.41×. George saw it from
 * the outside and said four panels were "stretched"; the numbers say why, and a screenshot review
 * had missed it for hours. The bitmap and the space it occupies must agree.
 *
 * ⚠ **IT FIRES ONLY WHEN BOTH HALVES OF THE FIX ARE MISSING, WHICH IS THE STATE THE LIVE SITE WAS
 * IN.** Revealing the section before drawing is one fix; the repaint on a layout change is the
 * other, and the repaint alone corrects a wrong order — proven here, because injecting the order
 * fault on its own left this assertion PASSING. That was worth learning rather than assuming: the
 * guard would have been a check that cannot fail. Disabling both (no repaint, drawn while hidden)
 * makes it report `timeline: bitmap 320, shown 450` — the live fault, reproduced.
 */
async function assertNothingStretched(where) {
  const stretched = await page.evaluate(() => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    return [...document.querySelectorAll('.chart-box canvas, .details .detail canvas')]
      .filter((canvas) => canvas.getBoundingClientRect().width > 0 && canvas.width > 0)
      .map((canvas) => ({
        id: canvas.id || '(no id)',
        bitmap: canvas.width,
        shown: Math.round(canvas.getBoundingClientRect().width),
        factor: +(canvas.width / canvas.getBoundingClientRect().width).toFixed(2),
      }))
      .filter((row) => Math.abs(row.factor - ratio) > 0.05);
  });
  assert.deepEqual(stretched, [], `${where}: drawn at one width, shown at another`);
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

  // 🔴 A MODEL THAT ANSWERS IS NOT A MODEL THAT ANSWERS IN TIME — standard part 6f, outcome 3
  // (24 September 2026). `health.ok` proves Ollama replied to /api/tags; it says nothing about
  // SPEED. On this machine the 7B chat model measured **44 s for an 8-token reply**, so the answer
  // test could never finish inside its 180-second budget and the suite reported **25 failures that
  // were all one slow machine** — and a test that fails for a reason unrelated to the code teaches
  // the reader to ignore failures, which is the thing this suite's own header warns about. So the
  // model's speed is MEASURED here, and the skip below NAMES it.
  if (modelUp) {
    const base = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
    const started = Date.now();
    try {
      const probe = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: health.chatModel ?? 'qwen2.5:7b',
          prompt: 'Reply with the single word: ok',
          stream: false,
          options: { num_predict: 8 },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      await probe.json();
    } catch {
      /* a thrown probe means it was far slower than the cap — the timing below is the point */
    }
    const ms = Date.now() - started;
    if (ms > 20_000) {
      modelUp = false;
      modelNote = `the model is too slow to answer here: ${(ms / 1000).toFixed(1)} s for an 8-token reply`;
    }
  }

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
  // 🔴 The title IS the hostname, so this asserts the name the app goes by. It read
  // "Ask any document — rag" until the app was renamed, and this line went on passing
  // against nothing — a reminder that a test naming a string is a test that has to be
  // changed when the string is.
  assert.match(await page.title(), /^rag-demo\.nodejavascript\.com$/);
  await page.waitForFunction(() => document.getElementById('health').innerHTML.length > 0);
  const health = await page.locator('#health').innerText();
  assert.ok(health.length > 0, 'the model status must be reported on arrival');
});

test('a file dropped anywhere on the BOX is read — not only on the textarea', async (t) => {
  if (!page) return t.skip('no browser');
  // 🔴 THE COPY PROMISED THIS AND THE LISTENERS DID NOT KEEP IT. The hint said *"drop a .txt, .md,
  // .csv, .html or .pdf file anywhere on this box"* while `dragover`/`drop` were bound to the
  // textarea — so the box's own edges and padding did nothing, and a reader who dropped a file a
  // centimetre outside the textarea concluded the feature did not exist. George asked, 22 Sep 2026:
  // *"how about drage and drop as well as pasting?"*
  //
  // The drop is synthesized in the page, on the WRAPPER, which is the case that used to fail: a
  // drop on the textarea itself would have passed before this test existed.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const text = 'Dropped notes.\n\n4 April 2024\n\nThe boiler was replaced, and it cost $980.';
  const seen = await page.evaluate(async (payload) => {
    const box = document.getElementById('paste-wrap');
    const transfer = new DataTransfer();
    transfer.items.add(new File([payload], 'dropped-notes.txt', { type: 'text/plain' }));
    box.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true }));
    const highlighted = box.classList.contains('drop');
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
    const cleared = box.classList.contains('drop');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      highlighted,
      cleared,
      value: document.getElementById('paste').value,
      stat: document.getElementById('paste-stat').textContent,
    };
  }, text);
  assert.equal(seen.highlighted, true, 'the box does not show that it will accept the file');
  assert.equal(seen.cleared, false, 'and it keeps showing it after the file has been dropped');
  assert.match(seen.value, /4 April 2024/, 'the dropped file was not read into the box');
  assert.match(seen.stat, /dropped-notes\.txt/, 'and the box does not say which file it read');

  // And the box is a real drop target: a drop on its padding, away from the textarea, is the case
  // that used to do nothing.
  const onPadding = await page.evaluate(() => {
    const box = document.getElementById('paste-wrap');
    const boxRect = box.getBoundingClientRect();
    const areaRect = document.getElementById('paste').getBoundingClientRect();
    return { boxTop: Math.round(boxRect.top), textTop: Math.round(areaRect.top), gap: Math.round(areaRect.top - boxRect.top) };
  });
  assert.ok(onPadding.gap >= 0, 'the box must have room around the textarea for this to mean anything');
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

  // 🔴 THE LINE THAT NAMES THE DOCUMENT, AS IT IS ACTUALLY RENDERED. George, 22 Sep 2026: *"make it
  // say only this This looks like a resume"*. Asserted on the text in the DOM rather than in the
  // source, because the string is assembled at runtime — and asserted HERE, in the test that has a
  // model to index with, because the line only exists once the server has read the document.
  const naming = await page.locator('#suggestions-hint').innerText();
  assert.match(naming, /^This looks like\s+\S/, `the line naming the document reads "${naming}"`);
  assert.doesNotMatch(naming, /try one of these/i, 'the tail came back on the line that names the document');
  assert.doesNotMatch(naming, /\.\s*$/, `the line that names the document ends in a full stop: "${naming}"`);

  // 🔴 THE ROOM ABOVE THE LINE MATCHES THE ROOM BELOW IT. George, 22 Sep 2026: *"add vertical smap
  // above same as what is on bottom"*. Measured, not declared — the heading's own bottom margin and
  // the line box's leading are both inside the distance the reader sees, so the assertion is on the
  // two distances rather than on the two CSS values.
  const room = await page.evaluate(() => {
    const head = document.querySelector('#step-2 .step-head').getBoundingClientRect();
    const line = document.getElementById('suggestions-hint-row').getBoundingClientRect();
    const hint = document.querySelector('#step-2 > p.hint').getBoundingClientRect();
    return { above: Math.round(line.top - head.bottom), below: Math.round(hint.top - line.bottom) };
  });
  assert.ok(
    Math.abs(room.above - room.below) <= 2,
    `the line naming the document has ${room.above}px above it and ${room.below}px below it`
  );

  // A canvas that was never drawn has zero painted pixels; one that was drawn does not.
  const painted = await page.evaluate(() => {
    const canvas = document.getElementById('timeline');
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  assert.equal(painted, true, 'the timeline chart must actually be drawn');
  await assertNothingStretched('right after indexing');

  // 🔴 THE NOTE MAP IS DRAWN, IN A REAL BROWSER, ON A DOCUMENT THAT WAS REALLY INDEXED. It is the chart
  // that shows what the search has to work with — one cell per note — and it is the child of a fault
  // this session found twice: a statement that was ONE note, and a resume question answered from eight
  // of twenty. A canvas that was never painted has no pixels, and a caption that never arrived leaves
  // the line empty; both are asserted here rather than assumed from the source.
  const noteMap = await page.evaluate(() => {
    const canvas = document.getElementById('note-map');
    const box = document.getElementById('notes-box');
    if (!canvas || !box) return { missing: true };
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink += 1;
    return { hidden: box.hidden, ink, caption: document.getElementById('note-map-note').textContent };
  });
  assert.equal(noteMap.missing, undefined, 'the note map is not on the page at all');
  assert.equal(noteMap.hidden, false, 'the note map is hidden on an indexed document');
  assert.ok(noteMap.ink > 200, `the note map was not drawn (${noteMap.ink} pixels of ink)`);
  assert.match(noteMap.caption, /note/, 'the note map has no caption');
});

test('a question gets an answer with its details and sources', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip(modelNote);

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
  await assertNothingStretched('on the answer panel');
});

test('a question the document does not answer is refused on the page', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip(modelNote);

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
 * What the document does not say — on the page, after a refusal.
 *
 * A refusal used to be a dead end: the reader was told the document does not say, and left
 * to work out which part of the question it did not say it about. This panel answers that
 * with a count rather than an opinion, which is why it is asserted on the PAGE — the unit
 * tests prove the counting, and only this can prove the reader ever sees it.
 */
test('a refusal says which words the document does not have', async (t) => {
  if (!page) return t.skip('no browser');

  await paste(await diary());
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  await page.fill('#question', 'What colour was the front door?');
  await page.evaluate(() => document.getElementById('ask').click());
  await page.waitForFunction(
    () => !document.getElementById('answer-wrap').hidden && document.getElementById('gaps').innerText.includes('door'),
    null,
    { timeout: 180000 }
  );

  const panel = await page.evaluate(() => ({
    visible: !document.getElementById('gaps').hidden,
    heading: document.getElementById('gaps').querySelector('h3').textContent,
    body: document.getElementById('gaps').innerText,
  }));

  assert.equal(panel.visible, true);
  assert.match(panel.heading, /does not say/i);
  assert.match(panel.body, /door/, 'the words the document lacks must be named');
  assert.match(panel.body, /colour/, 'and all of them, not just one');
  assert.match(
    panel.body,
    /not written by the model/i,
    'the reader must be told this part is counted rather than generated — it is the whole reason it can be trusted'
  );
  assert.match(
    panel.body,
    /not a missing answer/i,
    'and warned that a missing word does not mean the document cannot answer'
  );
});

/**
 * A well-formed document must produce NO conflict panel.
 *
 * 🔴 The assertion that matters more than the positive one. A panel claiming the reader's
 * document contradicts itself is only worth having if it never says so wrongly — and this
 * test is here because it did: run over the diary, the spelling check reported **`Tuesday`
 * and `Thursday` as one name written two ways**. Two edits apart, and entirely different
 * things. The unit tests cover the guards; this proves the page stays clean.
 */
test('a well-formed document is not accused of contradicting itself', async (t) => {
  if (!page) return t.skip('no browser');

  await paste(await diary());
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  await page.fill('#question', 'What happened on 6 March 2026?');
  await page.evaluate(() => document.getElementById('ask').click());
  await page.waitForFunction(
    () => !document.getElementById('answer-wrap').hidden && document.getElementById('answer-prose').innerText.length > 0,
    null,
    { timeout: 180000 }
  );

  const conflicts = await page.evaluate(() => ({
    hidden: document.getElementById('conflicts').hidden,
    body: document.getElementById('conflicts').innerText,
  }));
  assert.equal(conflicts.hidden, true, `the diary is well formed, so nothing may be reported. It said: ${conflicts.body}`);
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
  if (!modelUp) return t.skip(modelNote);

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

/* ==================================================================== *
 * The cookie gate, in a real browser
 * ==================================================================== *
 *
 * 🔴 **THESE TESTS EXIST BECAUSE THE PROMISE IS INVISIBLE.** The page says, in the panel
 * and in the Privacy section, that a visit which refuses makes no request to Google at
 * all. That claim is only worth anything if something checks it — so every test below
 * watches the NETWORK, not the code. A gate that set a flag and loaded the tag anyway
 * would render identically and pass a DOM assertion.
 *
 * Each one gets its own browser context, because the answer lives in localStorage and
 * `addInitScript` is the only way to reproduce "they answered this last time" without
 * clicking. Sharing the suite's page would leak one test's answer into the next, which
 * is exactly the kind of coupling that makes a suite pass while the site is broken.
 */

/** Anything on Google's side of the wire. */
const GOOGLE = /google-analytics\.com|googletagmanager\.com/;

/**
 * A fresh context, optionally with an answer already stored, with every request
 * recorded. `addInitScript` runs before any page script, so a remembered choice is
 * reproduced rather than clicked — which is the state a returning visitor is actually
 * in.
 */
async function openWith({ consent = null, path = '/', ownerOff = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  await context.addInitScript(
    ([answer, optedOut]) => {
      try {
        if (answer) localStorage.setItem('analytics_consent', answer);
        if (optedOut) localStorage.setItem('ga_opt_out', '1');
      } catch {
        /* storage off; the test then exercises the "nothing decided" path, and the
           assertions below will say so rather than pass quietly */
      }
    },
    [consent, ownerOff]
  );
  const requests = [];
  const page = await context.newPage();
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  return { context, page, requests, toGoogle: () => requests.filter((url) => GOOGLE.test(url)) };
}

test('a visit that has not answered contacts nobody', async (t) => {
  if (!browser) return t.skip('no browser');
  const { context, page, toGoogle } = await openWith();
  try {
    assert.deepEqual(toGoogle(), [], 'a visit that has not consented must contact nobody');
    assert.equal(
      await page.evaluate(() => typeof window.gtag),
      'undefined',
      'there must be no gtag to call — not a gtag that stays quiet'
    );
    assert.equal(
      await page.evaluate(() => typeof window.ragTrack),
      'undefined',
      'and no way for the page to send an event either'
    );
    assert.equal(await page.locator('#consentAsk').isVisible(), true, 'so the question is what is shown');
    assert.equal(
      await page.locator('#consentAnalytics').isVisible(),
      false,
      'and the switch is one click behind it rather than in the reader’s face'
    );
  } finally {
    await context.close();
  }
});

test('rejecting is remembered, and nothing loads', async (t) => {
  if (!browser) return t.skip('no browser');
  const { context, page, toGoogle } = await openWith();
  try {
    await page.click('#consentDecline');
    await page.waitForFunction(() => document.getElementById('consentBar').hidden);
    assert.equal(await page.evaluate(() => localStorage.getItem('analytics_consent')), 'denied');
    assert.equal(await page.evaluate(() => typeof window.gtag), 'undefined');

    // The honest half: refusing is not a nag. A returning visitor is not asked again.
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(
      await page.evaluate(() => document.getElementById('consentBar').hidden),
      true,
      'the bar must not come back on the next visit'
    );
    assert.deepEqual(toGoogle(), [], 'and a refusal must still make no request to Google');
  } finally {
    await context.close();
  }
});

test('accepting loads the tag, once, and only after the answer', async (t) => {
  if (!browser) return t.skip('no browser');
  const { context, page, toGoogle } = await openWith();
  try {
    assert.deepEqual(toGoogle(), [], 'nothing before the answer');
    await page.click('#consentAccept');
    await page.waitForFunction(() => document.getElementById('consentBar').hidden);
    // ⚠️ Playwright's signature is `waitForRequest(urlOrPredicate, options)`. Passing a
    // placeholder second argument reads `null` as the options object and throws about a
    // missing `timeout` — the options go SECOND.
    await page.waitForRequest((request) => GOOGLE.test(request.url()), { timeout: 15000 });

    assert.equal(await page.evaluate(() => localStorage.getItem('analytics_consent')), 'granted');
    assert.equal(await page.evaluate(() => typeof window.ragTrack), 'function', 'the page gains its own way to send');

    const google = toGoogle();
    assert.ok(
      google.some((url) => url.includes('googletagmanager.com/gtag/js')),
      'the tag itself must be fetched'
    );
    // Exactly one tag. Loading it twice is the ordinary way a page double-counts every
    // visitor, and the guard that prevents it is a boolean in the gate.
    assert.equal(
      google.filter((url) => url.includes('/gtag/js')).length,
      1,
      `the tag must load exactly once: ${google.join(', ')}`
    );
  } finally {
    await context.close();
  }
});

/**
 * 🔴 THE ASSERTION THIS WHOLE FILE IS REALLY FOR.
 *
 * The page asks people to paste a diary, a resume, a set of terms. Its promise — in the
 * bar, in the panel and in the Privacy section — is that the text goes to the model and
 * nowhere else. So this grants consent, puts an unmistakable marker in BOTH boxes, drives
 * the page, and then reads every request that went to Google looking for it. It needs no
 * model: the claim is about what the page can send, and the page's sending path is the
 * gate.
 */
test('the text in the boxes never reaches Google', async (t) => {
  if (!browser) return t.skip('no browser');
  const { context, page, requests } = await openWith({ consent: 'granted' });
  const MARKER = 'ZWARTHOOF-9931-SECRET-DIARY';
  try {
    await page.waitForRequest((request) => GOOGLE.test(request.url()), { timeout: 15000 });

    await page.fill('#paste', `${MARKER} — private notes about nothing in particular.`);
    // ⚠️ `#question` is only revealed once a document has been indexed, and indexing needs
    // a model — this test must not. The claim being checked is about what the page can
    // SEND, so the value is put in the box directly: the text is in the field either way,
    // and the gate does not know the difference between typed and assigned.
    await page.evaluate((value) => {
      document.getElementById('question').value = value;
    }, `What does ${MARKER} say?`);
    // Press a real control too, so the click listener — which names elements by id and
    // tag — is exercised while the boxes hold text. A footer anchor, because it has no
    // side effects: indexing would need a model, and this test must not.
    await page.click('.footer-links a[href="#how"]');
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await page.waitForTimeout(600);

    const carrying = requests.filter((url) => url.includes(MARKER));
    assert.deepEqual(carrying, [], `a request left with the text in it: ${carrying.join(', ')}`);
  } finally {
    await context.close();
  }
});

test('the owner can keep his own visits out, both ways', async (t) => {
  if (!browser) return t.skip('no browser');
  // Already allowed analytics — and still nothing loads, because the owner's switch
  // beats consent. That ordering is the point: it works without changing what every
  // visitor is offered.
  const { context, page, toGoogle } = await openWith({ consent: 'granted', ownerOff: true });
  try {
    await page.waitForTimeout(1200);
    assert.deepEqual(toGoogle(), [], '?ga=off must beat a granted answer');
    assert.equal(await page.evaluate(() => typeof window.gtag), 'undefined');
  } finally {
    await context.close();
  }

  const on = await openWith({ path: '/?ga=on' });
  try {
    assert.equal(await on.page.evaluate(() => localStorage.getItem('ga_opt_out')), null, '?ga=on clears it');
  } finally {
    await on.context.close();
  }
});

test('the footer door reopens the answer without re-asking the question', async (t) => {
  if (!browser) return t.skip('no browser');
  const { context, page } = await openWith({ consent: 'granted' });
  try {
    assert.equal(await page.evaluate(() => document.getElementById('consentBar').hidden), true);
    await page.click('#consentBtn');
    await page.waitForSelector('#consentPrefs:not([hidden])');
    assert.equal(
      await page.locator('#consentAsk').isVisible(),
      false,
      'somebody who already answered must not be asked again'
    );
    assert.equal(
      await page.locator('#consentAnalytics').getAttribute('aria-checked'),
      'true',
      'and the switch must show the answer they gave'
    );
  } finally {
    await context.close();
  }
});

test('the cookie bar does not sit on top of the footer it belongs to', async (t) => {
  if (!browser) return t.skip('no browser');
  // The banner is fixed to the bottom, so it takes the click on whatever is behind it.
  // On inputresponse that made the footer unclickable until a question about cookies had
  // been answered — and the footer is where the link to the domain lives here.
  //
  // ⚠️ Asserted by HIT-TESTING rather than by clicking through: the link points at the
  // live internet, and a test that navigates to a real third-party site is slow, flaky,
  // and fails for reasons that have nothing to do with this code. `elementFromPoint`
  // asks the browser what is actually at that pixel, which is precisely the question —
  // if the banner is over it, the answer is the banner.
  const { context, page } = await openWith();
  try {
    assert.equal(await page.locator('#consentAsk').isVisible(), true, 'the bar is up');
    const reserved = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).paddingBottom));
    assert.ok(reserved > 0, `the page must leave room for the banner, but reserved ${reserved}px`);

    const land = await page.evaluate(() => {
      const link = document.querySelector('footer a[href="https://nodejavascript.com/"]');
      if (!link) return { found: false };
      // ⚠️ The page sets `html { scroll-behavior: smooth }`, so `scrollIntoView()` starts
      // an ANIMATION and the rectangle read on the next line is the one from before it
      // moved — which is how this first reported the link as hidden under `nothing`.
      // Forced instant for the measurement, then put back.
      const html = document.documentElement;
      const was = html.style.scrollBehavior;
      html.style.scrollBehavior = 'auto';
      link.scrollIntoView({ block: 'center' });
      html.style.scrollBehavior = was;
      const box = link.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        found: true,
        href: link.getAttribute('href'),
        covered: !(hit === link || link.contains(hit)),
        coveredBy: hit ? hit.className || hit.tagName : 'nothing',
      };
    });

    assert.equal(land.found, true, 'the footer must link to the domain');
    assert.equal(land.href, 'https://nodejavascript.com/');
    assert.equal(
      land.covered,
      false,
      `the cookie bar is covering the footer link — it is under \`${land.coveredBy}\``
    );
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------- while it reads */

test('the index streams real progress, then the result, and never an error', async () => {
  // 🔴 THE CONTRACT THE CHART DEPENDS ON, READ OFF THE ENDPOINT IN A REAL BROWSER. George,
  // 20 Sep 2026: *"can we show a chart while its indexing?"* The chart is only honest if the
  // numbers behind it are real, so this asserts the shape: progress lines first, each carrying a
  // count out of a total that is known up front, then exactly one result line. A unique trailing
  // paragraph is added so the document cannot be deduped into an instant reuse — which would give
  // no progress at all and make this test pass while proving nothing.
  if (!page) return t.skip('no browser');

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const seen = await page.evaluate(async (text) => {
    const response = await fetch('./api/index/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${text}\n\n21 September 2026 — a line added only to make this document new. ${Math.random()}\n` }),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
    }
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      types: events.map((event) => event.type),
      stages: [...new Set(events.filter((e) => e.type === 'progress').map((e) => e.stage))],
      first: events.find((event) => event.type === 'progress'),
      progress: events.filter((event) => event.type === 'progress'),
      entries: events.find((event) => event.type === 'result')?.document?.stats?.entries,
    };
  }, await diary());

  assert.equal(seen.status, 200, 'the stream must answer 200 — a 502 is replaced by the edge');
  assert.match(seen.type ?? '', /ndjson/, 'and say what it is sending');
  assert.equal(seen.types[seen.types.length - 1], 'result', 'the last line must be the result');
  assert.ok(!seen.types.includes('error'), 'no error line on a run that worked');
  assert.ok(seen.types.indexOf('result') === seen.types.length - 1, 'and only one result');
  assert.deepEqual(seen.stages, ['reading', 'embedding', 'saving'], 'all three stages are reported');
  assert.equal(seen.first.stage, 'reading', 'the first report comes before any embedding');
  const embedding = seen.progress.filter((event) => event.stage === 'embedding');
  assert.ok(embedding.length >= 2, 'embedding must report more than once, or there is nothing to plot');
  assert.equal(embedding[0].done, 0);
  assert.ok(embedding[0].total > 0, 'the total is known before the first batch is sent');
  assert.equal(embedding[embedding.length - 1].done, embedding[0].total, 'and it ends at the total');
  assert.ok(seen.entries > 0, 'the result carries the document');
  // 🔴 THE TOTAL THE CHART IS SCALED TO COMES FROM THIS STAGE AND NO OTHER. `saving` reports 1 of
  // 1 — it is a single step — so taking the total from whatever arrived last scaled the axis to 1
  // while the line plotted eight notes and ran off the top of the box. Asserted here so the trap
  // lives in a test rather than only in a comment.
  const saving = seen.progress.filter((event) => event.stage === 'saving');
  assert.equal(saving[0].total, 1, 'the saving stage reports a step, not a note count');
  assert.ok(embedding[0].total > 1, 'and the embedding total is the note count');
  assert.doesNotMatch(JSON.stringify(seen.progress), /"stage":"(?!reading|embedding|saving)/, 'no invented stages');
});

test('and the page shows the chart while it is reading, then puts it away', async () => {
  if (!page) return t.skip('no browser');

  await paste(await diary());
  // Watching the attribute rather than polling: the run can be over in a few hundred
  // milliseconds, and a poll would miss it and then report the feature missing.
  await page.evaluate(() => {
    window.__progressSeen = 0;
    const box = document.getElementById('index-progress');
    new MutationObserver(() => {
      if (!box.hidden) window.__progressSeen += 1;
    }).observe(box, { attributes: true, attributeFilter: ['hidden'] });
  });

  assert.equal(
    await page.evaluate(() => document.getElementById('index-progress').hidden),
    true,
    'the chart must not be on screen before anything is indexed'
  );

  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  assert.ok(
    (await page.evaluate(() => window.__progressSeen)) > 0,
    'the progress panel never appeared while the document was being read'
  );
  // 🔴 AND IT STAYS. Hiding it on success hid it on short documents before anyone could read it —
  // the whole read of the sample is over in well under a second.
  assert.equal(
    await page.evaluate(() => document.getElementById('index-progress').hidden),
    false,
    'the chart is put away as soon as it is finished, which is too soon on a short document'
  );
  assert.match(
    await page.evaluate(() => document.getElementById('index-progress-note').innerText),
    /embedded in|already indexed/,
    'and it says what happened rather than what is happening'
  );
});


test('the lead sentence and the rest of the text flow as one block', async (t) => {
  if (!page) return t.skip('no browser');
  // 🔴 George, 20 Sep 2026: *"the alignment is all wrong here"*. The list is a flex row (so the
  // bullet dot can sit beside the text), and a flex container DROPS the whitespace between its
  // items — so `<b>It refuses rather than guesses.</b> A question …` became TWO flex items: the
  // bold phrase in a column of its own and the sentence in another, with a 10px gutter between
  // them. Every row's sentence therefore started at a different x, and a copy of the page read
  // `…guesses.**A question…`. `innerText` is the rendered text, so this is the exact symptom.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const rendered = await page.locator('.hero ul').innerText();
  assert.match(rendered, /guesses\. A question/, 'the space after the lead went missing again');

  // And the rows line up: every sentence starts immediately after its own lead, not in a gutter.
  const gutters = await page.evaluate(() => {
    const out = [];
    for (const li of document.querySelectorAll('.hero li')) {
      const bold = li.querySelector('b');
      const text = [...li.querySelectorAll('span')].pop();
      // The FIRST text node in the span is the one inside `<b>`, so the walker skips anything
      // inside the bold — what is wanted is the sentence that follows it.
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentElement && node.parentElement.closest('b')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      const first = walker.nextNode();
      if (!first) continue;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(first, Math.min(8, first.textContent.length));
      out.push(Math.round(range.getBoundingClientRect().left - bold.getBoundingClientRect().right));
    }
    return out;
  });
  for (const gap of gutters) {
    assert.ok(gap >= 0 && gap <= 6, `the sentence starts ${gap}px after its lead, which is a gutter not a space`);
  }
});

test('the page never moves the reader on its own', async () => {
  // 🔴 George, 20 Sep 2026: *"after it indexes it jumps to the bottom, remove that"*. The page
  // used to call `scrollIntoView` on step 3 the moment indexing finished, taking the reader away
  // from the chart that had just started moving. The only scroll left is the one back to the top
  // when a document is deleted, which is the page returning to its own home state.
  const bundle = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /scrollIntoView/, 'the page scrolls itself somewhere again');
});

test('the width of a bar IS the period the entry states', async (t) => {
  if (!page) return t.skip('no browser');

  // 🔴 GEORGE'S ASK, MEASURED OFF THE PIXELS. 20 Sep 2026, on his own resume: *"can you make the
  // width of the bar equal to the start and end for this timeline??"* — so this does not check that
  // a chart was drawn. It reads the canvas, finds each bar's own edges, and compares the widths
  // against the periods the document states. The bars are stroked in a solid colour precisely so
  // their two ends are exact in the pixels; the faded fill would have made the right edge
  // unmeasurable.
  // The BUILT-IN sample, not the fixture: its three roles state `July 2021 to September 2026`,
  // `March 2018 to June 2021` and `January 2017 to February 2018` — 63, 40 and 14 months — so the
  // widths this expects are arithmetic rather than a number copied from a screenshot.
  const sample = await (await fetch(`${BASE}/api/samples/resume`)).json();
  await paste(sample.text);
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  const found = await page.evaluate(() => {
    const canvas = document.getElementById('timeline');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const px = ctx.getImageData(0, 0, W, H).data;
    const at = (x, y) => {
      const i = (y * W + x) * 4;
      return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };

    // 🔴 THE AXIS IS FOUND BY GEOMETRY, NOT BY COLOUR — AND THAT WAS LEARNED THE HARD WAY.
    // A colour test for the axis line failed (it is antialiased over two rows, so neither row is
    // exactly the axis colour), the scan then ran down over the year labels underneath it, and the
    // antialiased edges of that text are dark enough to pass any bar-colour test — **12 rows
    // reported for 3 bars.** The axis is simply the longest run of painted pixels on the canvas, so
    // that is what is looked for, and everything below it is out of the scan.
    let axisY = H;
    for (let y = 0; y < H; y += 1) {
      let painted = 0;
      for (let x = 0; x < W; x += 1) if (at(x, y)[3] > 0) painted += 1;
      if (painted > W * 0.9) axisY = y;
    }

    // 🔴 A BAR PIXEL IS `r < 110 AND g > 170`, AND BOTH HALVES OF THAT WERE MEASURED. The three bar
    // colours are `#5eead4` (94, 234), `#14b8a6` (20, 184) and `#38bdf8` (56, 189) — all with a
    // bright green. Every text colour on the canvas is PALE: `#b2d3d8` (178, 211) and `#7ba1a8`
    // (123, 161). A threshold on the red channel alone is not enough, because ANTIALIASED text
    // pixels blend toward the dark panel and pass it: at about 55% the label lands at (101, 127),
    // which was counted, and a label drawn BESIDE a bar then extended that bar's measured width
    // from 152px to 306px — it made the check report a bar 40 months long as the widest on the
    // chart. Requiring a bright green as well excludes every blend of a pale colour: to reach
    // g > 170 the label must be at least ~78% opaque, and at that point its red is 141.
    const isBar = (r, g, b, a) => a > 0 && r < 110 && g > 170 && b > 150;

    const bands = [];
    for (let y = 0; y < axisY; y += 1) {
      let min = -1;
      let max = -1;
      let count = 0;
      for (let x = 0; x < W; x += 1) {
        const [r, g, b, a] = at(x, y);
        if (!isBar(r, g, b, a)) continue;
        if (min === -1) min = x;
        max = x;
        count += 1;
      }
      if (count === 0) continue;
      const last = bands[bands.length - 1];
      if (last && y === last.bottom + 1) {
        last.bottom = y;
        last.min = Math.min(last.min, min);
        last.max = Math.max(last.max, max);
      } else {
        bands.push({ top: y, bottom: y, min, max });
      }
    }

    return {
      css: Math.round(canvas.getBoundingClientRect().width),
      bitmap: W,
      axisY,
      height: H,
      bands: bands.map((band) => ({ top: band.top, bottom: band.bottom, left: band.min, width: band.max - band.min + 1 })),
      note: document.getElementById('timeline-note').innerText,
    };
  });

  assert.equal(found.bitmap, found.css, 'the canvas must be drawn at the width it is shown');
  assert.equal(found.bands.length, 3, 'three roles, three rows — one bar each');

  // The document states 63, 40 and 14 months. In document order: the most recent role first.
  const expected = [63, 40, 14];
  const widest = Math.max(...found.bands.map((band) => band.width));
  found.bands.forEach((band, at) => {
    const share = band.width / widest;
    const wanted = expected[at] / Math.max(...expected);
    assert.ok(
      Math.abs(share - wanted) < 0.06,
      `bar ${at} is ${Math.round(share * 100)}% of the widest and should be ${Math.round(wanted * 100)}% — ` +
        `a bar's width must be the period it states, not a slot (${JSON.stringify(found.bands)})`
    );
  });

  // And they are in time order across the rows: the most recent role starts furthest right.
  assert.ok(
    found.bands[0].left > found.bands[1].left && found.bands[1].left > found.bands[2].left,
    `the bars are not placed by date: ${found.bands.map((band) => band.left).join(', ')}`
  );
  assert.match(found.note, /period/i, 'and the caption says what the bars are');
});

test('and a diary draws days as marks instead of bars', async (t) => {
  if (!page) return t.skip('no browser');
  // The other half of *"i suppose i should assume it will not always be a resume"*: the same chart,
  // no mode switch, a document whose entries are single days.
  await paste(await diary());
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  const drawn = await page.evaluate(() => {
    const canvas = document.getElementById('timeline');
    const ctx = canvas.getContext('2d');
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) painted += 1;
    return { painted, note: document.getElementById('timeline-note').innerText };
  });
  assert.ok(drawn.painted > 200, 'the timeline must have something on it');
  assert.match(drawn.note, /each mark is one entry/i, 'and the caption must say these are single dates');
  assert.doesNotMatch(drawn.note, /period/i, 'a diary has no periods, and must not be described as if it had');
});

/* ------------------------------------------------- how an answer is built, as it is built */

/**
 * 🔴 THE CHART IS THE POINT OF THE WAIT, SO IT IS TESTED FROM THE WIRE UP.
 *
 * George asked for this on 20 Sep 2026: *"when i ask a question, is there some sort of progress chart
 * that can be applied?"* There are two halves, and each can fail on its own — the server can decide
 * to send one lump at the end (a chart that only ever appears after the answer, which is no chart at
 * all), and the page can fail to show what it was sent. So the stream is read line by line off the
 * socket, and the panel is watched in the browser.
 */
test('the answer arrives as stages as they happen, and the totals agree with them', async (t) => {
  if (!modelUp) return t.skip(modelNote);

  // Indexed over the API rather than through the page, because this test is about the wire.
  const indexed = await fetch(`${BASE}/api/index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: await diary(), name: 'stream test' }),
  });
  const { document } = await indexed.json();

  const response = await fetch(`${BASE}/api/ask/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: document.id, question: 'What did Andrea bring?' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /ndjson/, 'it must be a line-at-a-time stream');

  // Read it incrementally: if the server buffered the whole thing, the first line would arrive at
  // the same moment as the last, and that is exactly the fault being guarded against.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const lines = [];
  const arrivals = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        lines.push(JSON.parse(line));
        arrivals.push(Date.now());
      }
      index = buffer.indexOf('\n');
    }
  }

  const kinds = lines.map((line) => line.type);
  assert.equal(kinds.at(-1), 'result', 'exactly one result, and it comes last');
  assert.equal(kinds.filter((kind) => kind === 'result').length, 1);
  assert.equal(kinds.filter((kind) => kind !== 'progress' && kind !== 'result').length, 0, 'nothing else is sent');

  const progress = lines.filter((line) => line.type === 'progress');
  assert.deepEqual(
    progress.map((stage) => stage.stage),
    ['search', 'notes', 'model', 'model'],
    'search, then the notes chosen, then the model announced, then the model reported'
  );

  const search = progress[0];
  assert.ok(Number.isFinite(search.tookMs) && search.tookMs >= 0, 'the search is measured');
  assert.ok(search.found > 0 && search.kept > 0 && search.kept <= search.found);
  assert.equal(progress[1].silent, false);
  assert.equal(progress[2].tookMs, undefined, 'a call in flight has no duration to report');
  assert.ok(Number.isFinite(progress[3].tookMs) && progress[3].tookMs >= 0);

  const result = lines.at(-1);
  assert.equal(result.timings.retrieveMs, search.tookMs, 'the total counts the same search it reported');
  assert.equal(result.timings.modelMs, progress[3].tookMs, 'and the same model call');
  for (let i = 1; i < progress.length; i += 1) {
    assert.ok(progress[i].ms >= progress[i - 1].ms, 'and its clock never goes backwards');
  }

  // 🔴 THE ONE ASSERTION THAT PROVES IT STREAMS RATHER THAN POSTS. It is conditional on purpose:
  // when the model answers in under a second the whole reply can legitimately arrive in one chunk,
  // and demanding a gap there would be inventing a fault. When the model takes longer than a second,
  // a first line that arrives with the last one means nothing was streamed.
  if (result.timings.totalMs > 1000) {
    const gap = arrivals.at(-1) - arrivals[0];
    assert.ok(
      gap > 100,
      `the first stage arrived ${gap} ms before the result, over a ${result.timings.totalMs} ms answer — the stages are not being streamed`
    );
  }
});

test('the page shows how the answer is being built, while it is being built', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip(modelNote);

  await paste(await diary());
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  // 🔴 SAMPLED BY OBSERVER, NOT BY POLLING. A stage can be reported and the next one arrive between
  // two polls, and a test that misses it reports a pass it did not earn — the trap the index chart's
  // own test was written against, and the reason this watches the panel instead of looking at it.
  await page.evaluate(() => {
    window.__ask = [];
    const sample = () => {
      const canvas = document.getElementById('ask-chart');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
      window.__ask.push({
        note: document.getElementById('ask-progress-note').innerText,
        title: document.getElementById('ask-progress-title').innerText,
        rows: canvas.dataset.rows,
        painted,
        waiting: document.getElementById('answer-wrap').hidden,
      });
    };
    sample();
    new MutationObserver(sample).observe(document.getElementById('ask-progress'), {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });

  await page.fill('#question', 'What did Andrea bring?');
  await page.evaluate(() => document.getElementById('ask').click());
  await page.waitForFunction(
    () => !document.getElementById('answer-wrap').hidden && document.getElementById('answer-prose').innerText.length > 5,
    null,
    { timeout: 180000 }
  );

  const samples = await page.evaluate(() => window.__ask);
  const waiting = samples.filter((sample) => sample.waiting);
  assert.ok(waiting.length > 0, 'the panel must be up while the reader is still waiting, not only afterwards');
  assert.ok(
    waiting.some((sample) => /searching|found|reading|writing|chose/i.test(sample.note)),
    `the caption must say what is happening — saw: ${JSON.stringify(waiting.map((sample) => sample.note))}`
  );
  assert.ok(
    waiting.some((sample) => sample.painted > 0),
    'and something must be drawn on the chart before the answer arrives'
  );
  assert.ok(
    waiting.some((sample) => /answering/i.test(sample.title)),
    'while it is running it is titled as a running thing'
  );

  const after = await page.evaluate(() => ({
    hidden: document.getElementById('ask-progress').hidden,
    title: document.getElementById('ask-progress-title').innerText,
    note: document.getElementById('ask-progress-note').innerText,
    rows: document.getElementById('ask-chart').dataset.rows,
  }));
  assert.equal(after.hidden, false, 'the chart stays after the answer — it is the record of how it was built');
  assert.match(after.title, /how the answer was built/i);
  assert.match(after.note, /\d/, 'and the caption carries the real timings');

  // 🔴 THE STALE-ROW GUARD. The model is announced before its call and reported after it, so a chart
  // that draws every report leaves a row still saying "still running" — and still growing — on a
  // question that has already been answered. Measured on the live site on 20 Sep 2026: four rows
  // where three stages ran. One row per stage.
  assert.equal(after.rows, '3', `three stages ran, so three rows must be drawn — got ${after.rows}`);
  assert.ok(
    waiting.every((sample) => sample.rows === undefined || Number(sample.rows) <= 3),
    `no sample may ever show more rows than stages that have run — saw ${JSON.stringify([...new Set(waiting.map((sample) => sample.rows))])}`
  );
  await assertNothingStretched('with the progress chart up');
});

/**
 * 🔴 CLICKING THE SUGGESTED QUESTIONS QUICKLY MUST CANCEL THE ANSWER IT WALKED AWAY FROM.
 *
 * George's report, 22 September 2026, verbatim: *"this is allowing me to rapidly click the question
 * button this will overload. when i clicka dn its gathgering the answer, clicking should abort and
 * evaluate the new question"*. The suggested questions stay clickable on purpose, so before this
 * every impatient click started ANOTHER full answer — another model call, socket and buffer, each
 * held for as long as the model took.
 *
 * This test is the gesture itself: three clicks inside half a second. It asserts the two things that
 * were wrong, and both are asserted from the BROWSER's own account of the network rather than from
 * the page's own opinion:
 *
 *   1. the earlier asks were ABANDONED — Playwright reports them as failed requests with
 *      `net::ERR_ABORTED`, which is what an aborted `fetch` looks like from outside;
 *   2. the LAST question still gets answered — and the answer names the question that was clicked
 *      last, so a stale answer cannot be sitting where the new one should be.
 */
test('clicking the suggested questions quickly cancels the answers it walked away from', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip(modelNote);

  // 🔴 THE PROPERTY IS MEASURED AT THE SEAM, NOT FROM PLAYWRIGHT'S EVENT ORDER. Counting how many
  // asks are open at once from the network events races: the abort of one ask and the start of the
  // next are dispatched by the browser almost together, and on the first two runs of this test the
  // same correct page was reported as "1 in flight" and "2 in flight" — a measurement that disagrees
  // with the thing it measures. So the page's own `fetch` is wrapped BEFORE the app runs, and each
  // ask records two facts that do not race, because the abort happens SYNCHRONOUSLY before the next
  // request is created:
  //
  //   · `previousAborted` — was the ask before this one already cancelled when this one started?
  //   · `aborted` — did this ask's own signal fire?
  //
  // ⚠️ THIS MUST COME BEFORE THE FIRST `goto`, or it applies only to the NEXT navigation and the
  // page under test never gets the wrapper.
  await page.addInitScript(() => {
    window.__asks = [];
    window.__lastAsk = null;
    const real = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : String((input && input.url) || '');
      if (url.includes('/api/ask')) {
        const signal = init && init.signal;
        const previous = window.__lastAsk;
        const entry = {
          previousAborted: previous ? Boolean(previous.signal && previous.signal.aborted) : null,
          hasSignal: Boolean(signal),
          aborted: false,
        };
        window.__asks.push(entry);
        if (signal) signal.addEventListener('abort', () => { entry.aborted = true; });
        window.__lastAsk = { signal };
      }
      return real.apply(this, arguments);
    };
  });

  await paste(await diary());
  await page.evaluate(() => document.getElementById('index').click());
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });

  const asked = [];
  const abandoned = [];
  const isAsk = (request) => request.url().includes('/api/ask');
  page.on('request', (request) => {
    if (isAsk(request)) asked.push(request.url());
  });
  page.on('requestfailed', (request) => {
    if (isAsk(request)) abandoned.push(request.failure()?.errorText ?? 'failed');
  });

  const buttons = page.locator('#suggestions button');
  const count = await buttons.count();
  assert.ok(count >= 3, `the page must offer questions to click — it offered ${count}`);

  const third = (await buttons.nth(2).innerText()).trim();
  await buttons.nth(0).click();
  await page.waitForTimeout(150);
  await buttons.nth(1).click();
  await page.waitForTimeout(150);
  await buttons.nth(2).click();

  await page.waitForFunction(
    () => !document.getElementById('answer-wrap').hidden && document.getElementById('answer-prose').innerText.length > 0,
    null,
    { timeout: 180000 }
  );

  assert.equal(asked.length, 3, `the page asked three times, once per click — it asked ${asked.length}`);

  const seam = await page.evaluate(() => window.__asks);
  assert.equal(seam.length, 3, `three asks must have been created — saw ${JSON.stringify(seam)}`);
  assert.ok(
    seam.every((ask) => ask.hasSignal),
    `every ask must carry a signal, or nothing can cancel it — saw ${JSON.stringify(seam)}`
  );
  assert.equal(seam[0].previousAborted, null, 'the first ask has nothing before it to cancel');
  assert.ok(
    seam.slice(1).every((ask) => ask.previousAborted === true),
    'the ask before each new one must already be cancelled when the new one starts — ' + JSON.stringify(seam)
  );
  assert.ok(
    seam.filter((ask) => ask.aborted).length >= 2,
    `the asks the reader walked away from must be aborted — ${JSON.stringify(seam)}`
  );
  // And the network agrees: they were abandoned, not finished.
  assert.ok(
    abandoned.length >= 2,
    `the asks the reader walked away from must be cancelled, not left running — ${abandoned.length} ` +
      `were cancelled: ${JSON.stringify(abandoned)}`
  );
  assert.ok(
    abandoned.every((text) => /ABORTED/i.test(text)),
    `an abandoned ask must look like a cancellation, not a network fault — saw ${JSON.stringify(abandoned)}`
  );

  // The answer on the page belongs to the question clicked LAST: nothing stale painted over it.
  const askedOnPage = (await page.locator('#answer-q').innerText()).replace(/^You asked:\s*/i, '').trim();
  assert.ok(
    askedOnPage.includes(third.slice(0, 24)),
    `the answer shown must be for the last question clicked — page asked "${askedOnPage}", last click was "${third}"`
  );

  // And the button is usable again, because the newest ask, and only the newest, owns it.
  const button = await page.locator('#ask').innerText();
  assert.match(button, /ask/i, 'the ask button must be back to itself once the last answer lands');
});

/**
 * 🔴 INDEXING THE SAME TEXT TWICE MUST NOT BLINK.
 *
 * George, 22 Sep 2026, verbatim: *"the index it button does not behave the same, the chart is not there
 * and there is a weird flickering"*. All three were one behaviour, and the server's own log named it:
 * five runs of the same document, every one `reused=true`. The reused path sends no batches, so the
 * old code put the chart on screen on the way in (`hidden = false`) and took it off again on the way
 * out (`hidden = points.length === 0`) — inside about a tenth of a second. What a reader saw was a
 * canvas appearing and vanishing, a ~190-pixel layout shift as it did, and an Index button that went
 * disabled and enabled too fast to read, which is why it "does not behave the same".
 *
 * The property is asserted with a MutationObserver on the chart's own `hidden` attribute rather than by
 * timing anything: the second run of the same text must change it ZERO times, and the chart must be
 * exactly as visible after the run as it was before it.
 */
test('indexing the same text twice changes nothing on the page', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip('no model is reachable, so nothing can be indexed');

  const text = await diary();
  await paste(text);
  await page.click('#index');
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('index').disabled, null, { timeout: 60000 });

  const firstRun = await page.evaluate(() => ({
    chartHidden: document.getElementById('index-chart').hidden,
    note: document.getElementById('index-progress-note').innerText,
  }));

  // Watch the chart's visibility for the whole of the second run.
  await page.evaluate(() => {
    window.__chartFlips = 0;
    const chart = document.getElementById('index-chart');
    window.__chartObserver = new MutationObserver((records) => {
      for (const record of records) if (record.attributeName === 'hidden') window.__chartFlips += 1;
    });
    window.__chartObserver.observe(chart, { attributes: true, attributeFilter: ['hidden'] });
  });

  // The same text again. The server reuses the index, so this run embeds nothing and reports nothing.
  await page.click('#index');
  await page.waitForFunction(() => !document.getElementById('index').disabled, null, { timeout: 60000 });
  await page.waitForTimeout(600);

  const secondRun = await page.evaluate(() => {
    window.__chartObserver.disconnect();
    return {
      flips: window.__chartFlips,
      chartHidden: document.getElementById('index-chart').hidden,
      note: document.getElementById('index-progress-note').innerText,
      stat: document.getElementById('index-stat').innerText,
    };
  });

  assert.equal(
    secondRun.flips,
    0,
    `the chart was shown and hidden ${secondRun.flips} time(s) during the second run — the blink. ` +
      `First run: ${JSON.stringify(firstRun)} · second: ${JSON.stringify(secondRun)}`
  );
  assert.equal(
    secondRun.chartHidden,
    firstRun.chartHidden,
    `the chart changed visibility across the second run: was ${firstRun.chartHidden}, now ${secondRun.chartHidden}`
  );
  // And the page says what happened rather than looking broken: the reuse is a fact about the run.
  assert.match(secondRun.note, /already indexed|nothing to do/i, `the reused run must say so — got "${secondRun.note}"`);
});

/**
 * 🔴 THE LABEL INSIDE A BAR IS CENTRED ON THE BAR, NOT SITTING LOW IN IT.
 *
 * George, 22 Sep 2026, on the chart that says how the answer was built: *"the text in the bars is at
 * baseline, can the bars be thinker to accomodate centering the text vertically?"*. He was looking at
 * two faults: the bar was drawn from `y + 1` with a height of `rowH - 8`, while its label was drawn at
 * the centre of the ROW (`y + rowH / 2`) — so every label sat three pixels low, which reads as sitting
 * on the baseline — and an 8-pixel gap between rows made the bars thin.
 *
 * Measured rather than assumed: the vertical centre of the DARK ink (the labels are `#04221f` and
 * nothing else on this canvas is that dark) is compared with the vertical centre of the bar ink. If
 * the labels are centred in their bars the two are the same line; with the old geometry the labels sat
 * about three pixels below it, which is what this is here to catch.
 */
test('the label in the answer chart is centred on the bar it belongs to', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip(modelNote);

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
  await page.waitForFunction(() => document.getElementById('ask-chart').dataset.rows === '3', null, { timeout: 60000 });

  const measured = await page.evaluate(() => {
    const canvas = document.getElementById('ask-chart');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const pixels = ctx.getImageData(0, 0, width, height).data;
    // ⚠️ MEASURED PER ROW, AND THE FIRST VERSION OF THIS TEST WAS NOT. It compared the centre of ALL
    // the dark ink with the centre of ALL the bar ink — which is the right comparison only if every
    // bar carries a label, and on this chart most do not: a short search bar writes its name BESIDE
    // the bar in grey, so only the longest row holds its label inside. The first run found 34 label
    // pixels in one row and compared them against three rows of bars, which measures nothing. So the
    // labels are grouped into rows by their own y, and each row is judged on its own.
    // The label inside a bar is #04221f; the axis is #1b434b (its blue is 75, past this test).
    const isLabel = (at) => pixels[at] < 70 && pixels[at + 1] < 70 && pixels[at + 2] < 70 && pixels[at + 3] > 0;
    const rows = [];
    const inkAt = new Map();
    for (let y = 0; y < height; y += 1) {
      let labels = 0;
      let ink = 0;
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        if (pixels[at + 3] === 0) continue;
        ink += 1;
        if (isLabel(at)) labels += 1;
      }
      if (ink > 0) inkAt.set(y, ink);
      if (labels > 0) rows.push({ y, labels });
    }
    // Group the labelled pixel-rows into runs, and give each run the bar ink in the same band.
    const bands = [];
    let run = null;
    for (const row of rows) {
      if (run && row.y === run.last + 1) {
        run.last = row.y;
        run.labels += row.labels;
      } else {
        if (run) bands.push(run);
        run = { first: row.y, last: row.y, labels: row.labels };
      }
    }
    if (run) bands.push(run);
    return {
      bands: bands.map((band) => {
        const centre = (band.first + band.last) / 2;
        // The bar's own extent, taken from the ink rows that touch this band and continue outwards.
        let top = band.first;
        let bottom = band.last;
        while (top - 1 >= 0 && (inkAt.get(top - 1) ?? 0) > 0) top -= 1;
        while (bottom + 1 < height && (inkAt.get(bottom + 1) ?? 0) > 0) bottom += 1;
        const barCentre = (top + bottom) / 2;
        return { labelCentre: centre, barCentre, offBy: Math.abs(centre - barCentre), labels: band.labels };
      }),
      size: `${width}x${height}`,
    };
  });

  assert.ok(measured.bands.length > 0, 'the chart must draw at least one label inside a bar');
  assert.ok(
    measured.bands.reduce((most, band) => Math.max(most, band.labels), 0) > 20,
    `the labels must be drawn — largest run had ${Math.max(...measured.bands.map((band) => band.labels))} pixels`
  );
  const worst = measured.bands.reduce((most, band) => Math.max(most, band.offBy), 0);
  assert.ok(
    worst < 1.5,
    `a label sits ${worst.toFixed(1)}px from the centre of its bar, on a ${measured.size} canvas — ` +
      `${JSON.stringify(measured.bands)}`
  );
});

/**
 * 🔴 AN EMPTY CHART IN A BOX TITLED "HOW IT READ IT" IS WORSE THAN NO CHART.
 *
 * George, 22 Sep 2026, verbatim: *"same input, and clicked index it and ### How it read it did nothing"*.
 * He was re-indexing a book that was already indexed. A reused run streams no batches, so the chart is
 * never drawn — and the box, with its title, was left on screen holding nothing at all. The click had
 * become invisible: the button went disabled and enabled inside a tenth of a second and no drawing
 * appeared.
 *
 * This reproduces it exactly: index a document, RELOAD the page (so nothing has been painted in this
 * session), then index the same text again. The chart must not be shown, and the button must say what
 * happened.
 */
test('re-indexing a document already indexed does not leave an empty chart on screen', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip('no model is reachable, so nothing can be indexed');

  const text = await diary();
  await paste(text);
  await page.click('#index');
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('index').disabled, null, { timeout: 60000 });

  // A fresh page: nothing has been painted in this session, which is the state he was in.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.fill('#paste', text);
  await page.waitForFunction(() => !document.getElementById('index').disabled, null, { timeout: 20000 });
  await page.click('#index');
  await page.waitForFunction(() => !document.getElementById('index').disabled, null, { timeout: 60000 });
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    chartHidden: document.getElementById('index-chart').hidden,
    note: document.getElementById('index-progress-note').innerText,
    button: document.getElementById('index').innerText.trim(),
    stat: document.getElementById('index-stat').innerText,
  }));

  assert.equal(
    after.chartHidden,
    true,
    `a reused run must not leave an empty chart on screen — ${JSON.stringify(after)}`
  );
  assert.match(after.note, /already indexed/i, `the box must say why — got "${after.note}"`);
  assert.match(
    after.button,
    /already indexed/i,
    `the click must visibly do something — the button says "${after.button}"`
  );
});

/**
 * 🔴 ONE DOCUMENT AT A TIME.
 *
 * George, 22 Sep 2026, verbatim: *"when i index something, remove that last thing indexed first, i dont
 * wantr to combine inputs"*. The page replaced what it showed but left every earlier paste in the store
 * until its 24-hour expiry, so a session accumulated documents and the reader could not tell that the
 * thing they were asking about was not the only thing on the site. Indexing now removes the previous one
 * — after the new one is safely in, so a paste that fails cannot destroy the last good document.
 */
test('indexing a new document removes the one before it', async (t) => {
  if (!page) return t.skip('no browser');
  if (!modelUp) return t.skip('no model is reachable, so nothing can be indexed');

  // Record the id of every document the page indexes, and every delete it asks for.
  await page.addInitScript(() => {
    window.__indexed = [];
    window.__deleted = [];
    const real = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : String((input && input.url) || '');
      const method = (init && init.method) || 'GET';
      if (url.includes('/api/document/') && method === 'DELETE') {
        window.__deleted.push(url.split('/api/document/')[1]);
      }
      const answer = real.apply(this, arguments);
      if (url.includes('/api/index')) {
        answer
          .then((response) => response.clone().text())
          .then((body) => {
            const line = body.split('\n').find((row) => row.includes('"document"'));
            if (line) {
              try {
                const id = JSON.parse(line).document.id;
                if (!window.__indexed.includes(id)) window.__indexed.push(id);
              } catch {
                /* a line that will not parse is not an index result */
              }
            }
          })
          .catch(() => {});
      }
      return answer;
    };
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#paste', await diary());
  await page.waitForFunction(() => !document.getElementById('index').disabled, null, { timeout: 20000 });
  await page.click('#index');
  await page.waitForFunction(() => !document.getElementById('shape').hidden, null, { timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('index').disabled, null, { timeout: 60000 });

  // A different document — his own resume, which is not a diary at all.
  await page.fill('#paste', RESUME);
  await page.waitForFunction(() => !document.getElementById('index').disabled, null, { timeout: 20000 });
  await page.click('#index');
  await page.waitForFunction(() => window.__indexed.length === 2, null, { timeout: 120000 });
  await page.waitForFunction(() => window.__deleted.length > 0, null, { timeout: 20000 });

  const seen = await page.evaluate(() => ({ indexed: window.__indexed, deleted: window.__deleted }));
  assert.equal(seen.indexed.length, 2, `two documents were indexed — ${JSON.stringify(seen)}`);
  assert.ok(
    seen.deleted.includes(seen.indexed[0]),
    `the first document must be deleted when the second is indexed — ${JSON.stringify(seen)}`
  );
  assert.ok(
    !seen.deleted.includes(seen.indexed[1]),
    `the document now on screen must not be deleted — ${JSON.stringify(seen)}`
  );

  // And the server agrees: the first one is gone.
  const gone = await page.evaluate(async (id) => {
    const response = await fetch(`./api/document/${id}`);
    return response.status;
  }, seen.indexed[0]);
  assert.equal(gone, 404, `the previous document must be gone from the server — it answered ${gone}`);
});
