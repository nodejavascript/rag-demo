/**
 * The cookie gate, checked against the files that actually ship.
 *
 * 🔴 **THIS FILE EXISTS BECAUSE THE FAILURE IT GUARDS AGAINST IS INVISIBLE.** A Google tag
 * put back into the page's `<head>` — by an agent who copies a snippet, or by a future
 * edit that "just adds analytics" — looks correct, loads fine, and breaks the one promise
 * this page makes to somebody pasting a diary or a resume. Nothing on the screen would
 * change. No unit test of the app would fail. The only way to catch it is to read the
 * shipped files and refuse.
 *
 * So these are guards on the SHAPE of the page rather than on its behaviour: the browser
 * tests in `e2e.test.js` prove what happens, and these prove there is nothing in the file
 * that could make the other outcome possible. A guard that only fails when a real mistake
 * is made is cheap; a promise that is only true until somebody edits a file is not a
 * promise.
 *
 * The three that matter most, in order:
 *
 *   1. **the page loads nothing from another origin** — so a visit that has not answered
 *      makes no request to anybody;
 *   2. **no Google tag sits in the page itself** — so the gate is the only door;
 *   3. **the gate never reads the paste box or the question** — so the text cannot leave,
 *      whatever else changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = join(here, '..', 'site');
const read = (name) => readFileSync(join(SITE, name), 'utf8');

const html = read('index.html');
const app = read('app.js');
const gate = read('consent.js');

/** The sibling demos, and the domain they all belong to. */
const DOMAIN = 'nodejavascript.com';
const SOURCE = `https://github.com/nodejavascript/rag-demo`;

/* ------------------------------------------------------------------ *
 * 1. A visit that has not answered contacts nobody
 * ------------------------------------------------------------------ */

