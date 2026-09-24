/**
 * Ad-hoc live check of the cookie gate. Not part of the suite — run by hand:
 *
 *   node tools/verify-live-consent.mjs
 *
 * The suite proves the gate against a LOCAL server. This proves it against the DEPLOYED
 * site, which is where the DNS, the TLS, the Caddy headers the cache purge and the
 * measurement id all have to be right at the same time — and where a Cloudflare cache can
 * serve a stale page that no local test would ever see.
 *
 * It is deliberately a script and not a test: it talks to a live host, so it should be
 * run when something changed, not on every commit.
 */
import { chromium } from 'playwright';

const URL = 'https://rag-demo.nodejavascript.com/';
const GOOGLE = /google-analytics\.com|googletagmanager\.com/;

const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
let failures = 0;

function check(label, ok, detail = '') {
  if (ok) {
    results.push(`  ok   ${label}`);
  } else {
    failures += 1;
    results.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A fresh visit, with every request to Google recorded. */
async function visit(label, { click, seed, ownerOff = false, query = '' } = {}) {
  // 🔴 THE OWNER'S OWN NETWORK IS SERVED A STUB `/consent.js` (the `no-ga-for-me` rule on
  // `dvs-sites`), and these live checks run from this machine — inside that range. Without this
  // header the banner never appears, so `#consentAccept` is never clickable and the LIVE gate
  // fails on a site that is correct. Measured 24 September 2026, twice in one day: first the
  // compliance check, then this. The header only un-suppresses a file every other visitor already
  // gets, and it cannot put analytics back on this network.
  const context = await browser.newContext({ extraHTTPHeaders: { 'X-Nodejs-Audit': '1' } });
  await context.addInitScript(
    ([consent, off]) => {
      try {
        if (consent) localStorage.setItem('analytics_consent', consent);
        if (off) localStorage.setItem('ga_opt_out', '1');
      } catch {
        /* storage off */
      }
    },
    [seed, ownerOff]
  );
  const page = await context.newPage();
  const google = [];
  page.on('request', (request) => {
    if (GOOGLE.test(request.url())) google.push(request.url());
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(URL + query, { waitUntil: 'load' });
  if (click) {
    await page.click(click);
    await page.waitForTimeout(1500);
  }

  const state = await page.evaluate(() => ({
    gtag: typeof window.gtag,
    ragTrack: typeof window.ragTrack,
    bar: !document.getElementById('consentBar').hidden,
    consent: localStorage.getItem('analytics_consent'),
    owner: localStorage.getItem('ga_opt_out'),
    reserved: Number.parseFloat(getComputedStyle(document.body).paddingBottom) || 0,
  }));
  await context.close();
  return { label, google, errors, ...state };
}

/* ---------------------------------------------------------------- *
 * The page as it arrives
 * ---------------------------------------------------------------- */

const page = await browser.newPage();
const response = await page.goto(URL, { waitUntil: 'domcontentloaded' });
const headers = response.headers();
const html = await page.content();

results.push(`\nThe page itself`);
check('responds 200', response.status() === 200, `got ${response.status()}`);
check('carries no Google tag in its own markup', !/googletagmanager|google-analytics/.test(html));
check(
  'loads no stylesheet or script from another origin',
  !/<(script|link)[^>]+(?:src|href)="https?:\/\//.test(html.replace(/rel="canonical"[^>]*/g, ''))
);
check(
  'is not served from the Cloudflare cache',
  /bypass/i.test(String(headers['cf-cache-status'] || '')) || /no-store/i.test(String(headers['cache-control'] || '')),
  `cf-cache-status: ${headers['cf-cache-status'] || '(absent)'}`
);

const consentJs = await page.goto(`${URL}consent.js`, { waitUntil: 'domcontentloaded' });
const consentBody = await consentJs.text();
check('serves the gate', consentJs.status() === 200 && /analytics_consent/.test(consentBody));
check('the gate carries no measurement id of its own', !/G-[A-Z0-9]{6,}/.test(consentBody));

const tag = html.match(/data-ga-id="([^"]+)"/);
check('declares a measurement id for the gate to find', Boolean(tag), tag ? tag[1] : 'none found');
results.push(`       measurement id: ${tag ? tag[1] : '(none)'}`);

/* ---------------------------------------------------------------- *
 * The gate, behaved
 * ---------------------------------------------------------------- */

const fresh = await visit('a visit that has not answered');
results.push(`\nA visit that has not answered`);
check('contacts nobody', fresh.google.length === 0, fresh.google.join(', '));
check('has no gtag', fresh.gtag === 'undefined');
check('has no way for the page to send', fresh.ragTrack === 'undefined');
check('shows the question', fresh.bar === true);
check('reserves room for the bar', fresh.reserved > 0, `${fresh.reserved}px`);

const accepted = await visit('accepted', { click: '#consentAccept' });
results.push(`\nAccepting`);
check('remembers the answer', accepted.consent === 'granted', String(accepted.consent));
check('loads the tag', accepted.google.some((url) => url.includes('/gtag/js')), accepted.google.join(', '));
check('loads it exactly once', accepted.google.filter((url) => url.includes('/gtag/js')).length === 1);
check('gives the page a way to send', accepted.ragTrack === 'function');
check('closes the bar', accepted.bar === false);

const rejected = await visit('rejected', { click: '#consentDecline' });
results.push(`\nRejecting`);
check('remembers the answer', rejected.consent === 'denied', String(rejected.consent));
check('contacts nobody', rejected.google.length === 0, rejected.google.join(', '));
check('has no gtag', rejected.gtag === 'undefined');
check('does not nag on the next visit', (await visit('second visit', { seed: 'denied' })).bar === false);

const granted = await visit('granted but opted out', { seed: 'granted', ownerOff: true });
results.push(`\nThe owner's own switch`);
check('beats a granted answer', granted.google.length === 0, granted.google.join(', '));
check('is shown as a way back', granted.owner === '1');
// ⚠️ `ownerOff` must be set HERE too. The first version of this check passed `?ga=on` on
// a context that had never set the flag, so it proved nothing — a passing check that
// cannot fail is worse than no check, because it is counted.
const cleared = await visit('?ga=on', { seed: 'granted', ownerOff: true, query: '?ga=on' });
check('?ga=on clears it', cleared.owner === null, `ga_opt_out is ${cleared.owner}`);
check('and counting starts again', cleared.ragTrack === 'function');

/* ---------------------------------------------------------------- *
 * The footer
 * ---------------------------------------------------------------- */

results.push(`\nThe footer`);
// Back to the page, since it was navigated away to fetch the gate.
await page.goto(URL, { waitUntil: 'domcontentloaded' });
const link = await page.evaluate(() => {
  const a = document.querySelector('footer a[href="https://nodejavascript.com/"]');
  if (!a) return null;
  const html = document.documentElement;
  const was = html.style.scrollBehavior;
  html.style.scrollBehavior = 'auto';
  a.scrollIntoView({ block: 'center' });
  html.style.scrollBehavior = was;
  const box = a.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return { text: a.textContent.trim(), covered: !(hit === a || a.contains(hit)) };
});
check('links to the domain', link !== null, 'no link found');
if (link) {
  check('names it correctly', link.text === 'nodejavascript.com', link.text);
  check('is not covered by the cookie bar', link.covered === false);
}

const errors = [...fresh.errors, ...accepted.errors, ...rejected.errors];
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();

console.log(`\nLive cookie-gate check — ${URL}`);
console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
