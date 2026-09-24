#!/usr/bin/env bash
#
# Build, test, publish, purge, smoke-check — the deploy for rag-demo.
#
# There is no auto-deploy on this repo, so this script IS the deploy. It exists
# because of a measured failure on 21 September 2026: a finished, tested change
# to the cookie panel sat in the working tree from 11:33 to 17:35 — uncommitted,
# unbuilt and therefore undeployed — while the live site went on showing the
# owner's counting row to every visitor. Nothing was broken; nobody had been told
# to ship it. A script that ends with the live gate answers that in one command.
#
# The publish step is NOT an rsync: the app runs in a container on `dvs-sites`
# from `/opt/rag`, so the artefact is an image. It is built here and shipped with
# `docker save | docker load`, because that host has 1 GB of RAM shared with nine
# other sites and a TypeScript build on it is a risk with no upside.
#
# The app sets `no-store` itself on every static file and every API response, and
# the Caddy block sets it only when the app has not — so this asserts ONE header
# on both the shell and a bundle, not merely the presence of a no-store.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "⚠  the working tree has uncommitted changes — this deploy is shipping something"
  echo "   that is not in git. That is allowed; it is just worth knowing. Files:"
  git status --short | sed 's/^/     /'
fi

# 🔴 THE FAULT REPORT'S TWO TOKENS, PLACED AS FILES ON THE HOST BEFORE THE IMAGE IS
# PUBLISHED. A file rather than an environment variable, for the same reason the model
# key is a file: a value in the environment is visible to anything that can inspect the
# container or its process list, and it is copied into every child process. The values
# are never printed here, or in the smoke check, or in the Rollbar report.
place_secret() {
  local local_file="$1" remote_name="$2"
  if [ ! -s "$local_file" ]; then
    echo "  ⚠ no $remote_name at $local_file — page faults will be dropped, and the app will"
    echo "    say so exactly once in its log (that is the line that makes a missing token visible)"
    return 0
  fi
  ssh dvs-sites "install -m 600 /dev/stdin /opt/rag/secrets/$remote_name" < "$local_file"
  # 🔴 AND THE OWNER MATTERS — MEASURED ON THE FIRST DEPLOY, 24 SEPTEMBER 2026. The ssh
  # session to that host runs as ROOT, so `install` leaves the file root:root 600 — and the
  # container runs as `node`, uid 1000, which then cannot read it. Nothing fails loudly
  # when that happens: the app starts, reads an empty token, and drops every page fault
  # with one line in its log. It looks deployed and is not.
  ssh dvs-sites "chown 1000:1000 /opt/rag/secrets/$remote_name"
  # And then the file is read AS THE CONTAINER'S OWN USER, because "it is on disk" and
  # "the process can read it" are different claims and only the second one means anything.
  # The value is never printed — the byte count is the whole check.
  readable=$(ssh dvs-sites "docker exec -u node rag sh -c 'wc -c < /run/secrets/$remote_name'" 2>/dev/null || echo 0)
  echo "  $remote_name placed, mode 600, readable as the container's own user: $readable byte(s)"
  [ "$readable" -ge 32 ] || echo "  ⚠ the container cannot read $remote_name — page faults will be dropped"
}

# 🔴 AND THE APP IS TOLD WHERE THEY ARE, NOT WHAT THEY ARE. If the compose file on the
# droplet does not name the two *_FILE variables, the tokens sit on disk and nothing
# reads them — a silent no-op, which is exactly the failure this whole feature exists to
# make impossible. So the count is printed and a zero is loud.
echo "== the fault report's credentials =="
place_secret "$HOME/Documents/secrets/.rollbar_rag_demo_page_token" rollbar_page_token
place_secret "$HOME/Documents/secrets/.rollbar_rag_demo_server_token" rollbar_server_token
named=$(ssh dvs-sites 'grep -c "ROLLBAR_PAGE_TOKEN_FILE\|ROLLBAR_SERVER_TOKEN_FILE" /opt/rag/docker-compose.yml || true')
printf '  %-24s %s\n' "docker-compose.yml" "$named token file variable(s) named"
[ "$named" -ge 2 ] || echo "  ⚠ the droplet's compose names fewer than two token files, so a token on disk is not read"

echo "== build =="
npm run build

