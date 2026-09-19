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
