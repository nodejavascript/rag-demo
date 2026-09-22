/**
 * The house standard's part 5d — this site's background is its own drawing.
 *
 * 🔴 WHY THIS FILE EXISTS. Measured in a real browser on 19 September 2026: NINE of the ten
 * sites in this family painted a soft gradient wash and NOTHING else, while
 * `nodejavascript.com` painted a masked grid. Every one of them satisfied "has a background
 * image", because the register counted gradients — and not one of them had a drawing a visitor
 * could see. George, that evening, verbatim: *"the only thing wrong is that the background image
 * is not there for all sites except nodejavascript … the rest of the sites have lovely theme
 * colors and gradients, but maybe missing the extra touch of a background abstract."*
 *
 * So the rule being guarded is not "there is a gradient list". It is three things, and all three
 * are asserted here because each one has already been lost once somewhere in this family:
 *
 *   1. **GEOMETRY** — a repeating shape, not another glow;
 *   2. **A FADE** — a mask, because a pattern with an edge reads as a band, which he rejected;
 *   3. **IT IS ACTUALLY RENDERED** — asserted against the page that ships, because a rule
 *      satisfied inside a stylesheet nobody paints is no rule at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const site = (name) => readFileSync(join(here, '..', 'site', name), 'utf8');

test('the page renders an abstract layer', () => {
  assert.match(site('index.html'), /class="dvs-pattern"/);
});

test('and the abstract is geometry, not another glow', () => {
  const css = site('styles.css');
  const pattern = css.slice(css.indexOf('.dvs-pattern {'));
  assert.ok(pattern.length > 0, 'there is no .dvs-pattern rule at all');
  assert.match(pattern, /background-image:/);
  // This site's own shape: a dot matrix, drawn with background-size so the dots repeat.
  assert.match(pattern, /background-size:/, 'a dot matrix needs its own repeat size');
  assert.match(pattern, /radial-gradient\(/, 'the dots are drawn, not named');
});

test('and it fades, so nothing has an edge', () => {
  const css = site('styles.css');
  const pattern = css.slice(css.indexOf('.dvs-pattern {'));
  assert.match(pattern, /-webkit-mask-image:/);
  assert.match(pattern, /mask-image:/, 'and in every engine, not only WebKit');
});

test('and the layer sits behind the page rather than on top of it', () => {
  const css = site('styles.css');
  const pattern = css.slice(css.indexOf('.dvs-pattern {'));
  // A pointer-events-free, negative-index layer is the whole trick: a fixed layer that took
  // clicks would eat every button on the page, which is the bug the cookie banner taught.
  assert.match(pattern, /pointer-events:\s*none/);
  assert.match(pattern, /z-index:\s*-1/);
});

/* ------------------------------------------------------------------ the steps */

/**
 * 🔴 THE CONTROL THAT ACTS ON A BOX LIVES IN THE SAME STEP AS THE BOX.
 *
 * George, 20 September 2026, verbatim: *"good, but i still think the index it is too far away.
 * maybe it should be part of step 1. and step two call it something else"*.
 *
 * He was describing a real fault: the paste box sat in step 1 and the button that indexes it sat
 * in step 2 — a separate section below the fold — so a reader pasted a document and then had to
 * go looking for the thing that acts on it. Both halves of the ask are guarded here, because a
 * layout choice is exactly the kind of decision that gets quietly undone by a later edit, and
 * nothing else in this suite would notice.
 */

/** The markup of one step: from its own `<section` to the start of the next. */
function step(html, id) {
  const at = html.indexOf(`id="${id}"`);
  assert.notEqual(at, -1, `there is no ${id}`);
  const from = html.lastIndexOf('<section', at);
  const next = html.indexOf('<section', at);
  return html.slice(from, next === -1 ? undefined : next);
}

test('the button that indexes the box is in the same step as the box', () => {
  const html = site('index.html');
  assert.match(step(html, 'step-1'), /id="index"/, 'the index button left step 1');
  assert.doesNotMatch(
    step(html, 'step-3'),
    /id="index"/,
    'the index button drifted into the reading panel, away from the box it acts on'
  );
});

test('and it says why it is unavailable rather than being absent', () => {
  // The 200-character minimum used to be enforced by the *section* appearing, which meant the
  // rule was explained by a button the reader could not see. A disabled button with the reason
  // written beside it is the same rule, stated.
  assert.match(site('index.html'), /id="index" class="primary" disabled/);
  const app = readFileSync(join(here, '..', 'src', 'site', 'app.ts'), 'utf8');
  assert.match(app, /indexButton\.disabled = length < MIN_CHARS/);
});

