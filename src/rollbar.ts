/**
 * rollbar.ts — every place this app talks to Rollbar, and the only one.
 *
 * 🔴 WHY THIS IS HAND-WRITTEN AND NOT THE ROLLBAR SDK. `rollbar` (npm) is a
 * Node/browser package that reaches for a queueing agent, a global uncaught
 * handler, and a configuration object of its own. This app needs exactly one
 * thing from Rollbar — `POST https://api.rollbar.com/api/1/item/` with a small
 * documented payload — and hand-writing it means the whole notifier is the file
 * you are reading, which is also why a test can assert the payload and the token
 * choice without a network call.
 *
 * 🔴 THE REPORTER MUST NEVER BECOME THE INCIDENT. Every function here is written
 * so that it cannot throw, cannot hang, and cannot take a response down with it:
 * a missing token is a silent no-op, a refused or timed-out POST returns `false`,
 * and the caller fires this file's work without awaiting it so the reader's
 * answer is sent first. A fault reporter that takes the site down is worse than no
 * fault reporter.
 *
 * 🔴 THE FRAMES ARE REVERSED, AND THAT IS NOT A STYLE CHOICE — from Rollbar's own
 * create-item reference: `body.trace.frames` is *"a list of stack frames, ordered
 * such that the most recent call is last in the list"*. V8 prints a stack with the
 * most recent call FIRST, so the parsed lines are reversed here. Get this wrong and
 * the traceback reads upside down in the UI, which is worse than no traceback
 * because it looks deliberate.
 *
 * 🔴 WHICH TOKEN, AND WHY THE TWO ARE NOT INTERCHANGEABLE — measured on the
 * reference implementation, 23 September 2026. Rollbar refuses a browser item sent
 * with the server token, in so many words: *"insufficient privileges:
 * post_client_item scope is required but the access token only has
 * post_server_item."* It is a rule about the ITEM, not the caller. The relay exists
 * so that no key sits in the page, so the client token is held HERE, beside the
 * server one — cheap, because a client token is public by design. What it must
 * never be is MISSING: the endpoint answers 204 either way, so a browser fault sent
 * with the only token on hand is refused with a 403 nobody reads.
 *
 * WHAT IS DELIBERATELY NOT SENT, and why it is a rule rather than an oversight:
 *
 *   - **No `person`, ever.** This site has no accounts, so there is nobody to
 *     identify, and inventing an id would be worse than sending none.
 *   - **No `user_ip`.** Rollbar will not attach one unless it is asked to, and it
 *     is not asked. Somebody reading their own document is not the subject of a
 *     fault report.
 *   - **No query string, anywhere.** The query is where a visitor's own question
 *     lives, and the report must never carry a word they typed.
 *   - **No user agent, no referrer, no client address.** None is added, here or
 *     later. Two things that are infrastructure rather than identity — the
 *     request id and the site origin — are the whole of what travels.
 */
import { readFileSync } from 'node:fs';

/** Where an item goes. One endpoint, documented at docs.rollbar.com/reference/create-item. */
const ENDPOINT = 'https://api.rollbar.com/api/1/item/';

/** A report is worth less than the answer it delays, so it gets a short leash. */
const TIMEOUT_MS = 5_000;

/** Longest stack we will keep in `custom` when the frames themselves do not parse. */
const RAW_STACK_LIMIT = 4_000;

/** The site this app serves, used for the `request.url` field of a page fault. */
const SITE_ORIGIN = 'https://rag-demo.nodejavascript.com';

export interface RollbarFrame {
  filename: string;
  lineno: number;
  colno: number;
  method: string;
}

export type RollbarEnv = Record<string, string | undefined>;

export interface ItemContext {
  route?: string | undefined;
  origin?: string | undefined;
  method?: string | undefined;
  requestId?: string | undefined;
}

export interface BrowserMeta {
  origin?: string | undefined;
  requestId?: string | undefined;
}

/** The six fields a page fault keeps, and nothing else. */
export interface CleanFault {
  route: string;
  message: string;
  stack: string;
  source: string;
  line: number;
  column: number;
}

