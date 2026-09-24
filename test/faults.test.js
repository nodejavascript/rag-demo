/**
 * The fault report, checked twice: what it sends, and what it can never send.
 *
 * 🔴 WHY THIS FILE EXISTS. `src/site/faults.ts` is the one thing on this page that
 * transmits WITHOUT the reader saying yes, and the only reason that is allowed is
 * that it carries nothing about them. So the promise is not "we are careful" — it is
 * a list, and every item in the list is asserted here against the file that ships:
 *
 *   1. exactly six fields, and no seventh;
 *   2. no query string anywhere, because a query is where the reader's own question
 *      and the document's own name would travel;
 *   3. no storage and no cookie is touched, because the page promises the only cookie
 *      here is the analytics one;
 *   4. one address only — this site's own `/api/fault` — because the page also
 *      promises that the document never leaves the machine, and a reporter that
 *      posted straight to Rollbar would have broken that sentence;
 *   5. a page that is failing in a loop stays one item, not a flood.
 *
 * 🔴 AND THE OTHER HALF IS THE CENSUS — a caught error is invisible unless the catch
 * says so. George, 23 September 2026, verbatim: ***"if you have any try/catch rollbar
 * wont get it unless to invoke the catch err and send to rollbar."*** No amount of
 * listening closes that gap, so every `catch` in the page's own scripts must either
 * report the fault or carry a `// expected:` line saying why it is not one. The
 * failure this guards against is a `catch` added six months from now that quietly
 * swallows something — and a rule written in a comment cannot stop that. Only a test
 * fires at the moment of work.
 *
 * A stubbed browser is used rather than a real one because the reporter is loaded the
 * way the page loads it — a classic script, before anything else — and the traps on
 * `localStorage`, `sessionStorage` and `document.cookie` count what the page touches.
 * A getter that counts is worth more than a comment that promises.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const SRC = join(ROOT, 'src', 'site');

const read = (...parts) => readFileSync(join(...parts), 'utf8');

/** Strip comments, so a `catch` mentioned in prose is not counted as one. */
function stripJs(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ------------------------------------------------------------------ *
 * a stubbed browser, with a trap on everything the page must not touch
 * ------------------------------------------------------------------ */

let loads = 0;

/**
 * Every catch block in a file, each with the body that belongs to it.
 *
 * 🔴 THE SAME CONSTRUCT HAS TWO SHAPES, AND KNOWING ONLY ONE COST A FALSE FAILURE ON
 * THE REFERENCE'S FIRST RUN. The TypeScript source writes `} catch {` on one line;
 * the emitted file can put the brace and `catch` on separate lines. A check that
 * looked for `} catch` alone would find zero in one of them and report *"this check is
 * measuring nothing"* — a good failure to have, but still a check disagreeing with the
 * thing it checks.
 *
 * THE BODY IS TAKEN TO THE END OF THE BLOCK, NOT FOR A FIXED FEW LINES. A four-line
 * window misses the catches whose first statement sits under a longer explanation, and
 * that is a false failure on a correct catch — the expensive kind.
 */
function catchBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];

  lines.forEach((line, index) => {
    if (!/^\s*(?:\}\s*)?catch\s*[({]/.test(line)) return;
    const indent = (line.match(/^\s*/) || [''])[0].length;
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end];
      const depth = (candidate.match(/^\s*/) || [''])[0].length;
      if (/^\s*\}$/.test(candidate) && depth === indent) break;
      end += 1;
    }
    blocks.push({ at: index + 1, body: lines.slice(index + 1, end).join('\n') });
  });

  return blocks;
}

/**
 * Run `site/faults.js` the way the page runs it — as a classic script, before
 * anything else — and hand back what it sent.
 */
async function loadPage(options = {}) {
  const beacon = options.beacon === undefined ? true : options.beacon;
  const sent = [];
  const listeners = new Map();
  const touched = { storage: 0, cookie: 0 };

  const document = {};
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      touched.cookie += 1;
      return '';
    },
    set() {
      touched.cookie += 1;
    },
  });

  const window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    document,
  };

  // A getter that counts, rather than a value the page could use quietly.
  const countingStore = {
    configurable: true,
    get() {
      touched.storage += 1;
      return {
        getItem() {
          touched.storage += 1;
          return null;
        },
        setItem() {
          touched.storage += 1;
        },
        removeItem() {
          touched.storage += 1;
        },
        clear() {
          touched.storage += 1;
        },
      };
    },
  };

  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  define('window', window);
  define('document', document);
  define('location', { pathname: '/', protocol: 'https:' });
  define('navigator', {
    sendBeacon(url, blob) {
      sent.push({ kind: 'beacon', url, blob });
      return beacon;
    },
  });
  define('fetch', async (url, init) => {
    sent.push({ kind: 'fetch', url, init });
    return { ok: true };
  });
  define('HTMLScriptElement', class HTMLScriptElement {});
  define('HTMLLinkElement', class HTMLLinkElement {});
  Object.defineProperty(globalThis, 'localStorage', countingStore);
  Object.defineProperty(globalThis, 'sessionStorage', countingStore);

  loads += 1;
  await import(`${pathToFileURL(join(SITE, 'faults.js')).href}?load=${loads}`);

  return { sent, touched, listeners, window };
}