test('each step is numbered for what it holds', () => {
  // 🔴 AS OF 22 SEP 2026 THE PANELS SWAPPED PLACES, AND THE NUMBERS WENT WITH THEM. George:
  // *"put ## Ask it something above ## What it read. i want them to see what it thinks the document
  // is."* So the panel that asks is step 2 and the panel that shows the reading is step 3 — the id,
  // the badge and the position all say the same thing. An `id="step-2"` on a panel whose badge
  // reads 3 is exactly the kind of name that lies, which is what this suite exists to prevent.
  const html = site('index.html');
  assert.match(step(html, 'step-2'), /<div class="step-n">2<\/div><h2>Ask it something<\/h2>/, 'step 2 is not the panel that asks');
  assert.match(step(html, 'step-3'), /<div class="step-n">3<\/div><h2>What it read<\/h2>/, 'step 3 is not the panel that shows the reading');
  assert.doesNotMatch(
    html,
    /<h2>Index it<\/h2>/,
    "a step still carries the button's name, which stopped being true when the button moved to step 1"
  );
});

test('and the ask panel comes BEFORE the panel that shows the reading', () => {
  // The change itself, asserted as order in the shipped markup — because order is what he asked for.
  const html = site('index.html');
  assert.ok(
    html.indexOf('id="step-2"') < html.indexOf('id="step-3"'),
    'the reading panel is above the ask panel again'
  );
  assert.ok(
    html.indexOf('id="step-3"') < html.indexOf('id="step-4"'),
    'and the reading panel must still come before the delete panel'
  );
});

test('the line explaining the Index button lines up with the controls around it', () => {
  // 🔴 "this text is misaligned and crowded" — George, 22 September 2026, quoting this paragraph
  // from the live page. Measured in a browser that morning: the file-button row started at x=45,
  // the row holding "Index it" at x=45, and the paragraph explaining that button at x=88 — because
  // `.step > p.hint` indents 43px, so a hint reads as a subtitle under the step's number badge.
  // Right directly beneath a heading; wrong between two rows of controls. It also carried no top
  // margin, so it touched the buttons above it.
  //
  // Asserted against the override's own numbers rather than a pixel position: a static test cannot
  // see a layout, but it can insist the rule that fixes it exists and says the right thing. Without
  // this, deleting one line of CSS puts the 43px indent straight back and nothing else notices.
  const css = site('styles.css');
  const at = css.indexOf('.row + p.hint {');
  assert.notEqual(at, -1, 'nothing overrides the 43px step indent for a hint that follows a row of controls');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /margin:\s*\d+px\s+0/, 'the line is indented away from the two rows it sits between');
  assert.match(rule, /16px/, 'and it is still touching the buttons above it');
  // And no element may quietly re-indent one of them back to 43px — which is how the step-1 fix
  // would be undone by a later `#index-hint` rule with a different value.
  assert.doesNotMatch(css, /#index-hint\s*\{[^}]*margin-left:\s*(?!0)[0-9]/, '#index-hint is indented again');
});

test('and the pictures it finds are called images, and the counting is only ever "in code"', () => {
  // One concept, one word — and one claim, one phrasing. The hero said "images" while the step-1
  // line said "pictures"; and the page's central promise appeared as BOTH "counted in code" and
  // "counted by the program", sometimes in the same sentence.
  //
  // 🔴 THE WHOLE FILE IS READ, NOT THE BODY. The first version of this guard started at `<body`
  // — so it passed while the meta description and the JSON-LD FAQ block went on saying "pictures"
  // and "by the program". Those are the two strings a SEARCH ENGINE reads, which makes them the
  // most public sentences the site has, and the guard was blind to both. Found on 22 Sep 2026 by
  // counting the strings in the SERVED page instead of trusting the test: 1 × "pictures",
  // 1 × "counted by the program", both in the head.
  const page = site('index.html');
  assert.doesNotMatch(page, /\bpictures\b/i, 'something on the page calls them pictures again');
  assert.match(page, /\bimages\b/, 'and the page never says images at all');
  assert.doesNotMatch(page, /by the program\b/i, 'the counting claim is back to two phrasings');
  assert.match(page, /in code/, 'and the page never says "in code" at all');
  const server = readFileSync(join(here, '..', 'src', 'server.ts'), 'utf8');
  assert.match(server, /pages are images rather than words/, 'the scanned-PDF message went back to "pictures"');
});

