/**
 * Click every question the page offers, a few times, and judge what comes back.
 *
 * 🔴 WHY THIS EXISTS. George, 22 Sep 2026: *"i need you need more unit testing and sample you own inputs a
 * few times and test the performance and judge the answers to clicked questions"*. The unit tests prove the
 * program hands the model the right notes; they cannot say whether the ANSWER is any good, because that is
 * the one part of this pipeline that is not deterministic. So this tool does what a reader does — index a
 * document, click each suggested question, read the answer — and then measures three things per answer:
 *
 *   1. **COMPLETENESS** against ground truth counted in CODE from the document itself, not from the answer.
 *      For a list question this is the number that matters: *"Which employers and job titles are named?"*
 *      answered with four of twelve is a bad answer even though every sentence in it is true.
 *   2. **PERFORMANCE** — the search, the model call and the total, per question. The whole-document path
 *      costs more than the search path by construction, so the cost has to be visible rather than assumed.
 *   3. **STABILITY** — the same question asked again. A list that changes length between two identical runs
 *      is a list the reader cannot rely on, whatever either run says.
 *
 * Usage:
 *   node tools/judge-answers.mjs                        # every sample, twice, against 127.0.0.1:4500
 *   node tools/judge-answers.mjs --runs 3 --url http://127.0.0.1:4500
 *   node tools/judge-answers.mjs --only resume          # one document
 *   node tools/judge-answers.mjs --json /tmp/answers.json
 */

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const BASE = arg('url', 'http://127.0.0.1:4500');
const RUNS = Number.parseInt(arg('runs', '2'), 10);
const ONLY = arg('only', '');
const JSON_OUT = arg('json', '');

/* ------------------------------------------------------------------ the documents and their truth */

const diary = readFileSync(new URL('../src/samples.ts', import.meta.url), 'utf8');

/** The samples the repo ships, pulled out of the source so this tool cannot drift from the app. */
function sample(id) {
  const at = diary.indexOf(`const ${id.toUpperCase()} = \``);
  if (at === -1) throw new Error(`no sample called ${id}`);
  const start = diary.indexOf('`', at) + 1;
  return diary.slice(start, diary.indexOf('`', start));
}

/**
 * Ground truth, COUNTED BY HAND FROM THE DOCUMENT — never taken from an answer.
 *
 * `must` is what a complete answer has to name. `kind` decides how the answer is judged: a `list`
 * question is judged on completeness (every item present), anything else only on the things it had to
 * get right, because a summary is allowed to leave things out.
 */
const DOCUMENTS = [
  {
    id: 'resume',
    title: 'the built-in resume sample',
    text: sample('resume'),
    questions: {
      'Which employers and job titles are named?': {
        kind: 'list',
        must: ['First Canadian Title', 'Utherverse Digital', 'IOU Concepts'],
        titles: ['Senior Software Engineer', 'Software Engineer', 'Developer'],
      },
      'What skills are listed?': { kind: 'list', must: ['TypeScript', 'Node.js', 'React', 'GraphQL', 'PostgreSQL'] },
      'What education is listed?': { kind: 'list', must: ['University of Windsor'] },
      // 🔴 GROUND TRUTH ADDED AFTER WATCHING THIS ONE FAIL. Asked *"Where has this person worked?"*
      // the answer was *"Hamilton, Ontario, Windsor, Ontario, University of Windsor."* — the towns of
      // the roles and the university, and not one employer. Every line of it is copied from the
      // document, which is exactly why a page cannot rely on "it came from the document" as a
      // standard: the question asked where someone WORKED, and the answer never named who they
      // worked for. It is judged here so it cannot pass unnoticed again.
      'Where has this person worked?': {
        kind: 'list',
        must: ['First Canadian Title', 'Utherverse Digital', 'IOU Concepts'],
      },
      'What did they do in the most recent role?': { kind: 'one', must: ['PostgreSQL', 'GraphQL'] },
    },
  },
  {
    id: 'diary',
    title: 'the built-in diary sample',
    text: sample('diary'),
    questions: {
      'Where do the events take place?': { kind: 'list', must: ['Grimsby', 'James Street'] },
      'Who is mentioned most?': { kind: 'one', must: ['Andrea'] },
      'Which month was busiest?': { kind: 'one', must: ['March'] },
      'What happened first, and what happened last?': { kind: 'one', must: ['boiler'] },
    },
  },
  {
    /**
     * MY OWN INPUT, written for this tool: nine transactions, four payees, and the amounts named
     * once each so that a missed payee is a missed payee and not a coincidence of frequency.
     */
    id: 'ledger',
    title: 'a statement of accounts written for this tool',
    text: `STATEMENT OF ACCOUNTS — 1 January 2026 to 31 March 2026
Account 4471-0092. Opening balance $3,204.18.

03/01/2026 DEPOSIT Payroll — Northline Logistics $2,410.55
07/01/2026 DEBIT Hydro One $184.20
11/01/2026 DEBIT Freshmart Groceries $236.77
15/01/2026 DEBIT Rogers Wireless $96.35
22/01/2026 DEBIT Halton Property Tax $512.00
05/02/2026 DEPOSIT Payroll — Northline Logistics $2,410.55
09/02/2026 DEBIT Freshmart Groceries $198.04
14/02/2026 DEBIT Bell Canada $88.10
27/02/2026 DEBIT Home Depot $74.99
06/03/2026 DEPOSIT Payroll — Northline Logistics $2,410.55
12/03/2026 DEBIT Hydro One $201.60
19/03/2026 DEBIT Birchwood Dental $340.00
28/03/2026 DEBIT Freshmart Groceries $255.31

Closing balance $6,527.23.`,
    questions: {
      'Which payees or merchants are named?': {
        kind: 'list',
        must: ['Northline Logistics', 'Hydro One', 'Freshmart', 'Rogers', 'Halton Property Tax', 'Bell Canada', 'Home Depot', 'Birchwood Dental'],
      },
      'What amounts are listed?': { kind: 'list', must: ['2,410.55', '512.00', '340.00'] },
      'What date range does it cover?': { kind: 'one', must: ['January', 'March'] },
    },
  },
];

