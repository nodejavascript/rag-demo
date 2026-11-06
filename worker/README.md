# worker/ — the model proxy

A ~120-line Cloudflare Worker that gives the demo an OpenAI-shaped model endpoint **without
an API token anywhere**. `env.AI` is an AI *binding* — a capability of the Worker — so there
is nothing to create in a dashboard, nothing to store on a public droplet and nothing to
leak. The droplet holds one 64-character secret that buys exactly this: the two models
below, and nothing else in the account.

Why it exists: **nothing on the workstation can mint a Workers AI token.** Measured
2026-09-20 — `GET /user/tokens` answers `403 {"code":9109}` with all 29 scopes the wrangler
session holds, because creating a token needs `User API Tokens: Edit`, which is not one of
them. The demo had sat with an empty key file because of that one missing permission.

## Deploy

```bash
cd worker
openssl rand -hex 32 | tr -d '\n' > ~/Documents/secrets/.rag_model_proxy_secret
chmod 600 ~/Documents/secrets/.rag_model_proxy_secret
wrangler deploy
cat ~/Documents/secrets/.rag_model_proxy_secret | wrangler secret put MODEL_SECRET
wrangler deploy          # 🔴 DEPLOY AFTER PUTTING THE SECRET, AND THIS IS NOT A FORMALITY
```

🔴 **PUT THE SECRET, THEN DEPLOY — THE OTHER ORDER SERVES A VERSION THAT HAS NO SECRET.**
Measured on the first deploy here: the Worker was uploaded, `secret put` followed, and the
live Worker answered **401 to the correct secret too**. The probe showed why —
`envHasSecret: true, storedLen: 64` — the secret was bound perfectly and the *running
version* was the one deployed before it. Nothing about the Worker was wrong; it just had to
be deployed again. `wrangler deployments list` shows the versions and their creation times.

## What it answers

| Route | Behaviour |
|---|---|
| `POST /v1/chat/completions` | `@cf/google/gemma-4-26b-a4b-it`, OpenAI shape |
| `POST /v1/embeddings` | `@cf/baai/bge-m3`, up to 64 passages, OpenAI shape |
| `GET /v1/models` | **404 — deliberately.** The demo reads 404/405 as "no catalogue published, not a fault" |
| anything else | `401` without the secret, then `404` |

**The two models are an allow-list, not a pass-through.** Workers AI's free allowance is
measured in neurons and a 70B model spends them several times faster, so a caller holding the
secret still cannot choose the expensive one.

🔴 **The chat call sends `chat_template_kwargs: { enable_thinking: false }`, and the proxy
answers nothing without it.** Measured on the demo's own prompt on 2026-11-06: gemma spent all
700 of the caller's tokens reasoning and returned an **empty** content string, which the demo
reads as "the provider refused" — a 503 on every question while the model was working fine.
With thinking off the same question answered in **58 tokens, 3.1 s, 21.8 neurons**. If a future
model does not know the toggle the call is retried without it, so the proxy cannot be worse off
than a plain call.

## What the droplet actually runs (read off the machine, 2026-11-06)

```
MODEL_PROVIDER=openai
MODEL_BASE_URL=https://rag-model-proxy.gmail-webhook.workers.dev/v1
CHAT_MODEL="@cf/google/gemma-4-26b-a4b-it"
EMBED_MODEL="@cf/baai/bge-m3"
MODEL_API_KEY_FILE=/run/secrets/model_key
```

**The two model values must match this Worker's constants exactly** — the proxy rejects any
other id with `400`, so the Worker is deployed first and `/opt/rag/.env` changed second, then
`docker compose up -d --force-recreate`. Changing the chat model does **not** invalidate the
index: the embedding model did not move, so nothing needs re-indexing.

## Measured, 2026-09-20

| Check | Result |
|---|---|
| no credential / wrong credential | `401` |
| right credential, chat | `200` — `content: 'Ready'` |
| right credential, embeddings | `200` — 2 rows × 1024 dims |
| a model outside the list | `400` |
| the live demo, end to end | a document indexed, a question answered from it |

🔴 **`crypto.subtle.timingSafeEqual` IS SYNCHRONOUS IN WORKERD AND IT THROWS ON UNEQUAL
LENGTHS.** Measured with a temporary probe route: `boolean:true` for the right secret,
`threw:Input buffers must have the same byte length.` for none. It is the one member of
`crypto.subtle` that returns a value rather than a promise. The length guard in
`sameSecret` is what keeps that throw unreachable.

## Removing it

```bash
wrangler delete rag-model-proxy
```

Then point `/opt/rag/.env` back at a provider and put its key in
`/opt/rag/secrets/model_key` (see `../tools/use-workers-ai.sh`).