test('and the two mention charts are ranked highest-first, with gradient bars', () => {
  // George, 22 September 2026: *"Who and what appears when could sort my the value highest on top,
  // maybe gradient colors for the bars, same with ### What it is about"*. Three asks, and all three
  // are checkable in the source: both charts rank by value, and the bars are drawn as gradients.
  // The heat rows are ranked in `charts.ts` (where the grid is built, so the chart and the tally
  // cannot disagree); the composition rows in `app.ts`, where they are gathered.
  const app = readFileSync(join(here, '..', 'src', 'site', 'app.ts'), 'utf8');
  assert.match(
    app,
    /mentions\.amounts\.slice\(0, 2\)[\s\S]{0,160}?\.sort\(\(a, b\) => b\.value - a\.value\)/,
    'the composition rows are not ranked by their value'
  );
  assert.match(
    app,
    /drawRows\(el\.composition, rows, \{ gradient: true \}\)/,
    'the composition bars are no longer drawn as gradients'
  );
  assert.match(app, /function ramp\(/, 'the value colour ramp is gone, so the bars and the heat map disagree');
  const charts = readFileSync(join(here, '..', 'src', 'charts.ts'), 'utf8');
  assert.match(charts, /\.sort\(\(a, b\) => b\.count - a\.count\)/, 'the heat rows are not ranked by count');
});

test('the question buttons sit under the box the reader asks in, with room above and below them', () => {
  // George, 22 Sep 2026, moving the same two nodes a second time: *"This looks like a resume — try
  // one of these: i want more vertical space above and below this. this tells users how smart the
  // rag is. also the button questions go under the user ask."* So the box comes first and the
  // ready-made questions follow it, and that block — the line naming what the document was taken
  // for plus the questions under it — is given air, because it is the page demonstrating that it
  // understood the document.
  const askPanel = step(site('index.html'), 'step-2');
  const at = {
    hint: askPanel.indexOf('<p class="hint">'),
    input: askPanel.indexOf('id="question"'),
    askButton: askPanel.indexOf('id="ask"'),
    errorLine: askPanel.indexOf('id="ask-error"'),
    theLine: askPanel.indexOf('id="suggestions-hint-row"'),
    theQuestions: askPanel.indexOf('id="suggestions"'),
  };
  // 🔴 THE HINT IS FOUND BY ITS ELEMENT, NOT BY ITS WORDS. Searching for the phrase
  // "Ask in your own words" found it in the COMMENT ABOVE — which quotes George asking for this
  // very change — so the guard failed on the fix it was written to protect. A guard that searches
  // prose will always find its own comment, and the comment is usually nearer the top.
  assert.ok(
    Object.values(at).every((index) => index !== -1),
    `the ask panel lost part of itself: ${JSON.stringify(at)}`
  );
  assert.ok(at.hint < at.input, 'the sentence about how questions are matched must explain the box below it');
  assert.ok(at.input < at.askButton, 'the Ask button must follow the box it submits');
  assert.ok(at.askButton < at.theLine, 'the questions went back above the box the reader asks in');
  assert.ok(at.errorLine < at.theLine, 'the error line belongs to the box, so it stays above the questions');
  assert.ok(at.theLine < at.theQuestions, 'the line naming the document must introduce the questions under it');

  // The room is the other half of the ask, and an order without it is only half done.
  const css = site('styles.css');
  const above = /#suggestions-hint-row\s*\{[^}]*margin-top:\s*(\d+)px/.exec(css);
  const below = /#suggestions\s*\{[^}]*margin-bottom:\s*(\d+)px/.exec(css);
  assert.ok(above, 'nothing states the space above the line that names the document');
  assert.ok(below, 'nothing states the space below the questions');
  assert.ok(Number(above[1]) >= 24, `the line naming the document has only ${above[1]}px above it`);
  assert.ok(Number(below[1]) >= 20, `the questions have only ${below[1]}px below them`);
  assert.match(css, /\.suggest-hint \{ margin: 0;/, 'the line kept its own top margin, which double-counts the room above');
});

test('and the reading panel carries the chart of how it was indexed', () => {
  // George, 22 Sep 2026: *"is there a new chart you can use to show how it was index"*. It lives with
  // the other charts on the reading panel — but only when the document carries timings, so an older
  // record hides it instead of drawing three zeroes.
  const html = site('index.html');
  assert.match(step(html, 'step-3'), /id="index-stages"/, 'the index-stage chart is not on the reading panel');
  const app = readFileSync(join(here, '..', 'src', 'site', 'app.ts'), 'utf8');
  assert.match(app, /renderIndexStages\(document\)/, 'nothing renders it');
  assert.match(app, /document\.stats\.stageMs/, 'and it does not read the measured timings');
});

/* ------------------------------------------------------- the paste box and the cards */

test('a file can be dropped anywhere on the paste box, not only on the textarea', () => {
  // 🔴 THE COPY PROMISED IT AND THE LISTENERS DID NOT. The hint has always said *"drop a .txt, .md,
  // .csv, .html or .pdf file anywhere on this box"*, while `dragover`/`drop` were bound to the
  // textarea — so the box's own edges and padding did nothing. George asked, 22 Sep 2026: *"how
  // about drage and drop as well as pasting?"* This asserts the claim and the listener cover the
  // same element, and that the state is drawn on it.
  const html = site('index.html');
  assert.match(html, /<div class="paste-wrap" id="paste-wrap">/, 'the box has no id for a listener to bind to');
  const app = readFileSync(join(here, '..', 'src', 'site', 'app.ts'), 'utf8');
  assert.match(app, /pasteWrap: \$\('paste-wrap'\)/);
  assert.match(app, /const dropZone = el\.pasteWrap;/, 'the drop listeners are not bound to the box');
  assert.match(app, /dropZone\.addEventListener\('drop'/, 'nothing handles the drop on the box');
  assert.match(app, /dropZone\.addEventListener\('dragover'/, 'and nothing highlights it while a file is over it');
  assert.match(app, /contains\(event\.relatedTarget/, 'dragging over a child of the box would flicker the state');
  assert.match(site('styles.css'), /\.paste-wrap\.drop \{/, 'the drop state is not drawn on the box');
});

test('and a stat card gives its label, its number and its note room to be read in order', () => {
  // 🔴 "this is vertically bynched together i dont like" — George, 22 Sep 2026, on a card reading
  // `Notes / 20 / what gets searched`. The margins were 3px and 1px: a small-caps label sitting on
  // top of its own number, read as one block. The numbers are asserted because that rhythm is the
  // fix, and a later tidy-up to `margin-top: 2px` would put it back without anyone noticing.
  const css = site('styles.css');
  const value = /\.card \.v \{[^}]*margin-top:\s*(\d+)px/.exec(css);
  const unit = /\.card \.u \{[^}]*margin-top:\s*(\d+)px/.exec(css);
  assert.ok(value && Number(value[1]) >= 6, `the number sits too close to its label (${value?.[1] ?? 'no rule'})`);
  assert.ok(unit && Number(unit[1]) >= 4, `and the note sits too close to its number (${unit?.[1] ?? 'no rule'})`);
});

/* ------------------------------------------------------------------ identity */

test('the title and og:site_name ARE the host, not a name for it', () => {
  // Part 1 of the house standard, and the distinction is the whole rule: the title may not
  // *carry* the host, it must *be* the host. `og:site_name` is the same fact stated twice, and
  // it said `rag-demo` — a name for the site — which is the half-right version part 1 exists to
  // stop. A reader who sees two different names for one thing has been told nothing.
  const html = site('index.html');
  assert.match(html, /<title>rag-demo\.nodejavascript\.com<\/title>/);
  assert.match(
    html,
    /<meta property="og:site_name" content="rag-demo\.nodejavascript\.com" \/>/,
    'og:site_name must be the full host, not the demo name'
  );
});

test('and the hero list flows as prose, not as columns', () => {
  // 🔴 THE STRUCTURAL CAUSE OF "the alignment is all wrong" (George, 20 Sep 2026). `.hero li` is a
  // flex row so the bullet dot can sit beside the text — and a flex container drops the whitespace
  // between its items, so a bare text node after `</b>` became a SECOND flex item: the sentence
  // started in its own column at a different x on every row, with a 10px gutter where a space
  // belonged. The text has to be inside a single element for it to flow, so that is what is
  // asserted — the markup, because that is where the fault was.
  const html = site('index.html');
  const list = html.slice(html.indexOf('<ul>', html.indexOf('class="wrap hero"')), html.indexOf('</ul>', html.indexOf('class="wrap hero"')));
  const items = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1].trim());
  assert.ok(items.length >= 3, 'the hero list should still have its three points');
  for (const item of items) {
    assert.match(item, /^<span>[\s\S]*<\/span>$/, `a hero list item is not one flowing block: ${item.slice(0, 60)}…`);
  }
});
