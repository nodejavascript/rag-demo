/**
 * The relay, checked where it can be checked without a network call.
 *
 * 🔴 WHY THIS FILE EXISTS. `src/rollbar.ts` is the only place this app talks to
 * Rollbar, and everything it gets wrong is wrong quietly: the endpoint answers 204
 * whether the item was accepted, refused, or sent with a token that cannot carry it.
 * So the things that must never be wrong are asserted here against the built file,
 * with the network stubbed:
 *
 *   1. **the frames are the right way up.** V8 prints the most recent call first and
 *      Rollbar wants it LAST. Get that wrong and the traceback reads upside down in
 *      the UI, which is worse than no traceback because it looks deliberate.
 *   2. **no query string survives, and the line:column does.** Cutting at the `?`
 *      threw away the only coordinates a frame has, so the frame was dropped and the
 *      traceback arrived a line shorter — redaction silently costing a traceback.
 *   3. **nothing about the reader travels** — no person, no address, no user agent,
 *      no referrer, and no field the page did not send.
 *   4. **the right token for the right item.** A browser item sent with the server
 *      token is refused 403 and the fault is lost with no symptom; that is measured
 *      on the reference implementation, and it is why the relay holds both.
 *   5. **a refusal is read, not guessed.** An account that cannot receive anything
 *      answers 429 with a rate-limit header that reads "49,998 remaining", so the
 *      body is the only thing that says what happened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBrowserItem,
  buildItem,
  cleanBrowserFault,
  forgetTokens,
  forgetWarnings,
  framesFromStack,
  postItem,
  redactText,
  reportBrowserFault,
  reportError,
  token,
  withoutQuery,
} from '../dist/rollbar.js';

/** Capture what the relay would have sent, and answer like Rollbar. */
function stubFetch(response = { ok: true, status: 200, body: '' }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body,
    };
  };
  return calls;
}

/** Let the fire-and-forget path finish before asserting on it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Capture console.warn, so a warning is asserted rather than eyeballed. */
function captureWarn(run) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    run();
  } finally {
    console.warn = original;
  }
  return lines;
}

const ENV = { ROLLBAR_SERVER_TOKEN: 'server-token-for-tests', ROLLBAR_PAGE_TOKEN: 'page-token-for-tests' };

test.beforeEach(() => {
  forgetTokens();
  forgetWarnings();
  delete process.env.ROLLBAR_SERVER_TOKEN;
  delete process.env.ROLLBAR_PAGE_TOKEN;
});

/* ------------------------------------------------------------------ *
 * part 1 · the frames
 * ------------------------------------------------------------------ */

test('a stack becomes frames, with the most recent call LAST', () => {
  const stack = [
    'Error: boom',
    '    at step (server.js:1614:11)',
    '    at async handle (server.js:60:12)',
    '    at server.js:120:9',
    'not a frame at all',
  ].join('\n');

  const frames = framesFromStack(stack);

  assert.deepEqual(
    frames,
    [
      { filename: 'server.js', lineno: 120, colno: 9, method: '' },
      { filename: 'server.js', lineno: 60, colno: 12, method: 'handle' },
      { filename: 'server.js', lineno: 1614, colno: 11, method: 'step' },
    ],
    'V8 prints the most recent call first, and Rollbar wants it last',
  );
  assert.deepEqual(framesFromStack('a thrown string'), [], 'no stack means no frames, not a guess');
});

/* ------------------------------------------------------------------ *
 * part 2 · the redaction
 * ------------------------------------------------------------------ */

test('a query is dropped and the coordinates are kept', () => {
  assert.equal(withoutQuery('https://host/app.js?v=7:1614:11'), 'https://host/app.js:1614:11');
  assert.equal(withoutQuery('/api/ask?q=my+private+question'), '/api/ask');
  assert.equal(withoutQuery('/api/ask#notes'), '/api/ask');
  assert.equal(
    withoutQuery('https://host/app.js?v=7'),
    'https://host/app.js',
    'a query with no coordinates leaves nothing behind',
  );
});

test('redaction keeps the newlines, because the newlines are the traceback', () => {
  const text = redactText('boom at https://x.test/a.js?v=9 and /api/ask?q=secret', 400);
  assert.equal(text.includes('?'), false, 'no query survives');
  assert.match(text, /https:\/\/x\.test\/a\.js/, 'the address itself is kept');
  assert.match(text, /\/api\/ask/, 'the path itself is kept');

  const stack = redactText('Error: e\n    at a (x.js:1:1)\n    at b (x.js:2:2)', 400);
  assert.equal(stack.split('\n').length, 3, 'flattening the stack would leave no frames to parse');
});

/* ------------------------------------------------------------------ *
 * part 3 · what a page fault may keep
 * ------------------------------------------------------------------ */

test('a page fault keeps exactly six fields and forgets everything else', () => {
  const fault = cleanBrowserFault({
    route: '/ask?q=my+private+question',
    message: 'boom',
    stack: 'Error: boom\n    at a (x.js:1:1)',
    source: '/app.js?v=7',
    line: 1.6,
    column: 2,
    user_ip: '1.2.3.4',
    person: { id: 'nobody' },
    cookie: 'ga_opt_out=1',
    browser: 'Some/1.0',
  });

  assert.deepEqual(Object.keys(fault).sort(), ['column', 'line', 'message', 'route', 'source', 'stack']);
  assert.equal(fault.route, '/ask');
  assert.equal(fault.line, 2, 'a fractional line is rounded, not trusted');
  assert.equal(JSON.stringify(fault).includes('1.2.3.4'), false, 'an address must not be kept');
});

