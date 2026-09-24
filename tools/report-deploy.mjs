/**
 * report-deploy.mjs — tell Rollbar which revision went out.
 *
 * 🔴 WHY THIS EXISTS. An error is far easier to read next to the release that
 * introduced it, and on this fleet it is also the check that decides whether a fix
 * worked. The rule George set on 23 September 2026, verbatim: ***"what you fix should
 * be reolsved immediately after you deploy. that is a rollbar rule. the idea is, they
 * should not return if you fixed the issues correctly."*** — and a fix is judged
 * against **the finish time of the deploy carrying it**. Without this report there is
 * no such time to judge against.
 *
 * 🔴 IT CANNOT FAIL THE DEPLOY. Rollbar's answer is printed and the exit code is 0
 * unless `--strict` is passed, because a monitoring record is not worth a failed
 * publish. That is the same rule the relay follows at the other end: the thing that
 * watches must never become the incident.
 *
 * On the reference implementation it is also the one Rollbar channel that still works
 * on an account that cannot ingest occurrences: `POST /deploy/` answered 200 with the
 * same key that made `POST /item/` answer 429. Nothing here depends on that, but it is
 * why the deploy report is written even when items are refused.
 *
 * The token is read from the secrets folder and is never in this repository:
 *   $ROLLBAR_SERVER_TOKEN_FILE, else ~/Documents/secrets/.rollbar_rag_demo_server_token
 *
 * Usage: node tools/report-deploy.mjs [--revision <sha>] [--dry-run] [--strict]
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const ENDPOINT = 'https://api.rollbar.com/api/1/deploy/';
const TOKEN_FILE =
  process.env.ROLLBAR_SERVER_TOKEN_FILE ||
  join(homedir(), 'Documents/secrets/.rollbar_rag_demo_server_token');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const strict = args.includes('--strict');
const revisionFlag = args.indexOf('--revision');

function git(command) {
  return execSync(command, { cwd: join(import.meta.dirname, '..') }).toString().trim();
}

const revision =
  revisionFlag === -1 ? git('git rev-parse HEAD') : args[revisionFlag + 1] || git('git rev-parse HEAD');
const subject = git('git log -1 --pretty=%s');

const payload = {
  environment: 'production',
  revision,
  local_username: 'geooogle',
  comment: subject.slice(0, 200),
};

if (dryRun) {
  console.log('dry run · would report this deploy to Rollbar:');
  console.log(`  ${JSON.stringify(payload)}`);
  process.exit(0);
}

let token;
try {
  token = readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  console.log(`  (no Rollbar token at ${TOKEN_FILE} — the deploy is not reported)`);
  process.exit(strict ? 1 : 0);
}

try {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rollbar-access-token': token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 200);
  console.log(`  Rollbar deploy report (${revision.slice(0, 7)}) -> HTTP ${response.status} ${text}`);
  if (!response.ok) process.exit(strict ? 1 : 0);
} catch (error) {
  console.log(`  Rollbar deploy report could not be sent: ${error.message}`);
  process.exit(strict ? 1 : 0);
}
