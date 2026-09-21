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

echo "== the live cookie gate (a real browser, watching the network) =="
node tools/verify-live-consent.mjs

echo
echo "deployed. The browser suite against a local server is: npm run test:e2e"
