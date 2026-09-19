# =============================================================================
# rag — the container.
#
# Two deliberate choices in here.
#
# 1 · `node:24-slim`, not alpine. The app uses Node's OWN SQLite, and on a glibc image
#     that is a stable, well-tested build. `poppler-utils` gives `pdftotext`, which is
#     how a PDF is read — a battle-tested C program rather than a JavaScript parser,
#     and one that costs almost nothing in memory, which matters on a 1 GB host.
#
# 2 · The build stage installs devDependencies and compiles TypeScript; the runtime
#     stage carries only the compiled output and the production tree. TypeScript never
#     ships.
#
# `--experimental-sqlite` is passed on Node 22 and is a harmless no-op on 24; keeping it
# means the same start command works on a laptop and in here.
# =============================================================================

FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json tsconfig.site.json ./
COPY src ./src
COPY site ./site
RUN npm run build


FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4500 \
    HOST=0.0.0.0 \
    DB_PATH=/data/rag.db

# `pdftotext` for reading PDFs. `tini` reaps zombies and passes signals properly, so
# Ctrl-C and `docker stop` shut the server down cleanly rather than killing it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/site ./site

# The database lives on a volume, so a redeploy never loses the indexes already built.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 4500

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4500)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-sqlite", "dist/server.js"]
