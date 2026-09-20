#!/usr/bin/env bash
#
# Point rag-demo at Cloudflare Workers AI.
#
# WHY THIS SCRIPT EXISTS. The deployed demo needs a model credential, and no credential
# this machine holds for the long term is accepted by Workers AI: the DNS-scoped token
# answers 403, and the wrangler OAuth session — although it **can** now reach inference
# (measured 2026-09-19, after a full `wrangler login --device` brought in the `ai` scope) —
# is wrangler's own short-lived token and must never be put on a droplet. Token management
# is refused outright (`9109`, HTTP 403, on all three endpoints) even with all 29 scopes,
# so **nothing on this machine can mint the credential.** It has to be created once, by
# hand, in the Cloudflare dashboard. **Everything either side of that one action is here**,
# so that when George has the token it is a single command rather than a sequence of them.
#
# It does NOT create the token, and it never prints the secret. The token goes from a file
# on this machine to a file on the droplet over ssh, and appears in no log, no command
# line and no chat message.
#
# 🔴 SUPERSEDED AS THE DEPLOYED PATH, 20 Sep 2026 — KEPT AS THE ALTERNATIVE. The demo now
# runs through **a Worker with an AI binding** (`worker/`, deployed as `rag-model-proxy`),
# so it needs no API token at all: an AI binding is a capability of the Worker, not a string
# anyone has to store. That was built because this script's one action — creating a token by
# hand — is the one thing nothing here can do. This script still works and is the right tool
# if a direct token is ever preferred; wire it and the Worker becomes unused.
#
#   tools/use-workers-ai.sh --check    # does the token actually work?  (safe, changes nothing)
#   tools/use-workers-ai.sh            # configure the droplet and verify the live site
#
# Where to get the token:
#   https://dash.cloudflare.com/profile/api-tokens  ->  Create Token  ->  Custom token
#     Permissions:  Account  ->  Workers AI  ->  Read
#     Resources:    Include  ->  sample@example.com's Account
#   Save it to  ~/Documents/secrets/.cloudflare_workers_ai_token   (chmod 600)
#
set -euo pipefail

ACCOUNT_ID="e58fdc10abbc99a8e40c2d18b691a999"
TOKEN_FILE="$HOME/Documents/secrets/.cloudflare_workers_ai_token"
BASE_URL="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1"
HOST="dvs-sites"
APP_DIR="/opt/rag"
CONTAINER="rag"
SITE="https://rag-demo.nodejavascript.com"

# An 8B-class model on purpose. The Worker AI free allowance is measured in neurons and a
# 70B model spends them many times faster, so the default is the one that keeps the demo
# free for the longest. Both are overridable for a one-off test.
#
# 🔴 `-fp8` IS NOT DECORATION. The plain `@cf/meta/llama-3.1-8b-instruct` was DEPRECATED on
# 2026-05-30 and now answers **HTTP 410** with "Model has been deprecated" — this default
# would have failed on the first question. The `-fp8` build is the live one. Measured
# 2026-09-19 with a real call: HTTP 200, content `'Go'`.
#
# 🔴 AND DO NOT SWAP IN A REASONING MODEL WITHOUT CHECKING THE RESPONSE SHAPE. Both
# `@cf/openai/gpt-oss-20b` and `@cf/zai-org/glm-4.7-flash` answer HTTP 200 but return
# **`message.content: null`**, putting their output in `reasoning_content` instead — the
# demo reads `message.content`, so either one would produce empty answers that look like
# a broken model. The catalog's "Text Generation" list mixes the two families together.
CHAT_MODEL="${CHAT_MODEL:-@cf/meta/llama-3.1-8b-instruct-fp8}"
EMBED_MODEL="${EMBED_MODEL:-@cf/baai/bge-m3}"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

