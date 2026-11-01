# syntax=docker/dockerfile:1.7
# Multi-target build. Targets:
#   server    - control plane + built dashboard on :3001
#   runner    - Playwright runner agent (official Playwright image, browsers included)
#   mock-app  - demo target app with seeded bugs on :3000

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble
ARG PNPM_VERSION=12.14.0

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV CI=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
# Manifests first so dependency installation is cached between source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/runner/package.json apps/runner/
COPY apps/dashboard/package.json apps/dashboard/
COPY examples/mock-target-app/package.json examples/mock-target-app/
RUN pnpm install --frozen-lockfile --ignore-scripts=false
COPY . .
RUN pnpm --filter @ghostiq/shared build \
 && pnpm --filter @ghostiq/server build \
 && pnpm --filter @ghostiq/runner build \
 && pnpm --filter @ghostiq/dashboard build

# --------------------------------------------------------------- server
FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production \
    PORT=3001 \
    DATABASE_URL=file:/data/ghostiq.db \
    GHOSTIQ_SCREENSHOT_DIR=/data/screenshots \
    GHOSTIQ_ARTIFACT_DIR=/data/artifacts \
    GHOSTIQ_DASHBOARD_DIR=/app/apps/dashboard/dist
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/server
# Sync schema, ensure the demo project exists, then start.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js db push && node node_modules/tsx/dist/cli.mjs src/seed.ts && node dist/index.js"]

# --------------------------------------------------------------- runner
FROM ${PLAYWRIGHT_IMAGE} AS runner
ENV NODE_ENV=production \
    GHOSTIQ_SERVER_URL=http://server:3001
WORKDIR /app
COPY --from=build /app /app
USER pwuser
WORKDIR /app/apps/runner
CMD ["node", "dist/index.js"]

# ------------------------------------------------------------- mock-app
FROM ${NODE_IMAGE} AS mock-app
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 3000
WORKDIR /app/examples/mock-target-app
CMD ["node", "server.js"]
