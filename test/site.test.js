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
    step(html, 'step-2'),
    /id="index"/,
    'the index button drifted back into step 2, away from the box it acts on'
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

test('and step 2 is named for what it shows, not for what it used to do', () => {
  const html = site('index.html');
  assert.match(
    step(html, 'step-2'),
    /<h2>What it read<\/h2>/,
    'step 2 is not named for the panel it actually holds'
  );
  assert.doesNotMatch(
    step(html, 'step-2'),
    /<h2>Index it<\/h2>/,
    "step 2 still carries the button's name, which stopped being true when the button moved"
  );
});
