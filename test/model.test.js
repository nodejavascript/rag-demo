/**
 * The model layer's readiness report, and the provider configuration.
 *
 * 🔴 **THIS FILE EXISTS BECAUSE A WORKING SITE WAS ABOUT TO BE CALLED BROKEN.** The
 * readiness probe asks the provider for its model catalogue, because that is free and
 * spends no tokens. Pointing the demo at Cloudflare's OpenAI-compatible endpoint made
 * that probe fail: the route exists but answers `GET /models` with **405**, and a plain
 * `!response.ok` turned that into "the model is not reachable" — while every question
 * would have been answered correctly.
 *
 * It was found by calling the route with no credentials at all, where the status code
 * tells you which of three things is true: **401 means the route is real**, **405 means
 * it is real but not for GET**, and **404 means it is not there**. That is the reasoning
 * the code now encodes, and these tests hold it in place.
 *
 * `health()` had no test at all before this, which is exactly why the defect got as far
 * as it did. The stub replaces `fetch` so every status code can be exercised without a
 * network and without spending a token.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Model, modelConfig } from '../dist/model.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every request with one status and body, and record what was asked for. */
function stubFetch(status, body = {}, { throws = false } = {}) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    if (throws) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return seen;
}

/** The OpenAI-shaped configuration the Workers AI cutover produces. */
const openaiish = {
  provider: 'openai',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'a-token',
  chatModel: 'a-chat-model',
  embedModel: 'an-embed-model',
  rerankModel: null,
  embedBatch: 64,
};

/* ------------------------------------------------------------------ *
 * The readiness report
 * ------------------------------------------------------------------ */

test('a provider that publishes no catalogue is reported UP, not broken', async () => {
  // 🔴 THE REGRESSION GUARD. Cloudflare's OpenAI-compatible endpoint answers 405 to
  // `GET /models`. Before this, the site said "the model is not reachable" while working.
  stubFetch(405, { errors: [{ message: 'GET not supported for requested URI.' }] });
  const health = await new Model(openaiish).health();
  assert.equal(health.ok, true, `405 must not be read as down — it said: ${health.detail}`);
  assert.match(health.detail, /no catalogue published/, 'and the reason is stated plainly');
  assert.match(health.detail, /a-chat-model/, 'the models it will use are still named');
});

test('a provider that answers 404 for the catalogue is also reported UP', async () => {
  // The same reasoning for any other provider that simply does not offer the route.
  stubFetch(404, {});
  const health = await new Model(openaiish).health();
  assert.equal(health.ok, true, 'a missing endpoint is not a broken model');
});

test('a refused credential is reported DOWN and named', async () => {
  for (const status of [401, 403]) {
    stubFetch(status, {});
    const health = await new Model(openaiish).health();
    assert.equal(health.ok, false, `${status} must be a fault`);
    assert.match(health.detail, /credential was refused/, 'and says which fault it is');
  }
});

test('an account without inference entitlement is reported DOWN and named', async () => {
  // The DigitalOcean 402 that started all of this. It must stay a real fault.
  stubFetch(402, { id: 'Payment Required' });
  const health = await new Model(openaiish).health();
  assert.equal(health.ok, false);
  assert.match(health.detail, /not enabled/i);
});

test('a server fault on their side is reported DOWN', async () => {
  stubFetch(500, {});
  const health = await new Model(openaiish).health();
  assert.equal(health.ok, false);
  assert.match(health.detail, /500/);
});

test('a healthy catalogue is reported UP', async () => {
  stubFetch(200, { data: [{ id: 'a-chat-model' }] });
  const health = await new Model(openaiish).health();
  assert.equal(health.ok, true);
  assert.match(health.detail, /a-chat-model \+ an-embed-model/);
});

test('an unreachable provider reports DOWN without throwing', async () => {
  stubFetch(0, {}, { throws: true });
  const health = await new Model(openaiish).health();
  assert.equal(health.ok, false, 'a dead network must be a reported state, not an exception');
});

test('the probe sends the credential and asks the catalogue path', async () => {
  const seen = stubFetch(200, { data: [] });
  await new Model(openaiish).health();
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /example\.invalid\/v1\/models$/, 'the probe asks /models');
  assert.equal(seen[0].headers.authorization, 'Bearer a-token', 'and carries the credential');
});

/* ------------------------------------------------------------------ *
 * The Ollama path must not be broken by any of the above
 * ------------------------------------------------------------------ */

test('ollama still reports a model that has not been pulled', async () => {
  stubFetch(200, { models: [{ name: 'some-other-model:latest' }] });
  const health = await new Model({ ...openaiish, provider: 'ollama', baseUrl: 'http://ollama.invalid' }).health();
  assert.equal(health.ok, false, 'a missing model is a real fault on the local path');
  assert.match(health.detail, /Not pulled/);
});

test('ollama reports UP when both models are present, tagged or not', async () => {
  stubFetch(200, { models: [{ name: 'a-chat-model:7b' }, { name: 'an-embed-model:latest' }] });
  const health = await new Model({ ...openaiish, provider: 'ollama', baseUrl: 'http://ollama.invalid' }).health();
  assert.equal(health.ok, true, 'Ollama tags models with a version suffix');
});

/* ------------------------------------------------------------------ *
 * The provider configuration — what the cutover depends on
 * ------------------------------------------------------------------ */