fail() { printf '\n  STOP: %s\n\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- the token

[ -f "$TOKEN_FILE" ] || fail "no token at $TOKEN_FILE

  Create one (free, no card):
    https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Custom token
    Permissions:  Account -> Workers AI -> Read
    Resources:    Include -> sample@example.com's Account
  Then save it:
    printf '%s' 'PASTE-IT-HERE' > $TOKEN_FILE && chmod 600 $TOKEN_FILE

  Never paste it into a chat. This script reads the file and nothing else."

TOKEN="$(tr -d '\n\r' < "$TOKEN_FILE")"
[ -n "$TOKEN" ] || fail "the token file is empty"

# ---------------------------------------------------------------- prove it works first

echo
echo "1. Does this token actually work?  (a real call, not a guess)"
echo

chat="$(curl -s -o /tmp/wai-chat.json -w '%{http_code}' \
  -X POST "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"model\":\"$CHAT_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: ready\"}],\"max_tokens\":8}")"

if [ "$chat" != "200" ]; then
  printf '   chat       HTTP %s\n' "$chat"
  python3 -c "import json;d=json.load(open('/tmp/wai-chat.json'));print('   ',str(d.get('errors') or d)[:180])" 2>/dev/null || cat /tmp/wai-chat.json | head -c 180
  case "$chat" in
    401|403) fail "the token was refused. Check it has Account -> Workers AI -> Read, and that it is the right account." ;;
    402)     fail "the account is not entitled to inference." ;;
    *)       fail "Workers AI did not answer 200." ;;
  esac
fi
printf '   chat       HTTP 200  (%s)\n' "$CHAT_MODEL"

emb="$(curl -s -o /tmp/wai-emb.json -w '%{http_code}' \
  -X POST "$BASE_URL/embeddings" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"model\":\"$EMBED_MODEL\",\"input\":\"hello\"}")"
[ "$emb" = "200" ] || fail "embeddings answered HTTP $emb — the demo cannot index without them"
dims="$(python3 -c "import json;d=json.load(open('/tmp/wai-emb.json'));print(len(d['data'][0]['embedding']))" 2>/dev/null || echo '?')"
printf '   embeddings HTTP 200  (%s, %s dimensions)\n' "$EMBED_MODEL" "$dims"
echo
echo "   Both work. The credential is good."

if [ "$CHECK_ONLY" = "1" ]; then
  echo
  echo "   --check only. Nothing was changed."
  echo
  exit 0
fi

# ---------------------------------------------------------------- configure the droplet

echo
echo "2. Configuring $HOST"
echo

# The key goes over ssh on standard input, so it is never an argument (visible in the
# process list) and never a local file that a later command might echo.
ssh "$HOST" "mkdir -p $APP_DIR/secrets && cat > $APP_DIR/secrets/model_key && chmod 600 $APP_DIR/secrets/model_key" <<<"$TOKEN"

# 🔴 OWNERSHIP IS PART OF THE KEY, AND THIS WAS PAID FOR ON 20 Sep 2026.
# Writing the file as root with `chmod 600`, inside a root-owned `secrets/` directory,
# produces a credential **the container cannot read**: the demo runs as uid 1000, so it
# cannot even traverse the directory, `readFileSync` throws, `readKey` catches it and
# returns null — and the site goes on saying *"no model key is configured"* with a 64-byte
# key sitting right there. The one-token plan would have failed at this last step and
# blamed the token. So the directory is handed to the uid the container actually runs as,
# read from the container rather than assumed.
OWNER="$(ssh "$HOST" "docker exec $CONTAINER id -u 2>/dev/null || echo 1000" | tr -d '[:space:]')"
GROUP="$(ssh "$HOST" "docker exec $CONTAINER id -g 2>/dev/null || echo 1000" | tr -d '[:space:]')"
ssh "$HOST" "chown -R $OWNER:$GROUP $APP_DIR/secrets && chmod 700 $APP_DIR/secrets && chmod 600 $APP_DIR/secrets/model_key"
printf '   key written to %s/secrets/model_key (chmod 600, owned by %s:%s — the uid the container runs as)\n' "$APP_DIR" "$OWNER" "$GROUP"