/* ------------------------------------------------------------------ asking */

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const present = (answer, needle) =>
  new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s,]+/g, '[\\s,]*'), 'i').test(answer);

/** How much of the ground truth the answer names, and what it left out. */
function judge(answer, truth) {
  const must = truth.must ?? [];
  const found = must.filter((needle) => present(answer, needle));
  const missing = must.filter((needle) => !present(answer, needle));
  return { kind: truth.kind, have: found.length, of: must.length, missing };
}

/* ------------------------------------------------------------------ the run */

const report = [];
for (const document of DOCUMENTS) {
  if (ONLY && document.id !== ONLY) continue;
  console.log(`\n=== ${document.title} ===`);
  const indexed = await post('/api/index', { text: document.text });
  const docId = indexed.document?.id;
  const offered = indexed.suggestions ?? [];
  const notes = indexed.document?.stats?.chunks ?? 0;
  console.log(`indexed as ${docId} — ${notes} notes, read as ${JSON.stringify(indexed.kindLabel)}`);
  console.log(`the page offers: ${offered.join(' | ')}`);

  for (const question of offered) {
    const truth = document.questions[question] ?? { kind: 'one', must: [] };
    if (!document.questions[question]) console.log(`  (no ground truth written for "${question}" — judged by eye only)`);
    const runs = [];
    for (let run = 1; run <= RUNS; run += 1) {
      const started = Date.now();
      const reply = await post('/api/ask', { docId, question });
      const answer = String(reply.prose ?? '').replace(/\s+/g, ' ').trim();
      runs.push({
        run,
        mode: reply.mode,
        notesShown: (reply.sources ?? []).length,
        answer,
        judgement: judge(answer, truth),
        ms: {
          search: reply.timings?.retrieveMs,
          model: reply.timings?.modelMs,
          total: reply.timings?.totalMs ?? Date.now() - started,
        },
        warnings: reply.warnings ?? [],
      });
    }
    const first = runs[0];
    const lengths = new Set(runs.map((entry) => entry.judgement.have));
    const answersDiffer = new Set(runs.map((entry) => entry.answer)).size > 1;
    console.log(`\n  Q: ${question}`);
    console.log(
      `  notes ${first.notesShown}/${notes} · ${first.mode} · ` +
        `search ${first.ms.search}ms · model ${(first.ms.model / 1000).toFixed(1)}s · total ${(first.ms.total / 1000).toFixed(1)}s` +
        (RUNS > 1 ? ` · ${answersDiffer ? 'ANSWERS DIFFER between runs' : 'same answer every run'}` : '')
    );
    if (truth.must?.length) {
      console.log(
        `  judgement: ${first.judgement.have}/${first.judgement.of} of the ground truth named` +
          (first.judgement.missing.length ? ` — MISSING: ${first.judgement.missing.join(', ')}` : ' — complete') +
          (RUNS > 1 && lengths.size > 1 ? ` · and it moved between runs (${[...lengths].join('/')})` : '')
      );
    }
    console.log(`  answer: ${first.answer.slice(0, 600)}`);
    for (const warning of first.warnings) console.log(`  warning: ${warning}`);
    report.push({ document: document.id, question, notes, runs });
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`\nwritten to ${JSON_OUT}`);
}

// A one-line summary that is worth reading on its own.
const listRuns = report.flatMap((entry) => entry.runs.filter((run) => run.judgement.kind === 'list'));
const complete = listRuns.filter((run) => run.judgement.missing.length === 0).length;
const slowest = Math.max(...report.flatMap((entry) => entry.runs.map((run) => run.ms.model)));
console.log(`\n=== summary ===`);
console.log(`list questions judged: ${listRuns.length} runs · complete: ${complete} · incomplete: ${listRuns.length - complete}`);
console.log(`slowest model call: ${(slowest / 1000).toFixed(1)}s`);
