#!/usr/bin/env node
/**
 * Known questions with known answers, scored.
 *
 * `npm test` proves the machinery works; this proves the ANSWERS are right, which is a
 * different claim. Each case asserts something specific and checkable — a date that
 * must be retrieved AND named, a count that must match code exactly, a question that
 * must be refused — so a regression in the prompt or the retrieval shows up as a
 * number rather than as a feeling that the answers got worse.
 *
 * Most cases run over the built-in diary. The last two run over **George's own
 * resume**, because the worst answer this app has ever given was given about it: asked
 * where he went to school, it said *University of Windsor*, a name that is not in the
 * document. A diary cannot catch that class of fault — the fault needs a document whose
 * sections are fragments and whose places sit next to institutions.
 *
 * Needs a live model. `npm run eval`.
 */

import { readFileSync } from 'node:fs';

import { build } from '../dist/chunk.js';
import { answer } from '../dist/answer.js';
import { Model, modelConfig } from '../dist/model.js';
import { SAMPLES } from '../dist/samples.js';
import { Store } from '../dist/store.js';
import { indexDocument } from '../dist/indexer.js';

/** Each case: what to ask, and what the answer must and must not contain. */
const CASES = [
  {
    question: 'What happened on 6 March 2026?',
    must: [/circuit board/i, /6 March 2026|2026-03-06/],
    mustNot: [],
    why: 'the date must be retrieved, quoted, and named in words',
  },
  {
    question: 'What was the weather like?',
    must: [/rain/i],
    mustNot: [/doesn't say/i],
    why: 'the word "weather" is absent but "Rain all day" answers it — rule 4',
  },
  {
    question: 'When did the boiler fail?',
    must: [/4 March|6 March|2026-03-0[46]/],
    mustNot: [],
    why: 'both failures should be reachable',
  },
  {
    question: 'Which month was worse, March or April?',
    must: [/march/i],
    mustNot: [],
    why: 'a comparison cannot be answered by retrieval — it needs the computed counts',
  },
  {
    question: 'Where does her mother live?',
    must: [/grimsby/i],
    mustNot: [],
    why: 'a place mentioned once must be found',
  },
  {
    question: 'What did Andrea bring?',
    must: [/paperwork|dog/i],
    mustNot: [],
    why: 'a person mentioned once per entry must survive the document-level tally',
  },
  {
    question: 'How much was the cottage?',
    must: [/1,?450/],
    mustNot: [],
    why: 'an amount must be quoted exactly',
  },
  {
    question: 'What colour was the front door?',
    must: [],
    mustNot: [],
    refusalsOnly: true,
    why: 'a detail the document never gives must be refused, not invented',
  },
  {
    question: "What is Cecilia's maiden name?",
    must: [],
    mustNot: [],
    refusalsOnly: true,
    why: 'a name that appears nowhere is the hard refusal — a nearby note must not answer it',
  },
  {
    question: 'How many times is the boiler mentioned?',
    // 🔴 `/twice/` IS NOT A LOOSENING — IT IS A FALSE FAILURE REPAIRED. The model answered
    // "The boiler is mentioned twice.", which is exactly right, and the check called it a
    // failure because "twice" contains neither "2" nor "two". The `mustNot` list already
    // excludes 3 and 4, so the intent was never in doubt: **the answer must be two.** A
    // check that cannot see a correct answer is worse than no check, because it teaches
    // the reader to ignore the score. Found 2026-09-19 against Workers AI.
    must: [/twice|\b2\b|\btwo\b/i],
    mustNot: [/3|three|4|four/i],
    why: 'the count must come from code over the whole document, never from the model',
  },
  {
    doc: 'resume',
    question: 'Where did he go to school?',
    must: [/St\.?\s*Clair/i],
    mustNot: [/University/i],
    why: 'the resume names St. Clair College and contains no such word as University — this is the answer that was wrong',
  },
  {
    doc: 'resume',
    question: 'Who does he work for now?',
    must: [/Data Vision Studios/i],
    mustNot: [],
    why: 'the present role must outrank a twenty-year history, so the timeline has to be read',
  },
];

/** The resume fixture, redacted only of an e-mail address and a phone number. */
function resumeText() {
  return readFileSync(new URL('../fixtures/george-resume.md', import.meta.url), 'utf8');
}

async function main() {
  const config = modelConfig();
  const model = new Model(config);
  const health = await model.health();
  console.log(`model: ${config.provider} · chat ${config.chatModel} · embed ${config.embedModel}`);
  console.log(`health: ${health.ok ? 'ok' : 'NOT OK'} — ${health.detail}\n`);
  if (!health.ok) {
    console.error('A live model is needed for the eval. Start Ollama, or set MODEL_BASE_URL.');
    process.exitCode = 1;
    return;
  }

  const store = new Store(process.env.EVAL_DB ?? ':memory:');

  // One index per document, built the first time a case asks for it.
  const indexed = new Map();
  async function documentFor(id) {
    const already = indexed.get(id);
    if (already) return already;
    const text = id === 'resume' ? resumeText() : (SAMPLES.find((sample) => sample.id === id)?.text ?? '');
    const { document } = await indexDocument(store, model, { text, title: id });
    console.log(`indexed ${id}: ${document.stats.entries} entries in ${document.stats.embeddingMs} ms`);
    indexed.set(id, document);
    return document;
  }
  await documentFor('diary');
  console.log('');

  let passed = 0;
  const started = Date.now();

  for (const [at, testCase] of CASES.entries()) {
    const document = await documentFor(testCase.doc ?? 'diary');
    const result = await answer(store, model, document.id, testCase.question);
    const text = result.mode === 'refused' ? '' : result.prose;
    const problems = [];

    if (testCase.refusalsOnly) {
      if (result.mode !== 'refused') problems.push('should have been refused');
    } else {
      if (result.mode !== 'grounded') problems.push('was refused but should not have been');
      for (const pattern of testCase.must) {
        if (!pattern.test(text)) problems.push(`missing ${pattern}`);
      }
      for (const pattern of testCase.mustNot) {
        if (pattern.test(text)) problems.push(`should not contain ${pattern}`);
      }
    }

    const ok = problems.length === 0;
    if (ok) passed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${String(at + 1).padStart(2)}. [${testCase.doc ?? 'diary'}] ${testCase.question}`);
    if (!ok) {
      console.log(`      ${problems.join('; ')}`);
      console.log(`      why it matters: ${testCase.why}`);
    }
    console.log(`      ${result.mode} in ${result.timings.totalMs} ms — ${text.slice(0, 160).replace(/\n/g, ' ') || '(refused)'}`);
  }

  store.close();
  console.log(
    `\n${passed}/${CASES.length} passed in ${((Date.now() - started) / 1000).toFixed(1)} s. ` +
      (passed === CASES.length ? 'All good.' : 'A failure here is a claim about the ANSWERS, not the machinery.')
  );
  if (passed !== CASES.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