/* ------------------------------------------------------------------------- *
 * THE TOKENS — read from a variable, or from a file
 * ------------------------------------------------------------------------- */

/**
 * A token is read from `ROLLBAR_SERVER_TOKEN` / `ROLLBAR_PAGE_TOKEN`, or from the
 * file named by the matching `*_FILE` variable.
 *
 * 🔴 THE FILE FORM IS NOT A CONVENIENCE — IT IS THIS APP'S OWN CONVENTION.
 * The model key on this host is a file mounted read-only into the container, and
 * deliberately not an environment variable: an environment variable is visible to
 * anything that can read the process list or `docker inspect`, and it is copied
 * into every child process. Keeping the Rollbar tokens in the same shape means one
 * place to look and one way to rotate them.
 *
 * The value is never logged, never returned by an endpoint, and never written
 * anywhere by this file.
 */
const tokenCache = new Map<string, string | null>();

function readTokenFile(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

export function token(
  kind: 'server' | 'page',
  env: RollbarEnv = process.env,
): string | null {
  const name = kind === 'server' ? 'ROLLBAR_SERVER_TOKEN' : 'ROLLBAR_PAGE_TOKEN';
  const fileVar = `${name}_FILE`;
  const cacheKey = `${name}:${env[name] ?? ''}:${env[fileVar] ?? ''}`;
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const inline = env[name];
  const value =
    inline !== undefined && inline.trim() !== ''
      ? inline.trim()
      : ((env[fileVar] !== undefined && env[fileVar] !== ''
          ? readTokenFile(env[fileVar])
          : null) ?? null);

  tokenCache.set(cacheKey, value);
  return value;
}

/** Forget the cached tokens. A test's business, and a rotation's. */
export function forgetTokens(): void {
  tokenCache.clear();
}

/**
 * 🔴 A MISSING TOKEN IS SAID OUT LOUD, ONCE.
 *
 * This is the one place this file goes beyond the reference implementation, and the
 * reason is the shape of the failure it prevents. A fault report dropped because
 * nothing is configured leaves **exactly the same trace as a page that never broke** —
 * no item, no error, no symptom — so a deployment that forgot to mount the token looks
 * identical to a healthy site, for ever. One line in the log is the difference between
 * "nobody has hit a fault" and "the reporter is not connected".
 *
 * It warns ONCE PER PROCESS, keyed by what is missing, because the alternative is a
 * warning per fault and a fault can fire in a loop: a log that shouts is a log nobody
 * reads, which is the same as silence.
 */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Forget the warning flags. A test's business. */
export function forgetWarnings(): void {
  warned.clear();
}

/* ------------------------------------------------------------------------- *
 * BUILDING AN ITEM
 * ------------------------------------------------------------------------- */

/**
 * Turn a V8 stack string into Rollbar frames, ordered most-recent-call LAST.
 *
 * Handles the three shapes V8 prints:
 *   `    at handle (server.js:120:9)`      — named function
 *   `    at async Object.fetch (server.js:60:12)`
 *   `    at server.js:120:9`               — anonymous frame
 * Anything else — the `Error: message` first line, blank lines — is skipped. A
 * frame that cannot be parsed is dropped rather than guessed at.
 */
export function framesFromStack(stack: unknown): RollbarFrame[] {
  if (typeof stack !== 'string' || stack.length === 0) return [];

  const frames: RollbarFrame[] = [];
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;

    let rest = trimmed.slice(3).trim();
    if (rest.startsWith('async ')) rest = rest.slice(6).trim();

    // `fn (file:line:col)` when the frame is named, `file:line:col` when it is not.
    let method = '';
    let location = rest;
    const open = rest.lastIndexOf(' (');
    if (open !== -1 && rest.endsWith(')')) {
      method = rest.slice(0, open).trim();
      location = rest.slice(open + 2, -1);
    }

    // Split from the right: a filename may contain colons, but the line and the
    // column are always the last two fields.
    const parts = location.split(':');
    if (parts.length < 3) continue;
    const colno = Number(parts.pop());
    const lineno = Number(parts.pop());
    const filename = parts.join(':');
    if (!Number.isFinite(lineno) || !Number.isFinite(colno)) continue;

    frames.push({ filename, lineno, colno, method });
  }

  // V8 lists the most recent call first; Rollbar wants it last.
  return frames.reverse();
}

