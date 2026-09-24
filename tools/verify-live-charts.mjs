/**
 * Does the DEPLOYED page actually draw its charts, without throwing?
 *
 *   node tools/verify-live-charts.mjs
 *
 * 🔴 WHY THIS EXISTS — a fault that every test in this repo was blind to, found on the live page on
 * 22 September 2026 by looking at it: a colour helper returned `rgb(…)` and was then fed back into
 * itself as if it were hex, so the canvas gradient was built from `rgb(NaN, NaN, 62)` and threw
 * *"The value provided … could not be parsed as a color."* **The exception came out of the
 * composition renderer, which runs first, so ONE bad colour hid the composition chart, the heat map
 * and the new index-stage chart at the same time** — and nothing said so. The page simply showed
 * less.
 *
 * `npm test` could not catch it (it never runs a browser), and `npm run test:e2e` could not either
 * from this machine: the browser suite skips every test that needs a model, and indexing needs one —
 * the key lives on the droplet. **So the check has to run against the deployed site, where a model
 * is reachable.** It pastes its own small document, indexes it, and then insists on three things a
 * screenshot review would otherwise have to notice by eye:
 *
 *   1. **no page errors at all** — one throw during a render leaves the step half-drawn and silent;
 *   2. **every visible canvas is drawn at the size it is shown** — `bitmap / box === devicePixelRatio`,
 *      the rule from site-standard part 6a, which is how a stretched chart is caught;
 *   3. **every chart box that should be up IS up** — the three on step 2, including the one for
 *      how the document was indexed, and its caption carries the measured seconds.
 *
 * It is deliberately a script and not a test: it talks to a live host and spends one model call, so
 * it belongs at deploy time (`tools/deploy.sh` runs it) rather than on every commit.
 */
import { chromium } from 'playwright';

const URL = 'https://rag-demo.nodejavascript.com/';

/**
 * Long enough to clear the 200-character floor, structured enough to make all three charts draw.
 *
 * ⚠ **THE BLANK LINE UNDER EACH DATE IS NOT DECORATION.** The splitter needs a date on its own line
 * with a break after it before the prose starts; the first version of this fixture ran the date
 * straight into the paragraph, the whole document was read as **one entry and one note**, and the
 * heat map and the composition chart therefore had almost nothing to draw while every check still
 * passed. The entry count is asserted below so a fixture that stops exercising the charts cannot
 * pass silently.
 */
const DOCUMENT = [
  'Workshop notes, kept as I went.',
  '',
  '12 January 2024',
  '',
  'Cold morning in Hamilton. Sam brought the ledger: 48 boxes, and a shortfall of $1,240 against',
  'the December order. Rita said the Windsor depot had the same problem.',
  '',
  '3 February 2024',
  '',
  'Back in Hamilton with Sam. The heater in bay two failed again, $620 to replace, and the supplier',
  'admitted the part was out of warranty. Rita was in Windsor all week.',
  '',
  '19 February 2024',
  '',
  'Rita wrote at last: the Windsor shortfall was $1,240 as well, which is a coincidence I do not',
  'believe. Sam wants a full stock count every month from now on.',
  '',
  '7 March 2024',
  '',
  'March count in Hamilton with Sam: 51 boxes, no shortfall, and the ledger balances for the first',
  'time since November. Rita has not replied about the Windsor figures.',
  '',
  '22 March 2024',
  '',
  'Rita sent the Windsor count: 51 boxes there too, and the same $1,240 explained as a delivery',
  'invoiced twice. Sam is satisfied. I am not.',
].join('\n');

const results = [];
let failures = 0;

function check(label, ok, detail = '') {
  if (ok) results.push(`  ok   ${label}`);
  else {
    results.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

const browser = await chromium.launch({ channel: 'chrome' });
// The owner's network is served a stub `/consent.js` (the `no-ga-for-me` rule), and this
// live check runs from inside that range — so it asks for the real loader the same way the
// consent gate and the compliance check do.
const context = await browser.newContext({ extraHTTPHeaders: { 'X-Nodejs-Audit': '1' } });
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  const text = message.text();
  // A console error is how a caught-and-logged drawing fault would present; a page error is the
  // uncaught one. Both count — the page must be silent about its own charts.
  if (message.type() === 'error' && !/favicon/i.test(text)) pageErrors.push(text);
});

try {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const health = await page.locator('#health').innerText();
  check('the model is reachable, so a document can be indexed', /Answers come from/i.test(health), health.slice(0, 80));
  if (!/Answers come from/i.test(health)) throw new Error('no model — the charts cannot be drawn, so this check would prove nothing');

  await page.fill('#paste', DOCUMENT);
  await page.waitForTimeout(200);
  await page.click('#index');
  await page.waitForSelector('#shape:not([hidden])', { timeout: 120000 });
  await page.waitForTimeout(2500);

  check('nothing threw while the charts were drawn', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));

  const boxes = await page.evaluate(() => ({
    stages: { hidden: document.getElementById('index-stages-box')?.hidden, note: document.getElementById('index-stages-note')?.textContent?.trim() ?? '' },
    heat: document.getElementById('heat-box')?.hidden,
    composition: !!document.getElementById('composition'),
    timeline: !!document.getElementById('timeline'),
  }));
  check('the chart of how it was indexed is up', boxes.stages.hidden === false);
  check('and its caption carries measured seconds', /\d+\.\d\d s/.test(boxes.stages.note), boxes.stages.note.slice(0, 90));
  // The fixture has to keep producing a document with entries and notes in it, or the checks below
  // pass against a page that has almost nothing to draw — which is how the first version of this
  // script passed while showing one entry, one note, and two nearly empty charts.
  const counted = /(\d[\d,]*) entries? and ([\d,]+) notes? in/.exec(boxes.stages.note);
  check(
    'the fixture still indexes into several entries and notes',
    !!counted && Number(counted[1].replace(/,/g, '')) >= 3 && Number(counted[2].replace(/,/g, '')) >= 3,
    boxes.stages.note.slice(0, 90)
  );
  check('the heat map is up', boxes.heat === false, 'a document with names, places and amounts must have one');
  check('the composition chart and the timeline are in the page', boxes.composition && boxes.timeline);

  // Part 6a: a canvas drawn into a hidden panel keeps the 320-pixel default and is then stretched.
  const drawn = await page.evaluate(() => {
    const ratio = window.devicePixelRatio || 1;
    return [...document.querySelectorAll('canvas')]
      .filter((canvas) => canvas.clientWidth > 0)
      .map((canvas) => {
        const box = canvas.getBoundingClientRect();
        return {
          id: canvas.id,
          shown: Math.round(box.width),
          bitmap: canvas.width,
          expected: Math.round(box.width * ratio),
          ratio: Number((canvas.width / box.width).toFixed(3)),
        };
      });
  });
  for (const canvas of drawn) {
    check(`#${canvas.id} is drawn at the size it is shown`, canvas.bitmap === canvas.expected, JSON.stringify(canvas));
  }
  // The four charts step 2 is supposed to show, named — so a chart that silently stops drawing
  // cannot hide behind "at least three canvases were measured".
  for (const id of ['index-stages', 'timeline', 'composition', 'heat']) {
    check(`#${id} is on the page and drawn`, drawn.some((canvas) => canvas.id === id && canvas.bitmap > 0));
  }
  check('every chart canvas on the page was measured', drawn.length >= 4, `${drawn.length} canvas(es)`);
} finally {
  await browser.close();
}

console.log('\n'.concat(results.join('\n')));
console.log(
  failures === 0
    ? `\nALL CHECKS PASSED — ${results.length} checks against the deployed site`
    : `\n${failures} CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