test('the page loads nothing from another origin', () => {
  // A canonical link names this page's own address; it is not a load. Anything with a
  // remote `src`, or a remote stylesheet, would be. This is the assertion that would
  // have caught the tag being put back into the head, and it is deliberately written to
  // fail on ANY remote load rather than only on Google's — a second-origin request is
  // the thing, whoever is on the other end of it.
  const tags = [...html.matchAll(/<(script|link)\b[^>]*>/g)].map((m) => m[0]);
  const loading = tags.filter((tag) => !/rel="(canonical|alternate|preconnect|dns-prefetch)"/.test(tag));
  const remote = loading
    .map((tag) => (tag.match(/(?:src|href)="(https?:\/\/[^"]+)"/) || [])[1])
    .filter(Boolean);
  assert.deepEqual(remote, [], `the page loads something remote: ${remote.join(', ')}`);
});

test('no Google tag sits in the page itself', () => {
  assert.ok(
    !/googletagmanager|google-analytics|gtag\s*\(/.test(html),
    'the Google tag must never be written into the page — the gate appends it at runtime and only after a yes'
  );
});

test('the analytics script is created at runtime, not linked', () => {
  // The gate is allowed to build the tag; the page is not allowed to reference one. If
  // this ever fails because the gate stopped creating the tag, the second half of the
  // promise breaks too — consenting would count nothing.
  assert.match(gate, /createElement\('script'\)/, 'the gate must build the tag itself');
  assert.match(gate, /googletagmanager\.com\/gtag\/js/, 'and point it at the analytics script');
});

/* ------------------------------------------------------------------ *
 * 2. The promise about the text
 * ------------------------------------------------------------------ */

test('the gate never reads the paste box or the question', () => {
  // 🔴 THE ONE THIS PAGE CANNOT AFFORD TO BREAK. A diary, a resume, a medical letter.
  // `consent.js` may name a control by its id and never by its contents, so this asserts
  // it does not touch either box at all. It is written as a blanket ban rather than a
  // list of forbidden payloads because a payload rule only covers the leaks somebody
  // thought of.
  for (const forbidden of ['paste', 'question', '#paste', '#question']) {
    assert.ok(
      !new RegExp(`getElementById\\('${forbidden}'\\)`).test(gate),
      `the cookie gate must not reach for #${forbidden}`
    );
  }
  assert.ok(!/\bquerySelector(All)?\(\s*['"]#(paste|question)/.test(gate), 'nor select them');
  assert.ok(
    !/\.value/.test(gate),
    'the gate reads no input value at all — a control is described by its id and its tag, never by what was typed into it'
  );
});

test('the page sends the conversion without the question or the document', () => {
  // The one event the page originates. It may carry a size band and a duration; it may
  // not carry the question, and the size band is rounded so it cannot be inverted back
  // into a character count.
  const call = app.match(/ragTrack\?\.\('generate_lead'[\s\S]*?\);/);
  assert.ok(call, 'generate_lead must be sent through the gate');
  const payload = call[0];
  assert.ok(!/el\.question\.value/.test(payload), 'the question must not be in the payload');
  assert.ok(!/\.value/.test(payload), 'nothing typed may be in the payload');
  assert.match(payload, /Math\.round\(/, 'the document size must be rounded to a band, not sent exactly');
});

/* ------------------------------------------------------------------ *
 * 3. The gate and the page have to agree
 * ------------------------------------------------------------------ */

test('every id the gate looks up exists in the page', () => {
  // A misspelled id is the quietest failure this site could have: the bar renders, the
  // buttons appear, and pressing one throws into a console nobody is reading — so the
  // visitor is asked a question that cannot be answered and is not counted either way.
  const wanted = [...gate.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length > 4, 'the gate looks up the bar and its controls');
  const missing = [...new Set(wanted)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `index.html is missing: ${missing.join(', ')}`);
});

test('the page carries a measurement id for the gate to find', () => {
  const tag = html.match(/<script[^>]*data-ga-id="([^"]+)"[^>]*>/);
  assert.ok(tag, 'the consent script must carry the measurement id as an attribute');
  assert.match(tag[1], /^G-[A-Z0-9]{6,}$/, `that does not look like a measurement id: ${tag[1]}`);
  assert.match(tag[0], /\bdefer\b/, 'and must not block the page while it waits to ask');
  // The id must NOT be hard-coded in the gate, or a page that declares none would still
  // count — the gate would be open by default.
  assert.ok(!/G-[A-Z0-9]{6,}/.test(gate), 'the gate must take the id from the page, never carry one of its own');
});

test('the gate starts nothing when the page declares no measurement id', () => {
  // ⚠️ Whitespace-tolerant on purpose. This was first written as the exact literal
  // `if (!measurementId()) return;` and it FAILED — because `tsc` emits the single
  // statement onto its own line. The guard was never broken; the checker was, and a
  // checker that fails on correct code teaches the reader to ignore it. Assert the
  // meaning, not the layout.
  assert.match(
    gate,
    /if \(!measurementId\(\)\)\s*return;/,
    'no id, no bar and no tag — the gate is shut by default rather than open by default'
  );
});

/* ------------------------------------------------------------------ *
 * 4. The house standard, and the sibling household
 * ------------------------------------------------------------------ */

test('the same two storage keys as the sibling demos', () => {
  // One household, one pair of keys: a visitor who answered on llm-demo has answered
  // here, and the owner's switch means the same thing on every site George runs.
  assert.match(gate, /KEY = 'analytics_consent'/);
  assert.match(gate, /OWNER_KEY = 'ga_opt_out'/);
});

test('the owner can stand outside his own numbers, both ways', () => {
  assert.match(gate, /params\.get\('ga'\)/, '?ga=off / ?ga=on must be read from the address bar');
  assert.match(gate, /ownerOptedOut\(\)/, 'and must beat consent rather than needing to be re-chosen');
});

test('the events the house standard asks for are all sent', () => {
  for (const event of ['page_view', 'element_click', 'scroll_depth']) {
    assert.ok(gate.includes(`'${event}'`), `-- ${event} is part of the standard`);
  }
  assert.match(gate, /send_page_view: false/, 'the automatic page view must stay off, or the landing counts twice');
  assert.match(gate, /\[25, 50, 75, 100\]/, 'scroll depth at the four standard marks');
});

test('accept and reject are the same control', () => {
  // 🔴 Inviting a yes is honest. Obstructing the refusal is not. Both answers carry the
  // same class, so neither can drift into a smaller size, a greyer grey or a second
  // click without this failing.
  const accept = html.match(/<button[^>]*id="consentAccept"[^>]*>/);
  const decline = html.match(/<button[^>]*id="consentDecline"[^>]*>/);
  assert.ok(accept && decline, 'both answers must be on the page');
  const classOf = (tag) => (tag.match(/class="([^"]*)"/) || [])[1];
  assert.equal(classOf(accept[0]), classOf(decline[0]), 'the two answers must be drawn identically');
  assert.deepEqual(
    [accept[0], decline[0]].map((tag) => /\btype="button"/.test(tag)),
    [true, true],
    'and both must be real buttons rather than one being a link'
  );
});

test('the switch starts off, in the markup and not only in the script', () => {
  // A box that arrives already ticked is a default, not a choice. Asserted on the MARKUP
  // because a script that set it later would still flash the ticked state, which is the
  // part a reader reacts to.
  const toggle = html.match(/<button[^>]*id="consentAnalytics"[^>]*>/);
  assert.ok(toggle, 'the switch must exist');
  assert.match(toggle[0], /aria-checked="false"/, 'and must arrive off');
  assert.match(html, /id="consentAnalyticsWord"[^>]*>Off</, 'with the word saying so, not only the colour');
});

/* ------------------------------------------------------------------ *
 * 5. The footer
 * ------------------------------------------------------------------ */

test('the footer names the demo and links to the domain', () => {
  // 🔴 George asked for this specifically: a demo is a thing `nodejavascript.com`
  // publishes, and the footer is where a reader who arrived from a search result finds
  // out whose it is and what else is there. Both halves are asserted — a link with the
  // wrong word beside it is as unhelpful as no link.
  assert.match(html, /class="footer-brand"/, 'the brand row must be there');
  assert.ok(
    html.includes(`<a href="https://${DOMAIN}/">${DOMAIN}</a>`),
    `the footer must link to https://${DOMAIN}/`
  );
  assert.match(html, /<b>rag-demo<\/b>/, 'and name the demo beside it');
});

test('the footer links the source and the cookie settings', () => {
  // The source link is what makes a public repository worth having, and the settings
  // door is the only way back to the answer once the bar has gone.
  assert.ok(html.includes(SOURCE), 'the footer must link the public repository');
  // 🔴 THE LINK TEXT IS THE ADDRESS — the house shape, `llm-demo` being the reference, and
  // George asked for it here on 20 Sep 2026: *"change this to the repo url, linking to same"*.
  // A sentence describing a destination is harder to check at a glance than the destination.
  assert.ok(
    html.includes('>github.com/nodejavascript/rag-demo</a>'),
    'the source link should read as the address it goes to'
  );
  assert.match(html, /id="consentBtn"[^>]*>\s*Cookie settings/, 'and offer the way back to the cookie answer');
});

test('part 2: the panel names ONE choice, and the footer door is DELEGATED', () => {
  // 🔴 TWO HARD REQUIREMENTS OF PART 2, AND THIS SITE BROKE BOTH UNTIL 21 SEPTEMBER 2026.
  //
  // 1. THE OWNER'S COUNTING ROW IS NOT IN THE VISITOR'S PANEL. George, 19 Sep 2026, verbatim:
  //    *"new rule i dont want count my visits in the cookie settings"*. A "This device / Stop
  //    counting my visits" row sat in this panel, unhidden once the owner had used `?ga=off`.
  //    `?ga=off` / `?ga=on` still work from the address bar, which is where the owner's switch
  //    belongs.
  // 2. THE FOOTER DOOR IS DELEGATED, NOT BOUND. Binding `#consentBtn` directly runs once, at
  //    load, and works only while the footer is static HTML. It shipped broken on
  //    `password-please` for exactly that reason — its footer is a React component, so no
  //    listener was ever attached, and the button looked perfect and did nothing. Both forms
  //    behave identically on this site, which is why only reading the file can hold the rule.
  //
  // Comments are stripped first: this file's own source explains both removals by naming the
  // things removed, and a test that reads prose fails a change that is already correct.
  const panel = html.replace(/<!--[\s\S]*?-->/g, '');
  const gateCode = gate.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/consentDeviceRow|countToggle/.test(panel), false, "the owner's counting row must not be in the panel");
  assert.equal(/This device/.test(panel), false, 'nor the words that name it');
  assert.equal(/wordCountSwitch/.test(gateCode), false, 'and no code may be left to unhide one');
  assert.match(gateCode, /document\.addEventListener\('click'/, 'the door is one listener on the document');
  assert.match(gateCode, /closest\(['"]#consentBtn['"]\)/, 'matched as the click rises');
  assert.doesNotMatch(gateCode, /getElementById\('consentBtn'\)/, 'never looked up by id and bound');
});

test("the footer carries this site's own privacy policy, as a section of this page", () => {
  // Part 4 of the house standard: the links line carries the site's own policy — a `#privacy`
  // section of THIS page, never a `privacy.html` of its own.
  assert.match(html, /<a href="#privacy">Privacy<\/a>/, 'the footer must link the policy');
  assert.ok(html.includes('id="privacy"'), 'and the policy must be a section of this page');
});

test('and NO back to top — it is a control about the page, not about the site', () => {
  // 🔴 THIS ASSERTION WAS THE OTHER WAY ROUND, AND THAT IS THE POINT. It required
  // `href="#top"` until 20 Sep 2026, because the footer template carried one — so the test that
  // was supposed to keep the footer honest was the reason a back-to-top link survived on the one
  // site built after the rule forbidding it. The house standard (part 4) changed on 19 Sep:
  // *"remeber this, to remove · back to top from footers"*. **A rule that lives only in a site's
  // own test is a rule that site can keep getting wrong.** Inverted, so it cannot come back.
  assert.doesNotMatch(html, /back to top/i, 'no back-to-top link anywhere in the page');
  assert.doesNotMatch(html, /href="#top"/, 'and no anchor to the top of the page');
});

test('every in-page footer link points at a section that exists', () => {
  const anchors = [...html.matchAll(/href="#([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.length > 0, 'the footer has in-page links');
  const broken = [...new Set(anchors)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(broken, [], `these anchors do not exist: ${broken.join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * 6. The page's own copy has to stay true
 * ------------------------------------------------------------------ */

test('the privacy section no longer claims there is no analytics', () => {
  // 🔴 This paragraph said, until analytics was added: *"There is no account, no
  // analytics and no tracking of any kind on this page. There is deliberately no
  // cookie."* That was true when it was written and became a lie the moment a tag was
  // possible — which is the failure mode of every privacy paragraph ever written. So it
  // is asserted: the page must describe what is actually counted, and must say plainly
  // that the pasted text is not part of it.
  assert.ok(
    !/no analytics and no tracking of any kind/i.test(html),
    'the page must not go on claiming there is no analytics'
  );
  assert.match(html, /What is counted, and what is not/i, 'it must describe what is counted');
  assert.match(
    html,
    /Never the text you paste and never the question you type\./i,
    'and state the one thing that matters on this page'
  );
});

test('the ask says the same thing before anything loads', () => {
  assert.match(
    html,
    /the text you paste is never sent to Google, whatever you answer here/i,
    'the question itself must carry the promise, not only the section below it'
  );
  assert.match(
    gate,
    /no strictly necessary cookie/i,
    'and the gate must record that this site has no essential cookie to describe'
  );
});
