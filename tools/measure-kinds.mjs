/**
 * How the kind signals behave on a PAGE and on a BOOK — measured, not guessed.
 *
 * 🔴 WHY THIS EXISTS. The 508,035-character book (`rays-of-wit.pdf`) was read as *"minutes of a
 * meeting"*, because the minutes signal is `distinct(text, MINUTES_MARKER) >= 3` — and in half a million
 * characters of prose, `present`, `chair` and `resolved` each appear somewhere. The counts were tuned on
 * documents of a few hundred to a few thousand characters and were never checked against a large one.
 *
 * So this prints, for the built-in sample of each kind and for a real book:
 *
 *   · the DISTINCT marker count (what the detector uses today);
 *   · the OCCURRENCE count;
 *   · the occurrences per 1,000 characters — the DENSITY, which is the thing that does not change with
 *     the length of the document.
 *
 * Run: `node --experimental-sqlite tools/measure-kinds.mjs [path/to/text.txt]`
 */

import { readFileSync } from 'node:fs';
import { SAMPLES } from '../dist/samples.js';
import { SIGNALS, detectKind } from '../dist/kinds.js';

const patterns = [
  ['minutes', SIGNALS.MINUTES_MARKER],
  ['policy', SIGNALS.POLICY_MARKER],
  ['statement', SIGNALS.STATEMENT_MARKER],
  ['news', SIGNALS.NEWS_MARKER],
];

const global = (pattern) =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

function measure(name, text) {
  console.log(`\n${name} — ${text.length.toLocaleString()} characters, reads as "${detectKind(text, 0)}"`);
  for (const [label, pattern] of patterns) {
    const hits = text.match(global(pattern)) ?? [];
    const distinct = new Set(hits.map((hit) => hit.toLowerCase())).size;
    const density = (hits.length / Math.max(1, text.length)) * 1000;
    console.log(
      `  ${label.padEnd(10)} distinct ${String(distinct).padStart(3)}  ` +
        `occurrences ${String(hits.length).padStart(5)}  density ${density.toFixed(3)} per 1,000 chars`
    );
  }
}

for (const sample of SAMPLES) {
  measure(sample.id, sample.text);
}

const extra = process.argv[2];
if (extra) {
  measure(extra.split('/').pop(), readFileSync(extra, 'utf8'));
}
