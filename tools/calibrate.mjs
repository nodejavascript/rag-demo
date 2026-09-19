#!/usr/bin/env node
/**
 * Measure the refusal floor for whatever embedding model is configured.
 *
 * This tool exists because of a rule that cannot be avoided: **an embedding always
 * reports some similarity**, so "is this document about this at all?" can never be
 * answered against zero. It has to be answered against a noise floor, and a floor is
 * a property of the MODEL, not of this code.
 *
 * The floor is measured between two populations:
 *   - questions about NOTHING — word salad, and questions on subjects the document
 *     plainly does not contain;
 *   - real questions about the document that share NO WORD with it, which is the hard
 *     case: if the floor is too high, a paraphrase is refused; too low, and everything
 *     is answered from whatever was nearest.
 *
 * 🔴 Run this again whenever EMBED_MODEL changes. A floor carried over from another
 * model is not a measurement, it is a guess wearing one.
 */

import { readFile } from 'node:fs/promises';
import { build } from '../dist/chunk.js';
import { Model, modelConfig } from '../dist/model.js';
import { SAMPLES } from '../dist/samples.js';

const NOISE = [
  'quantum chromodynamics lattice gauge',
  'the price of copper on the Shanghai exchange',
  'how do I install a graphics card driver',
  'photosynthesis in deep sea vent bacteria',
  'the offside rule in association football',
  'prime factorisation of large semiprimes',
  'what time is the tide at Bridlington',
  'reticulating splines in a legacy renderer',
];

/** Real questions about the diary that share almost no word with it. */
const PARAPHRASE = [
  'Did the heating stop working at any point?',
  'Was the author unwell or sleeping badly?',
  'Who came to visit and what did they carry?',
  'Was there any precipitation?',
  'How much did the holiday cost?',
  'Did they get any paid work?',
  'What was the outdoor temperature doing?',
  'Was there a problem with transport?',
];

function summarise(name, values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  console.log(
    `  ${name.padEnd(22)} n=${String(values.length).padStart(2)}  ` +
      `min ${at(0).toFixed(3)}  median ${at(0.5).toFixed(3)}  max ${at(1).toFixed(3)}`
  );
}

async function best(text, vectors, model) {
  const [query] = await model.embed([text]);
  let top = -1;
  for (const vector of vectors) {
    let dot = 0;
    for (let i = 0; i < vector.length; i += 1) dot += vector[i] * query[i];
    if (dot > top) top = dot;
  }
  return top;
}

async function main() {
  const source = process.argv[2];
  const text = source ? await readFile(source, 'utf8') : SAMPLES.find((s) => s.id === 'diary').text;

  const config = modelConfig();
  const model = new Model(config);
  const health = await model.health();
  console.log(`model: ${config.provider} · chat ${config.chatModel} · embed ${config.embedModel}`);
  console.log(`health: ${health.ok ? 'ok' : 'NOT OK'} — ${health.detail}\n`);
  if (!health.ok) process.exitCode = 1;

  const built = build(text, null, []);
  const vectors = await model.embed(built.chunks.map((chunk) => chunk.text));
  console.log(`document: ${built.entries.length} entries, ${built.chunks.length} notes\n`);

  const noise = [];
  for (const question of NOISE) noise.push(await best(question, vectors, model));
  const real = [];
  for (const question of PARAPHRASE) real.push(await best(question, vectors, model));

  console.log('max cosine against the document:');
  summarise('nothing to do with it', noise);
  summarise('real, no shared words', real);

  const highestNoise = Math.max(...noise);
  const lowestReal = Math.min(...real);
  console.log('');
  if (lowestReal > highestNoise) {
    const suggested = ((highestNoise + lowestReal) / 2).toFixed(3);
    console.log(
      `The two groups do not overlap — the highest noise score ${highestNoise.toFixed(3)} is below the\n` +
        `lowest real one ${lowestReal.toFixed(3)}. A floor of ${suggested} sits between them.\n` +
        `Set it with:  REFUSAL_FLOOR=${suggested}`
    );
  } else {
    console.log(
      `⚠ The two groups OVERLAP: a subject the document says nothing about scored ${highestNoise.toFixed(3)},\n` +
        `and a real question scored only ${lowestReal.toFixed(3)}. There is no clean floor for this model —\n` +
        `set REFUSAL_FLOOR to the lower figure ${lowestReal.toFixed(3)} and expect the refusal to be\n` +
        `conservative, or use a different embedding model.`
    );
  }
  console.log(
    `\nCurrent setting: REFUSAL_FLOOR=${process.env.REFUSAL_FLOOR ?? '0.56 (default)'}. ` +
      'The default was measured for nomic-embed-text and is NOT valid for another model.'
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
