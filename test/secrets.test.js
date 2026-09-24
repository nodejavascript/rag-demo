/**
 * The secrets gate — this repository must be publishable with the credentials that
 * make the fault report work.
 *
 * 🔴 GEORGE'S INSTRUCTION, 24 SEPTEMBER 2026, VERBATIM: ***"just do it, keep secrets out
 * of repos. that is it"*** — and it is the one condition he put on this work.
 *
 * 🔴 WHY A TEST AND NOT A HABIT. The page half of the fault report is deliberately
 * shippable to a public repository: `site/faults.js` holds no key, because the report
 * is relayed by this app's own server, which holds the credential. That design is only
 * worth anything if the credential really is absent — so it is asserted, on every run,
 * against the files that would be published and against the history that would be
 * published with them.
 *
 * Three shapes are refused, and the third is the one people forget:
 *
 *   1. **a token VALUE in a tracked file** — the obvious leak;
 *   2. **a token VALUE in any commit** — because a line deleted today is still in the
 *      commit that introduced it, and `git log -S` is the only place that is visible;
 *   3. **a secret-shaped FILE that is tracked at all** — `.env`, `.dev.vars`, `*.pem`,
 *      `*.key`, a `secrets/` directory — because a file that is tracked and harmless
 *      today is a file the next person fills in.
 *
 * AND IT SAYS SO WHEN IT CANNOT CHECK. If the tokens are not on this machine the value
 * scan is reported as unrun rather than passed: a check that silently measures nothing
 * is the false pass this file exists to avoid.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file git would publish, relative to the repository root. */
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((line) => line !== '');

/** The credential files, wherever a machine keeps them. */
const SECRETS = join(homedir(), 'Documents', 'secrets');
const CREDENTIALS = [
  '.rollbar_rag_demo_page_token',
  '.rollbar_rag_demo_server_token',
  '.rollbar_access_token',
];

function liveSecrets() {
  const found = [];
  for (const name of CREDENTIALS) {
    const path = join(SECRETS, name);
    if (!existsSync(path)) continue;
    const value = readFileSync(path, 'utf8').trim();
    if (value !== '') found.push({ name, value });
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * part 1 · the files that would be published
 * ------------------------------------------------------------------ */

test('no tracked file carries a credential value', () => {
  const secrets = liveSecrets();
  if (secrets.length === 0) {
    console.log('secrets: no credential on this machine, so the value scan did NOT run');
    return;
  }

  const leaks = [];
  for (const file of tracked) {
    const bytes = readFileSync(join(ROOT, file), 'utf8');
    for (const secret of secrets) {
      if (bytes.includes(secret.value)) leaks.push(`${file} (${secret.name})`);
    }
  }

  assert.deepEqual(leaks, [], `a credential value is in a tracked file: ${leaks.join(', ')}`);
});

test('no commit in this repository has ever carried a credential value', () => {
  const secrets = liveSecrets();
  if (secrets.length === 0) {
    console.log('secrets: no credential on this machine, so the history scan did NOT run');
    return;
  }

  for (const secret of secrets) {
    const commits = execFileSync('git', ['log', '--all', '--format=%h %s', '-S', secret.value], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();

    assert.equal(
      commits,
      '',
      `a commit introduced or removed ${secret.name}, so the value is in this repository's history:\n${commits}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * part 2 · the shapes that become leaks
 * ------------------------------------------------------------------ */

test('no secret-shaped file is tracked, and the ignore rules cover the shapes', () => {
  const forbidden = tracked.filter((file) =>
    /(^|\/)(\.env|\.dev\.vars|secrets)(\/|$)|\.(pem|key|p12|pfx)$/i.test(file),
  );
  assert.deepEqual(forbidden, [], `these files must never be tracked: ${forbidden.join(', ')}`);

  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const shape of ['.env', 'secrets']) {
    assert.match(ignore, new RegExp(shape.replace('.', '\\.')), `.gitignore does not cover ${shape}`);
  }

  const dockerIgnore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
  assert.match(dockerIgnore, /secrets/, '.dockerignore does not keep secrets/ out of the image');
});

test('a token-shaped literal is nowhere in the published files', () => {
  const published = tracked.filter((file) => /\.(ts|js|mjs|json|html|css|yml|yaml)$/.test(file));
  const suspects = [];

  for (const file of published) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const line of text.split('\n')) {
      const match = /(?:token|secret|key)\w*\s*[:=]\s*['"`]([A-Za-z0-9_-]{28,})['"`]/i.exec(line);
      if (match && !/\$\{|process\.env|import\.meta/.test(line)) {
        suspects.push(`${file}: ${line.trim().slice(0, 80)}`);
      }
    }
  }

  assert.deepEqual(
    suspects,
    [],
    `a credential appears to be assigned in the source rather than read from the environment or a file:\n${suspects.join('\n')}`,
  );
});

/* ------------------------------------------------------------------ *
 * part 3 · how the app is told where the credential is
 * ------------------------------------------------------------------ */

test('the app reads the tokens from the environment or a file, and the file form is what ships', async () => {
  const relay = readFileSync(join(ROOT, 'src', 'rollbar.ts'), 'utf8');

  assert.match(relay, /ROLLBAR_SERVER_TOKEN/, 'the server token has no name in the code');
  assert.match(relay, /ROLLBAR_PAGE_TOKEN/, 'the page token has no name in the code');
  assert.match(
    relay,
    /ROLLBAR_SERVER_TOKEN_FILE|_FILE/,
    'the file form is missing, and a value in the environment is visible to anything that can inspect the container',
  );
  assert.equal(
    /post_(client|server)_item'\s*:/.test(relay),
    false,
    'a scope string is being passed where a token belongs',
  );
});

test('the image is told where the credential is, never what it is', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  for (const line of compose.split('\n')) {
    if (!/ROLLBAR/i.test(line)) continue;
    assert.equal(
      /[:=]\s*['"]?[A-Za-z0-9_-]{28,}['"]?\s*$/.test(line),
      false,
      `the compose file carries a token value rather than its name: ${line.trim()}`,
    );
  }
});