/** A string that is safe to put in Rollbar's `custom` object. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, 255);
}

/**
 * A URL reduced to its address: no query, no hash — AND THE COORDINATES ON THE END
 * KEPT.
 *
 * 🔴 WHY THE TAIL IS RE-ATTACHED, MEASURED ON THE REFERENCE, 23 September 2026. A
 * V8 frame is `fn (url:line:column)`, and when a script was loaded with a
 * cache-busting query the frame reads `fn (https://host/app.js?v=7:1614:11)` —
 * **the line and the column come AFTER the query.** Cutting at the `?` therefore
 * threw away the only coordinates the frame had, `framesFromStack` could not parse
 * it, and the frame was dropped: redaction was silently costing a traceback.
 *
 * The tail is re-attached only when it is EXACTLY two integers, so nothing from the
 * query can ride along. It is a shape test, not a guess.
 */
export function withoutQuery(token: string): string {
  const cut = token.search(/[?#]/);
  if (cut === -1) return token;
  const tail = /(:\d+:\d+)$/.exec(token.slice(cut));
  return token.slice(0, cut) + (tail ? tail[1] : '');
}

/**
 * Redact every URL-shaped run in a line of text, then cap it.
 *
 * 🔴 THIS RUNS ON THE SERVER EVEN THOUGH THE PAGE ALREADY DID IT. The page's copy
 * of this rule stops a query string leaving the reader's machine; this one is what
 * makes the promise true if the page's copy is ever wrong, bypassed, or replaced by
 * a request from somewhere else. Redaction that only happens on the client is a
 * redaction the client can decline to perform.
 *
 * 🔴 HORIZONTAL WHITESPACE ONLY, BECAUSE THE NEWLINES *ARE* THE TRACEBACK. The
 * reference collapsed `\s+` here, which flattened every stack into one sentence, so
 * no frames parsed and every browser fault arrived with its traceback replaced by a
 * single unreadable line.
 */
export function redactText(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : '';
  if (text === '') return '';
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)"']+/gi, withoutQuery)
    .replace(/(^|[\s("'=])(\/[^\s)"']*)/g, (_whole, lead: string, path: string) => lead + withoutQuery(path))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

/** What a page fault may keep. Six fields, and each one capped. */
const FAULT_LIMITS = { route: 200, message: 300, stack: 4_000, source: 300 };

/**
 * Turn whatever arrived into the six fields, or `null` when there is nothing worth
 * reporting.
 *
 * A fault with no message is not a fault — it is an empty POST, a probe, or a
 * mistake — so it is refused rather than stored as an item with a blank body that
 * would sit in the item list for ever looking like a real one.
 */
export function cleanBrowserFault(raw: unknown): CleanFault | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const message = redactText(input['message'], FAULT_LIMITS.message);
  if (message === '') return null;

  const route = redactText(input['route'], FAULT_LIMITS.route);
  const whole = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };

  return {
    // The page path alone. A report with no path, or one that is not a path on this
    // site, is filed under `/` rather than under whatever was sent.
    route: route.startsWith('/') ? route : '/',
    message,
    stack: redactText(input['stack'], FAULT_LIMITS.stack),
    source: redactText(input['source'], FAULT_LIMITS.source),
    line: whole(input['line']),
    column: whole(input['column']),
  };
}

/** The `data` object for one fault this server caught. Exported so a test can read it. */
export function buildItem(
  error: unknown,
  context: ItemContext = {},
  env: RollbarEnv = process.env,
): Record<string, unknown> {
  const isError = error instanceof Error;
  // A thrown string is not an Error and carries no stack, but it still needs a name
  // to group under — so the class says what it actually is rather than pretending to
  // be one. `Error: Non-error thrown: …` would read as a mistake.
  const name = isError ? error.name || 'Error' : 'Non-error thrown';
  const message = isError ? error.message || '(no message)' : String(error);
  const stack = isError ? error.stack ?? '' : '';

  const frames = framesFromStack(stack);
  const body = frames.length
    ? { trace: { frames, exception: { class: name, message } } }
    : { message: { body: `${name}: ${message}` } };

  const version = env['ROLLBAR_CODE_VERSION'];

  return {
    // `production` and `development` need no configuration in Rollbar; a new name is
    // detected automatically. Set ROLLBAR_ENVIRONMENT to override.
    environment: asText(env['ROLLBAR_ENVIRONMENT']) || 'production',
    level: 'error',
    platform: 'node',
    language: 'javascript',
    framework: 'node',
    timestamp: Math.floor(Date.now() / 1000),
    // The route, not the URL: Rollbar indexes `context`, and this is what makes
    // "which path is failing" a question the item list can answer.
    context: asText(context.route),
    body,
    request: {
      url: asText(context.origin && context.route ? context.origin + context.route : ''),
      method: asText(context.method),
    },
    server: {
      host: 'rag-demo',
      branch: 'master',
      ...(version ? { code_version: asText(version) } : {}),
    },
    custom: {
      reported_by: 'server',
      route: asText(context.route),
      request_id: asText(context.requestId),
      // When the frames did not parse — a thrown string, a stripped stack — the raw
      // text is the only traceback there is, so it is kept as text.
      ...(frames.length ? {} : { stack: String(stack).slice(0, RAW_STACK_LIMIT) }),
    },
    notifier: { name: 'rag-demo', version: '0.1.0' },
  };
}

/**
 * The item for a fault the page reported.
 *
 * Same rules as the server's own items, and three that only apply here:
 *
 *   - `platform` is `browser`, so a fault on a reader's machine and a fault in this
 *     server are told apart in the item list without reading the body.
 *   - `request.url` is built from **the page path the reader was on**, never from
 *     this POST's own URL. The alternative — reporting `/api/fault` as the URL of
 *     every page fault — would make the one field a reader looks at useless.
 *   - Nothing is taken from a request header. There is no user agent, no referrer
 *     and no address, and none is added later.
 */
export function buildBrowserItem(
  fault: CleanFault,
  env: RollbarEnv = process.env,
  meta: BrowserMeta = {},
): Record<string, unknown> {
  const frames = framesFromStack(fault.stack);
  // The stack is the traceback when it parses. When it does not, the script and the
  // line are the only location there is, and one frame stating it beats none.
  if (frames.length === 0 && fault.source) {
    frames.push({ filename: fault.source, lineno: fault.line, colno: fault.column, method: '' });
  }

  const body = frames.length
    ? { trace: { frames, exception: { class: 'PageError', message: fault.message } } }
    : { message: { body: fault.message } };

  const version = env['ROLLBAR_CODE_VERSION'];
  const origin = meta.origin && meta.origin !== '' ? meta.origin : SITE_ORIGIN;

  return {
    environment: asText(env['ROLLBAR_ENVIRONMENT']) || 'production',
    level: 'error',
    platform: 'browser',
    language: 'javascript',
    timestamp: Math.floor(Date.now() / 1000),
    context: asText(fault.route),
    body,
    request: { url: asText(origin + fault.route) },
    server: {
      host: 'rag-demo',
      branch: 'master',
      ...(version ? { code_version: asText(version) } : {}),
    },
    custom: {
      // What separates the two reporters in the UI, so "is this the page or the
      // server" is a question the item list answers.
      reported_by: 'page',
      route: asText(fault.route),
      request_id: asText(meta.requestId),
      ...(frames.length ? {} : { stack: fault.stack }),
    },
    notifier: { name: 'rag-demo-page', version: '0.1.0' },
  };
}

/* ------------------------------------------------------------------------- *
 * SENDING
 * ------------------------------------------------------------------------- */

/**
 * Send one item. The only place in this app that talks to Rollbar.
 *
 * It resolves `true` when Rollbar accepted the item and `false` for every other
 * outcome — no token, the wrong token, a network failure, a timeout, a refused
 * payload. It never rejects, so a caller may fire it without holding the promise,
 * and it never logs the token.
 */
export async function postItem(
  item: Record<string, unknown>,
  env: RollbarEnv = process.env,
): Promise<boolean> {
  const browser = item['platform'] === 'browser';
  const name = browser ? 'ROLLBAR_PAGE_TOKEN' : 'ROLLBAR_SERVER_TOKEN';
  const value = token(browser ? 'page' : 'server', env);

  // Not configured is not an error the reader should meet. A local run with no
  // token set must behave exactly as the site did before Rollbar existed — but it IS
  // said out loud here, because "no token" and "the wrong token" are different
  // faults and the second one is otherwise invisible.
  if (!value) {
    console.warn(`rollbar: nothing sent — ${name} is not set for a ${String(item['platform'])} item`);
    return false;
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rollbar-access-token': value },
      body: JSON.stringify({ data: item }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // 🔴 READ THE BODY, BECAUSE THE STATUS ALONE LIES HERE. Measured on the
      // reference: an account not in a state to receive anything answers **429** —
      // the same code as a genuine rate limit — while its rate-limit headers read
      // 49,998 of 50,000 remaining, and the body says *"This account has been
      // deactivated."* A log line reading "rejected with 429" sends the next reader
      // hunting a rate limit that is not there.
      //
      // It stays a log line and nothing more: a report that cannot be delivered must
      // never change what the visitor receives.
      const detail = await response.text().catch(() => '');
      console.warn(
        `rollbar: item rejected (${response.status}) ${detail.replace(/\s+/g, ' ').slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Report one error this server caught, without delaying anything.
 *
 * 🔴 THIS IS FIRE-AND-FORGET ON PURPOSE. There is no `ctx.waitUntil` here — that is
 * a runtime this app does not have — so the promise is dropped with an explicit
 * catch: a report that cannot be delivered must not become an unhandled rejection
 * that takes the process down. The reader's response has already been written by the
 * time this runs.
 */
export function reportError(
  error: unknown,
  context: ItemContext = {},
  env: RollbarEnv = process.env,
): void {
  // Nothing configured is not a promise to hold: no token means no request is made
  // at all, exactly as the site behaved before Rollbar existed — and the operator is
  // told once, because a dropped report and a page that never broke look the same.
  if (!token('server', env)) {
    warnOnce(
      'server',
      'rollbar: server faults are being DROPPED — ROLLBAR_SERVER_TOKEN is not set',
    );
    return;
  }
  void postItem(buildItem(error, context, env), env).catch(() => {});
}

/**
 * Clean, build and send one fault the page reported.
 *
 * Returns the cleaned fault when it was accepted for reporting, or `null` when it
 * was refused before any request was made — which is what a test wants to see, and
 * what makes "nothing was sent" distinguishable from "something was sent and
 * failed". It never throws.
 */
export function reportBrowserFault(
  raw: unknown,
  meta: BrowserMeta = {},
  env: RollbarEnv = process.env,
): CleanFault | null {
  const fault = cleanBrowserFault(raw);
  if (!fault) return null;

  // 🔴 THE PAGE TOKEN, NOT THE SERVER TOKEN — see the header. With the server token
  // this call is refused 403 and the fault is lost with no symptom, so an absent page
  // token means nothing is sent rather than something that cannot be delivered. The
  // operator is told once, for the reason in `warnOnce`.
  if (!token('page', env)) {
    warnOnce(
      'page',
      'rollbar: page faults are being DROPPED — ROLLBAR_PAGE_TOKEN is not set',
    );
    return fault;
  }

  void postItem(buildBrowserItem(fault, env, meta), env).catch(() => {});
  return fault;
}
