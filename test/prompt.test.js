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
    /NEVER SAY WHETHER A MODEL WAS CALLED/,
    'the rule that stops the model describing the machinery is gone'
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
