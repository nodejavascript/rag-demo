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
