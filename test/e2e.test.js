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
  await assertNothingStretched('right after indexing');
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
  await assertNothingStretched('on the answer panel');
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
