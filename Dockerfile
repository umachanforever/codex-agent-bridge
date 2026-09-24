FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/clean-dist.mjs scripts/clean-dist.mjs
COPY src ./src
COPY protocol ./protocol
RUN npm run build
COPY web ./web
RUN npm --prefix web ci && npm run build:web
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
COPY README.md ./
COPY protocol ./protocol
COPY docker/entrypoint.sh docker/healthcheck.mjs ./docker/
RUN mkdir -p /data/codex /data/state /workspace && chown -R node:node /data /workspace
USER node
ENV CODEX_HOME=/data/codex
HEALTHCHECK --interval=30s --timeout=5s --start-period=5m --retries=3 CMD ["node", "docker/healthcheck.mjs"]
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