/** Fire one event at the listeners the page registered. */
function fire(page, type, event) {
  for (const listener of page.listeners.get(type) || []) listener(event);
}

/** The JSON the page actually sent. */
async function payloadOf(entry) {
  if (entry.blob) return JSON.parse(await entry.blob.text());
  return JSON.parse(entry.init.body);
}

/** A realistic error event, with a real stack behind it. */
function errorEvent(message, stack, filename, lineno) {
  const error = new Error(message);
  if (stack) error.stack = stack;
  return { target: {}, message, error, filename, lineno, colno: 3 };
}

/* ------------------------------------------------------------------ *
 * part 1 · what the page sends
 * ------------------------------------------------------------------ */

test('the reporter sends exactly six fields, and no field about the reader', async () => {
  const page = await loadPage();
  fire(page, 'error', errorEvent('Uncaught TypeError: x is not a function', '', '/app.js', 12));

  assert.equal(page.sent.length, 1, 'one fault should have produced one report');
  assert.equal(
    page.sent[0].url,
    '/api/fault',
    'the report must go to this site, not to a monitoring service',
  );

  const payload = await payloadOf(page.sent[0]);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['column', 'line', 'message', 'route', 'source', 'stack'],
    'the payload grew a field, and every field here is one the reader was promised',
  );
});

test('no query string survives, so a question or a file name cannot ride along', async () => {
  const page = await loadPage();
  fire(
    page,
    'error',
    errorEvent(
      'boom while reading /api/document/abc?text=my+private+diary',
      'Error: boom\n    at step (/app.js?v=7:1614:11)',
      '/app.js?v=7&t=1',
      1614,
    ),
  );

  const payload = await payloadOf(page.sent[0]);
  const asText = JSON.stringify(payload);
  assert.equal(/[?&]/.test(asText), false, `a query survived into the payload: ${asText}`);
  assert.equal(payload.route, '/', 'the route is the path alone');
  assert.match(
    payload.stack + payload.source,
    /:1614:11/,
    'the line and column must survive the redaction — cutting at the ? silently costs the traceback',
  );
});

test('the file names one address, and it is this site', () => {
  const source = stripJs(read(SITE, 'faults.js'));
  const urls = source.match(/['"`][^'"`]*:\/\/[^'"`]*['"`]/g) || [];
  assert.deepEqual(urls, [], `the reporter names another origin: ${urls.join(', ')}`);
  assert.match(source, /\/api\/fault/, 'the endpoint must be a path on this site');
});

test('it never touches storage or a cookie', async () => {
  const page = await loadPage();
  fire(page, 'error', errorEvent('Uncaught TypeError: x is not a function', '', '/app.js', 12));

  assert.deepEqual(
    page.touched,
    { storage: 0, cookie: 0 },
    'the page promises the only cookie here is the analytics one, and a reporter that reads storage cannot keep that promise',
  );
});

test('a page failing in a loop stays one item, not a flood', async () => {
  const page = await loadPage();
  for (let i = 0; i < 6; i += 1) {
    fire(page, 'error', errorEvent(`Uncaught TypeError: failure number ${i}`, '', '/app.js', i + 1));
  }

  assert.equal(page.sent.length, 5, 'five distinct faults are reported, and the sixth tells us nothing new');

  const again = await loadPage();
  const same = 'Uncaught TypeError: the same failure';
  fire(again, 'error', errorEvent(same, '', '/app.js', 7));
  fire(again, 'error', errorEvent(same, '', '/app.js', 7));
  assert.equal(again.sent.length, 1, 'the same fault twice is one report — the cap counts distinct faults');
});

/* ------------------------------------------------------------------ *
 * part 2 · the failures nobody else can see
 * ------------------------------------------------------------------ */

test('a script that never loaded is caught, because it does not bubble', async () => {
  const page = await loadPage();
  const element = new globalThis.HTMLScriptElement();
  element.src = 'https://rag-demo.nodejavascript.com/missing.js';
  fire(page, 'error', { target: element });

  assert.equal(page.sent.length, 1, 'a load failure fires on the element, and only a capture listener sees it');
  const payload = await payloadOf(page.sent[0]);
  assert.match(payload.message, /did not load/);
  assert.equal(payload.source, '/missing.js', 'the script is named as a path on this site, with no origin');
});

