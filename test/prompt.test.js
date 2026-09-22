/**
 * The rules the model is given, guarded as the built prompt rather than as prose.
 *
 * ⚠️ WHAT THIS FILE IS AND IS NOT. It reads the COMPILED prompt (`dist/prompt.js`), because the rules
 * are one template string and the honest thing to check is that the string that ships still carries
 * them. It cannot check that the model OBEYS a rule — only a live answer can show that, and the live
 * answers are judged in `tools/judge-answers.mjs` and the browser suite. So this is a guard against a
 * rule being deleted or softened while nobody was looking, not a proof of behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(join(here, '..', 'dist', 'prompt.js'), 'utf8');

test('the model is told never to claim whether a model was called', () => {
  // 🔴 THE FAILURE THIS GUARDS, MEASURED 22 Sep 2026. Asked *"What are the performance objectives?"*
  // about a job posting that has no such section, the model answered: *"…so no model was called —
  // that refusal is a fact about the document, worked out in milliseconds."* It had invented the
  // app's own wording for a DIFFERENT event: "no model was called" is what the page says when the
  // SEARCH refuses before any model runs, and here the model was running — the reader could see the
  // timings beside the answer reading *"the model took 1.6 s"*. Two statements that contradict each
  // other, and the untrue one was in the answer's voice.
  assert.match(
    prompt,
    /NEVER DESCRIBE THE MACHINERY/,
    'the rule that stops the model describing the machinery is gone'
  );
  // And the rule must state its own reason ACCURATELY. The first version of it claimed the model had
  // written the page's refusal sentence; it had not — the page printed its own wording on a route it
  // does not belong to. A rule explained by a false story teaches the next reader wrongly.
  assert.match(
    prompt,
    /it was not written by the model, and the page has been fixed/,
    'the rule lost the correction of its own false explanation'
  );
  assert.match(
    prompt,
    /You write the answer; the page writes the account of how it was made/,
    'the rule lost the sentence that says whose job each part is'
  );
});

test('and the refusal rules still forbid dressing a gap up as an answer', () => {
  // The neighbouring behaviour: answer from what the notes SAY, and when they say nothing, say that
  // and stop. If this ever goes, the rule above has nothing to attach to.
  assert.match(prompt, /THE RULES/);
  assert.match(prompt, /Answer only from the notes you are given/);
});

test('and the page never claims no model was called when one was', () => {
  // 🔴 THE DEFECT THIS GUARDS, MEASURED 22 Sep 2026. There are two ways to refuse: the search refuses
  // when nothing came close enough (no model runs), and the MODEL can refuse after reading the notes
  // (it ran for as long as it ran). The page printed ONE sentence for both — "…so no model was called
  // — that refusal is a fact about the document, worked out in milliseconds" — directly above a
  // timings line reading "model 1.6 s". Two statements contradicting each other, and the false one
  // was in the page's own voice.
  //
  // ⚠️ This reads the COMPILED page script, so it can show only that the two sentences differ and that
  // the model route does not make the search route's claim. That the right sentence is CHOSEN at run
  // time was measured in the browser: a job posting was asked for performance objectives it does not
  // have, the model refused, and the page said so without claiming the model was never called.
  const page = readFileSync(join(here, '..', 'site', 'app.js'), 'utf8');
  assert.match(page, /answer\.refusedBy === 'model'/, 'the page no longer distinguishes the routes');
  assert.match(page, /answer\.refusedBy === 'search'/, 'the search route lost its own sentence');
  const modelLine = page.slice(page.indexOf("answer.refusedBy === 'model'"));
  const firstSentence = modelLine.slice(0, modelLine.indexOf("answer.refusedBy === 'search'"));
  assert.ok(
    !/no model was called/i.test(firstSentence),
    'the model route is claiming no model was called, which the timings beside it contradict'
  );
  // And a server that does not say which route refused must not be described as either.
  assert.match(page, /'The document does not say\.'/, 'the fallback sentence for an unlabelled refusal is gone');
});