echo "== tests: the repo's own suite (build + 13 files, node's runner) =="
npm test

echo "== image =="
docker build -t rag:latest .

echo "== publish =="
docker save rag:latest | gzip -1 | ssh dvs-sites 'gunzip | docker load'
ssh dvs-sites 'cd /opt/rag && docker compose up -d'
ssh dvs-sites 'docker ps --filter name=rag --format "  {{.Names}} {{.Image}} {{.Status}}"'

echo "== purge the CDN =="
(cd ~/Documents/git/gitlab.com/datavisionstudios/docker-compose-master &&
 .venv/bin/python3 ~/.cloudflare_purge.py --files \
   https://rag-demo.nodejavascript.com/ \
   https://rag-demo.nodejavascript.com/app.js \
   https://rag-demo.nodejavascript.com/consent.js \
   https://rag-demo.nodejavascript.com/index.html)

echo "== smoke check =="
for path in / /app.js /consent.js /styles.css /robots.txt /sitemap.xml /manifest.webmanifest; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://rag-demo.nodejavascript.com$path")
  printf '  %-24s %s\n' "$path" "$code"
  [ "$code" = "200" ] || { echo "FAILED: $path returned $code"; exit 1; }
done

# Exactly one Cache-Control per file. Two is the bug this shipped once already:
# a plain `header` line in Caddy ADDED a second one and /app.js went out carrying
# no-store AND public, max-age=300 at the same time.
for path in / /app.js; do
  n=$(curl -sI "https://rag-demo.nodejavascript.com$path" | grep -ci '^cache-control' || true)
  value=$(curl -sI "https://rag-demo.nodejavascript.com$path" | grep -i '^cache-control' | tr -d '\r' | head -1)
  printf '  %-24s %s header(s): %s\n' "$path" "$n" "$value"
  [ "$n" = "1" ] || { echo "FAILED: $path carries $n Cache-Control headers, not one"; exit 1; }
done

# /healthz is an HONEST 503 when no model key is mounted — the page still loads and
# says so, which is the intended behaviour. So report it, do not fail on it.
printf '  %-24s %s\n' "/healthz" "$(curl -s -o /dev/null -w '%{http_code}' https://rag-demo.nodejavascript.com/healthz)"

# 🔴 THE FAULT ENDPOINT, PROBED AGAINST THE LIVE SITE, WITH A PAYLOAD THAT CREATES NO
# ITEM. The body carries no message, so the relay refuses it before any request is made
# — and the endpoint must still answer 204, because accepted, refused, throttled and
# garbage look the same from outside deliberately. A 200, a 400 or a 500 here means the
# route is wrong, and a monitoring endpoint that answers the wrong code is worse than
# none: the page's reporter would look like it was working.
fault_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{"route":"/","message":""}' \
  https://rag-demo.nodejavascript.com/api/fault)
printf '  %-24s %s\n' "/api/fault" "$fault_code"
[ "$fault_code" = "204" ] || { echo "FAILED: /api/fault returned $fault_code, not 204"; exit 1; }

# 🔴 THE BROWSER SUITE RUNS HERE TOO, AND THE LAST TWO CHECKS RUN AGAINST THE LIVE SITE — because on
# 22 September 2026 a colour helper threw inside the composition renderer and **hid all three charts
# on step 2 at once, silently.** `npm test` cannot see it (no browser), and this repo's browser suite
# skips every test that needs a model — indexing needs one, and the key is on the droplet. So the
# check that would have caught it has to run where the model is, which is here.
echo "== the browser suite, against a local server =="
npm run test:e2e

echo "== the live cookie gate (a real browser, watching the network) =="
node tools/verify-live-consent.mjs

echo "== the live charts (a real browser, indexing a document on the deployed site) =="
node tools/verify-live-charts.mjs

# 🔴 TELL ROLLBAR WHICH REVISION WENT OUT, AND THIS IS THE TIME A FIX IS JUDGED
# AGAINST. George's rule of 23 September 2026 is that an item resolved after a deploy
# must not come back, and "after" means after this line. It cannot fail the deploy: see
# tools/report-deploy.mjs.
node tools/report-deploy.mjs --revision "$(git rev-parse HEAD)" ||
  echo "  (the Rollbar deploy report was skipped — the site is deployed regardless)"

echo
echo "deployed."