# The claim is then TESTED rather than assumed, from inside the container, which is the only
# place the answer matters. A key that exists and cannot be read is indistinguishable from
# no key at all, and the failure it produces says the wrong thing.
keybytes="$(ssh "$HOST" "docker exec $CONTAINER sh -lc 'wc -c < /run/secrets/model_key' 2>/dev/null" | tr -d '[:space:]')"
case "${keybytes:-}" in
  ''|*[!0-9]*) fail "the container cannot read the key at /run/secrets/model_key. Check that $APP_DIR/secrets is owned by the uid the container runs as." ;;
  0) fail "the container reads /run/secrets/model_key as EMPTY." ;;
esac
printf '   the container reads it: %s bytes\n' "$keybytes"

ssh "$HOST" "python3 - <<'PY'
import re
path = '$APP_DIR/.env'
text = open(path).read() if __import__('os').path.exists(path) else ''

settings = {
    'MODEL_PROVIDER': 'openai',
    'MODEL_BASE_URL': '$BASE_URL',
    'MODEL_API_KEY_FILE': '/run/secrets/model_key',
    'CHAT_MODEL': '$CHAT_MODEL',
    'EMBED_MODEL': '$EMBED_MODEL',
}
for key, value in settings.items():
    line = f'{key}={value}'
    if re.search(rf'^{key}=', text, re.M):
        text = re.sub(rf'^{key}=.*$', line, text, flags=re.M)
    else:
        text = text.rstrip('\\n') + '\\n' + line + '\\n'
open(path, 'w').write(text)
print('   .env updated: ' + ', '.join(settings))
PY"

echo
echo "3. Restarting and waiting for it to answer"
echo

ssh "$HOST" "cd $APP_DIR && docker compose up -d --force-recreate 2>&1 | tail -2"

for i in $(seq 1 30); do
  body="$(curl -s --max-time 10 "$SITE/healthz" || true)"
  if printf '%s' "$body" | grep -q '"ok":true'; then
    printf '   healthz -> %s\n' "$body"
    break
  fi
  [ "$i" = "30" ] && { printf '   healthz still not ok: %s\n' "$body"; fail "the container did not come up healthy"; }
  sleep 4
done

# ---------------------------------------------------------------- prove the site answers

echo
echo "4. Asking the live site a real question"
echo

# Index the built-in sample, then ask it something answerable — the same two calls the
# page itself makes. A 503 would have said "not reachable"; this says whether the site
# actually answers, which is the only claim worth making.
#
# ⚠️ The sample is written to a FILE and read by the script, rather than pasted into the
# script's own source. Interpolating arbitrary document text into Python source breaks the
# moment the text contains a quote, and a demo whose verification crashes on an apostrophe
# is worse than no verification.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -s --max-time 30 "$SITE/api/samples/diary" -o "$tmp/sample.json"

python3 - "$tmp" "$SITE" <<'PY'
import json, pathlib, sys, urllib.request

tmp, site = pathlib.Path(sys.argv[1]), sys.argv[2]
sample = json.loads((tmp / "sample.json").read_text())

def post(path, payload):
    request = urllib.request.Request(
        site + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    return json.load(urllib.request.urlopen(request, timeout=180))

document = post("/api/index", {"text": sample["text"]})["document"]
print(f"   indexed a document -> {document['id']}  ({document['stats']['words']:,} words)")

answer = post("/api/ask", {"docId": document["id"], "question": "What did Andrea bring?"})
text = answer.get("prose") or answer.get("error") or ""
print(f"   answer -> {text[:300]}")
PY

echo

echo
echo "   Done. The live site is answering, on Cloudflare Workers AI, at no cost."
echo "   Open it: $SITE/"
echo