test('a fault that is not a fault is refused rather than stored', () => {
  assert.equal(cleanBrowserFault({ message: '' }), null, 'an empty POST is not an item');
  assert.equal(cleanBrowserFault({ message: '   ' }), null);
  assert.equal(cleanBrowserFault([]), null);
  assert.equal(cleanBrowserFault('a string'), null);
  assert.equal(cleanBrowserFault(null), null);
  assert.equal(cleanBrowserFault(undefined), null);
  assert.equal(
    cleanBrowserFault({ message: 'x', route: 'https://somewhere.else/p' }).route,
    '/',
    'a route that is not a path on this site is filed under / rather than trusted',
  );
});

test('the item for a page fault points at the page the reader was on', () => {
  const fault = cleanBrowserFault({ message: 'boom', route: '/ask', source: '/app.js', line: 3, column: 4 });
  const item = buildBrowserItem(fault, {}, { origin: 'https://rag-demo.nodejavascript.com' });

  assert.equal(item.platform, 'browser', 'so a fault on a reader machine is told apart from one in the server');
  assert.equal(item.request.url, 'https://rag-demo.nodejavascript.com/ask');
  assert.equal(item.custom.reported_by, 'page');

  const asText = JSON.stringify(item);
  assert.equal(/person|user_ip|user_agent|cookie/.test(asText), false, `the item grew a field about the reader: ${asText}`);
  assert.equal(/[?]/.test(asText), false, 'no query string anywhere in the item');
});

test('a stack that does not parse still yields one frame from the script and line', () => {
  const fault = cleanBrowserFault({ message: 'boom', source: '/app.js', line: 42, column: 7 });
  const item = buildBrowserItem(fault, {}, {});

  assert.deepEqual(item.body.trace.frames, [
    { filename: '/app.js', lineno: 42, colno: 7, method: '' },
  ]);
});

test('a server fault is named for what it actually is', () => {
  const item = buildItem('a bare string', { route: '/api/ask', method: 'POST' }, {});

  assert.equal(item.platform, 'node');
  assert.equal(item.context, '/api/ask', 'the route is what makes which path is failing answerable');
  assert.equal(item.body.message.body, 'Non-error thrown: a bare string');
  assert.equal(item.custom.reported_by, 'server');
});

/* ------------------------------------------------------------------ *
 * part 4 · the two tokens
 * ------------------------------------------------------------------ */

test('a browser item goes with the page token and a server item with the server token', async () => {
  const calls = stubFetch();

  await postItem(buildBrowserItem(cleanBrowserFault({ message: 'boom' }), ENV, {}), ENV);
  await postItem(buildItem(new Error('boom'), { route: '/api/ask' }, ENV), ENV);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['x-rollbar-access-token'], ENV.ROLLBAR_PAGE_TOKEN);
  assert.equal(calls[1].headers['x-rollbar-access-token'], ENV.ROLLBAR_SERVER_TOKEN);
  assert.equal(calls[0].url, 'https://api.rollbar.com/api/1/item/');
  assert.equal(calls[0].body.data.platform, 'browser');
});

test('a token can come from a file, so it never has to be an environment variable', () => {
  // The app's own convention, and the reason the deploy mounts files: a value in the
  // environment is visible to anything that can inspect the container.
  const env = { ROLLBAR_SERVER_TOKEN_FILE: '/nonexistent/rollbar-server' };
  assert.equal(token('server', env), null, 'a file that is not there is not a token');
  assert.equal(
    token('server', { ROLLBAR_SERVER_TOKEN: '  inline  ' }),
    'inline',
    'an inline value is trimmed rather than sent with its whitespace',
  );
});

/* ------------------------------------------------------------------ *
 * part 5 · the failures that are silent by default
 * ------------------------------------------------------------------ */

test('with no token nothing is sent, and the operator is told exactly once', async () => {
  const calls = stubFetch();

  const lines = captureWarn(() => {
    reportError(new Error('boom'), { route: '/api/ask' }, {});
    reportError(new Error('boom again'), { route: '/api/ask' }, {});
    reportBrowserFault({ message: 'page boom' }, {}, {});
    reportBrowserFault({ message: 'page boom again' }, {}, {});
  });
  await settle();

  assert.equal(calls.length, 0, 'nothing configured must mean no request at all');
  assert.equal(lines.length, 2, `one line per missing token, not one per fault: ${lines.join(' / ')}`);
  assert.match(lines[0], /ROLLBAR_SERVER_TOKEN is not set/);
  assert.match(lines[1], /ROLLBAR_PAGE_TOKEN is not set/);
});

test('a refusal is read out of the body, because the status alone lies', async () => {
  stubFetch({
    ok: false,
    status: 429,
    body: '{"err":1,"message":"This account has been deactivated. To reactivate it, log in to Rollbar and choose a plan."}',
  });

  // 🔴 THE SPY HAS TO STAY INSTALLED UNTIL THE POST RESOLVES, AND THE FIRST VERSION OF
  // THIS TEST DID NOT — it captured `console.warn` around the call only, and the refusal
  // is logged after the response arrives, so the spy was already gone and the test read
  // "no warning" from a warning that had been written. A false failure in the instrument,
  // which is the same class of mistake as a false pass.
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));

  let ok;
  try {
    ok = await postItem(buildItem(new Error('boom'), {}, ENV), ENV);
  } finally {
    console.warn = original;
  }

  assert.equal(ok, false, 'a refused item is not an accepted one');
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /has been deactivated/,
    'reading the body is what separates a deactivated account from a real rate limit',
  );
});

test('a refused page fault is still cleaned and returned, so the route can log it', () => {
  const fault = reportBrowserFault({ message: 'boom', route: '/ask' }, {}, {});
  assert.equal(fault.message, 'boom', 'the route logs a refusal, and it can only do that if it is returned');
  assert.equal(reportBrowserFault({ message: '' }, {}, {}), null, 'nothing worth reporting returns nothing');
});
