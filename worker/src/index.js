/**
 * A model proxy for rag-demo, so the demo needs NO Cloudflare API token.
 *
 * WHY THIS EXISTS. The demo needs an OpenAI-shaped model endpoint and a credential to go
 * with it, and **nothing on the workstation can mint a Workers AI token** — measured
 * 2026-09-20: `GET /user/tokens` answers `403 {"code":9109}` with all 29 scopes the
 * wrangler session holds, because creating a token needs `User API Tokens: Edit`, which
 * is not one of them. So the demo sat with an empty key file and answered nothing.
 *
 * This Worker removes the problem instead of working around it. It holds an **AI
 * binding** — a capability of the Worker itself, not a string — so there is no account
 * token to create, none to store on a public droplet, and none to leak. The droplet holds
 * one 64-character secret that is worth exactly this: model calls through these two
 * models. Compromising the droplet cannot reach the rest of the account, which is what
 * putting the wrangler OAuth token there would have done (that token also carries
 * `workers:write`, `d1:write`, `pages:write`, `containers:write` …).
 *
 * It speaks the OpenAI shape the demo already knows, so `src/model.ts` needed no change:
 *   POST /v1/chat/completions  { model, messages, temperature, max_tokens }
 *   POST /v1/embeddings        { model, input: string[] }
 *   GET  /v1/models            -> 404, on purpose (see below)
 *
 * The two shapes were measured against the real binding before this was written:
 *   chat   -> { result: { response: 'Ready.', usage: {…} } }
 *   embed  -> { result: { shape: [2, 1024], data: [[…1024 floats], …] } }
 *
 * 🔴 THE MODELS ARE AN ALLOW-LIST, NOT A PASS-THROUGH. The caller names a model and this
 * only accepts the two the demo uses. Workers AI's free allowance is measured in neurons
 * and a 70B model spends them several times faster, so a pass-through would let anyone
 * holding the secret choose the expensive one.
 */

const CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const EMBED_MODEL = '@cf/baai/bge-m3';

/** The demo embeds in batches of 64 (`embedBatch` in src/model.ts). */
const MAX_INPUTS = 64;
const MAX_CHARS = 200_000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function failure(status, message) {
  return json(status, { error: { message, type: 'invalid_request_error' } });
}

/** Compare without leaking where two strings first differ. */
async function sameSecret(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  try {
    // 🔴 `crypto.subtle.timingSafeEqual` IS SYNCHRONOUS IN WORKERD AND IT THROWS ON UNEQUAL
    // LENGTHS — both measured on the live Worker on 2026-09-20 with a temporary probe route,
    // which answered `boolean:true` for the right secret and
    // `threw:Input buffers must have the same byte length.` for none at all. It is the one
    // member of `crypto.subtle` that returns a value rather than a promise, so both shapes
    // are accepted here rather than one assumed. The length guard above is what keeps the
    // throw unreachable, and the catch is the belt to that pair of braces.
    const result = crypto.subtle.timingSafeEqual(left, right);
    return typeof result === 'boolean' ? result : await result;
  } catch {
    return a === b;
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/^\/v1/, '');

    const header = request.headers.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!env.MODEL_SECRET || !(await sameSecret(presented, env.MODEL_SECRET))) {
      // 401 is deliberate: the demo reads 401/403 as "the credential was refused", which
      // is exactly true here, and it reads 404 as "no catalogue published", which is not.
      return failure(401, 'Unable to authenticate you');
    }

    // 🔴 THE DEMO'S READINESS PROBE ASKS FOR A CATALOGUE, AND THIS PUBLISHES NONE.
    // `health()` reads 404/405 as "this provider has no catalogue — not a fault", which is
    // right: a working provider was once reported as unreachable because Cloudflare's own
    // endpoint answers `GET /models` with 405. 404 here keeps that behaviour and, because
    // the secret check comes first, a WRONG secret is still a 401 rather than a false OK.
    if (path === '/models') return failure(404, 'This provider publishes no catalogue.');

    if (request.method !== 'POST') return failure(405, 'Only POST is accepted here.');

    let body;
    try {
      body = await request.json();
    } catch {
      return failure(400, 'That body is not JSON.');
    }

    if (path === '/chat/completions') {
      if (body.model !== CHAT_MODEL) {
        return failure(400, `This proxy serves ${CHAT_MODEL} and nothing else.`);
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (messages.length === 0) return failure(400, 'There are no messages to answer.');

      const input = { messages };
      if (Number.isFinite(body.max_tokens)) input.max_tokens = Math.min(body.max_tokens, 4096);
      if (Number.isFinite(body.temperature)) input.temperature = body.temperature;

      let out;
      try {
        out = await env.AI.run(CHAT_MODEL, input);
      } catch (error) {
        return failure(503, `Workers AI did not answer: ${error?.message ?? error}`);
      }
      const content = typeof out === 'string' ? out : (out?.response ?? '');
      if (!content) return failure(503, 'Workers AI returned an empty reply.');

      return json(200, {
        object: 'chat.completion',
        model: CHAT_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: out?.usage ?? {},
      });
    }

    if (path === '/embeddings') {
      if (body.model !== EMBED_MODEL) {
        return failure(400, `This proxy serves ${EMBED_MODEL} and nothing else.`);
      }
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (inputs.length === 0) return failure(400, 'There is nothing to embed.');
      if (inputs.length > MAX_INPUTS) {
        return failure(400, `That is ${inputs.length} passages; the limit is ${MAX_INPUTS}.`);
      }
      const chars = inputs.reduce((sum, text) => sum + String(text ?? '').length, 0);
      if (chars > MAX_CHARS) return failure(400, 'That batch is too large to embed.');

      let out;
      try {
        out = await env.AI.run(EMBED_MODEL, { text: inputs.map((text) => String(text ?? '')) });
      } catch (error) {
        return failure(503, `Workers AI did not answer: ${error?.message ?? error}`);
      }
      const vectors = out?.data ?? [];
      if (vectors.length !== inputs.length) {
        return failure(503, `Workers AI returned ${vectors.length} vectors for ${inputs.length} passages.`);
      }

      return json(200, {
        object: 'list',
        model: EMBED_MODEL,
        data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    }

    return failure(404, 'No such route. This proxy serves /chat/completions and /embeddings.');
  },
};