test('a promise nobody caught is caught', async () => {
  const page = await loadPage();
  fire(page, 'unhandledrejection', { reason: new Error('the fetch never resolved') });

  assert.equal(page.sent.length, 1);
  const payload = await payloadOf(page.sent[0]);
  assert.match(payload.message, /the fetch never resolved/);
});

test('a catch can send what it caught, through the entry point on the window', async () => {
  const page = await loadPage();
  assert.equal(typeof page.window.ragFault, 'function', 'the page reaches it as window.ragFault');

  page.window.ragFault(new Error('the download failed'), 'downloading a sample');
  assert.equal(page.sent.length, 1);

  const payload = await payloadOf(page.sent[0]);
  assert.match(payload.message, /Failed while downloading a sample\. Error: the download failed/);
});

/* ------------------------------------------------------------------ *
 * part 3 · the census — a caught error is invisible unless the catch says so
 * ------------------------------------------------------------------ */

test('every catch in the page either reports the fault or says why it is not one', () => {
  for (const name of ['app.ts', 'consent.ts']) {
    // 🔴 THE RAW SOURCE, NOT THE STRIPPED SOURCE — AND THIS WAS A FALSE FAILURE ON THE
    // FIRST RUN. `stripJs` removes `//` comments, so it removed the very `// expected:`
    // markers this check looks for, and reported three catches as undecided when all
    // three said exactly why they are not faults. The stripping belongs on the built
    // reporter below, whose header discusses catches in prose; here the comments ARE
    // the evidence.
    const blocks = catchBlocks(read(SRC, name));

    assert.ok(
      blocks.length >= 3,
      `only ${blocks.length} catch blocks were found in ${name}, so this check is measuring nothing`,
    );

    const undecided = blocks.filter(
      (block) => !/ragFault\?\.\(/.test(block.body) && !/\/\/ expected:/.test(block.body),
    );

    assert.equal(
      undecided.length,
      0,
      `these catches swallow a caught error without saying whether it is a fault (${name}): ` +
        undecided.map((block) => `line ${block.at}`).join(' | '),
    );
  }
});

test('the reporter never sends a report from inside its own catch blocks', () => {
  const blocks = catchBlocks(stripJs(read(SITE, 'faults.js')));

  assert.ok(
    blocks.length >= 3,
    `only ${blocks.length} catches were found in the reporter, so this check is measuring nothing`,
  );

  const reporting = blocks.filter((block) => /ragFault/.test(block.body));
  assert.equal(
    reporting.length,
    0,
    'a reporter that reported its own failure would loop for ever: ' +
      reporting.map((block) => `line ${block.at}`).join(' | '),
  );
});

/* ------------------------------------------------------------------ *
 * part 4 · what the reader is told
 * ------------------------------------------------------------------ */

test('the panel carries the fault report as Required, and offers no switch for it', () => {
  const html = read(SITE, 'index.html');
  const start = html.indexOf('consentRowName">Fault report');
  assert.notEqual(start, -1, 'the panel has no fault report row, so the reader is not told');

  const rowStart = html.lastIndexOf('<li class="consentRow">', start);
  const rowEnd = html.indexOf('</li>', start);
  // 🔴 WHITESPACE IS NORMALISED, BECAUSE THE COPY IS WRAPPED IN THE SOURCE. Matching
  // a sentence against the file as written fails on the newline the formatter put in
  // the middle of it — a check disagreeing with the thing it checks, which is worse
  // than no check.
  const row = html.slice(rowStart, rowEnd).replace(/\s+/g, ' ');

  assert.match(row, /consentAlways/, 'the row must be a tag the reader can read');
  assert.equal(
    /<button|\brole="switch"/.test(row),
    false,
    'a switch here would be a control that does nothing: the report cannot be turned off without leaving a breakage invisible',
  );
  assert.match(
    row,
    /Reject all does not stop it/,
    'the panel must say plainly that the one button does not stop this',
  );
});

test('the privacy copy names Rollbar, because the reader is entitled to know where a report goes', () => {
  const html = read(SITE, 'index.html');
  const privacy = html.slice(html.indexOf('id="privacy"')).replace(/\s+/g, ' ');
  assert.match(privacy, /Rollbar/, 'the privacy section does not name the service the relay sends to');
  assert.match(privacy, /Reject all does not stop it/, 'the privacy copy must repeat the one exception');
});

test('the reporter is loaded before the script that can fail', () => {
  const html = read(SITE, 'index.html');
  const reporter = html.indexOf('./faults.js');
  const consent = html.indexOf('./consent.js');
  const app = html.indexOf('./app.js');
  assert.notEqual(reporter, -1, 'the page does not load the reporter at all');
  assert.ok(
    reporter < consent && reporter < app,
    'the reporter must exist on the window before anything that can fail starts running',
  );
});