test('an explicit base URL chooses the OpenAI shape and reads the key from a file', () => {
  // This is the exact shape of the Workers AI cutover: a base URL and a key in a file,
  // never inline. Asserted because it is the one part of the switch nobody can test
  // without the credential.
  const dir = mkdtempSync(join(tmpdir(), 'rag-model-'));
  try {
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, 'a-secret-from-a-file\n');
    const config = modelConfig({
      MODEL_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1',
      MODEL_API_KEY_FILE: keyFile,
      CHAT_MODEL: '@cf/meta/llama-3.1-8b-instruct',
      EMBED_MODEL: '@cf/baai/bge-m3',
    });

    assert.equal(config.provider, 'openai', 'a non-ollama base URL is the OpenAI shape');
    assert.equal(config.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1');
    assert.equal(config.apiKey, 'a-secret-from-a-file', 'the key is read and trimmed');
    assert.equal(config.chatModel, '@cf/meta/llama-3.1-8b-instruct', 'a model name with a scope survives');
    assert.equal(config.embedModel, '@cf/baai/bge-m3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing key file produces no key rather than a crash', () => {
  const config = modelConfig({
    MODEL_BASE_URL: 'https://example.invalid/v1',
    MODEL_API_KEY_FILE: '/nonexistent/key',
  });
  assert.equal(config.apiKey, null, 'an absent key is null, and the 401 then says so plainly');
});

/* ------------------------------------------------------------------ *
 * Errors the reader can actually see
 * ------------------------------------------------------------------ */

/**
 * Remove comments before scanning source for a pattern.
 *
 * 🔴 **THIS EXISTS BECAUSE THE FIRST VERSION OF THESE TWO CHECKS FAILED ON ITS OWN
 * EXPLANATION.** The guard against `response.json()` matched the sentence in `readJson`'s
 * doc comment — *"A bare `response.json()` trusts the other end to be the API"* — and
 * reported a defect that was not there. That is a false failure, and the rule is that a
 * false failure is worse than no check, because it teaches the reader to ignore the gate.
 *
 * A check reads CODE. Prose about the code is not code.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('a refused credential comes back as a status the edge will not replace', async () => {
  // 🔴 THE INCIDENT, 19 Sep 2026. George pasted his resume and pressed Index. The server
  // had a clear sentence ready — "The model provider refused the request (401). The API
  // key was refused. Check MODEL_API_KEY_FILE." — and sent it with a **502**.
  //
  // **Cloudflare replaces an origin 502 with its own HTML error page.** Measured
  // directly: the origin answers 502 carrying that JSON, and the same request through the
  // edge answers `<!DOCTYPE html>`. The page then called `response.json()` on HTML and
  // threw `Unexpected token '<'`, so the reader got a JavaScript parser complaint in
  // place of the explanation written for them.
  //
  // 503 means "I cannot serve this right now", which is exactly true when the credential
  // is wrong — and Cloudflare passes 503 through, which `/healthz` has always proved.
  stubFetch(401, { id: 'Unauthorized', message: 'Unable to authenticate you' });
  await assert.rejects(
    () => new Model(openaiish).embed(['anything at all']),
    (error) => {
      assert.equal(
        error.status,
        503,
        'a status the edge replaces would hide this message completely, however good it is'
      );
      assert.match(error.message, /API key was refused/, 'and the message is the helpful one');
      return true;
    }
  );
});

test('no 502 is produced anywhere in the server', () => {
  // Belt and braces: 502 must not come back in a later edit either. It is the one status
  // that is silently swallowed by the edge in front of every one of these sites.
  //
  // ⚠ AND THIS CHECK PROVES IT SCANNED SOMETHING. A scan whose pattern matches nothing
  // passes while checking nothing at all, which is worse than having no check — the
  // reader trusts a green tick that was never earned. So the codes it found are asserted
  // to be non-empty, and printed in the failure so a broken pattern is obvious.
  const found = [];
  for (const file of ['model.ts', 'retrieve.ts', 'types.ts', 'server.ts', 'answer.ts', 'store.ts']) {
    const source = stripComments(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'));
    for (const m of source.matchAll(/\b(\d{3})\s*\)/g)) found.push(`${file}:${m[1]}`);
  }
  const statuses = new Set(found.map((f) => f.split(':')[1]));
  assert.ok(
    found.length > 5,
    `the scan found too few status codes to mean anything (${found.join(', ')}) — the pattern is wrong`
  );
  assert.ok(
    !statuses.has('502'),
    `502 is produced, and Cloudflare replaces it with its own page: ${found.filter((f) => f.endsWith('502')).join(', ')}`
  );
});

test('the page never parses a response unguarded', () => {
  // The other half. `readJson` reads the body as TEXT and parses deliberately, so anything
  // that is not the API is reported as what it is rather than as a parse error.
  const app = stripComments(readFileSync(new URL('../site/app.js', import.meta.url), 'utf8'));
  assert.match(app, /async function readJson/, 'readJson must exist');
  assert.ok(
    !/response\.json\(\)/.test(app),
    'every response must go through readJson — a bare response.json() shows the reader a parser error'
  );
  assert.match(
    app,
    /something in front of the app answered instead of the app/,
    'and a non-JSON answer is named as exactly that'
  );
});

test('an ollama base URL is recognised without being told the provider', () => {
  const config = modelConfig({ MODEL_BASE_URL: 'http://localhost:11434' });
  assert.equal(config.provider, 'ollama', 'the port is enough to know');
  assert.equal(config.apiKey, null);
});
