# syntax=docker/dockerfile:1.7

###############################################################################
# BlakPath production image — multi-stage build for Next.js 16 standalone.
#
# Stages:
#   base    - pinned Node + pnpm, tini for signal handling
#   deps    - full dependency install (cached on lockfile)
#   build   - compile Next.js standalone output + the worker
#   runner  - minimal, non-root runtime for the web server
#   worker  - minimal, non-root runtime for the BullMQ worker
#
# Security posture:
#   - Non-root user (uid 1001) in every runtime stage.
#   - No secrets are baked in; all config is injected at runtime via env_file /
#     secret manager (see docker-compose.prod.example.yml).
#   - Only production artefacts are copied into the runtime images.
#   - tini as PID 1 for correct SIGTERM propagation → graceful shutdown.
###############################################################################

ARG NODE_VERSION=20

########################################  base  ###############################
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
# tini gives us a real init for signal handling; ca-certificates for TLS to
# managed Postgres/Redis/S3. curl is used only by the web HEALTHCHECK; procps
# provides pgrep for the worker HEALTHCHECK.
RUN apk add --no-cache tini curl ca-certificates procps
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

########################################  deps  ###############################
FROM base AS deps
# Only the manifest + lockfile so this layer caches across source changes.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

#######################################  build  ##############################
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
# Next.js evaluates route handlers while collecting page data. These arguments
# are supplied by CI (and should be supplied by production image builds) so
# validation can run without baking runtime secrets into the final image.
ARG DATABASE_URL
ARG REDIS_URL
ARG BETTER_AUTH_SECRET
ARG ENCRYPTION_MASTER_KEY
ARG S3_ACCESS_KEY_ID
ARG S3_SECRET_ACCESS_KEY
ENV DATABASE_URL=${DATABASE_URL} \
    REDIS_URL=${REDIS_URL} \
    BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET} \
    ENCRYPTION_MASTER_KEY=${ENCRYPTION_MASTER_KEY} \
    S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID} \
    S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build the Next.js standalone server. `output: 'standalone'` is set in
# next.config.ts, producing .next/standalone with a minimal node_modules.
RUN pnpm build

######################################  runtime  #############################
# Keep build tooling (Corepack/pnpm and its transitive dependencies) out of the
# production image. The floating Node 20 Alpine tag receives security updates;
# the application remains constrained by package.json's Node >=20.11 engine.
FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk upgrade --no-cache \
  && apk add --no-cache tini curl ca-certificates
# npm, Corepack, and Yarn are build tooling; the standalone server executes
# directly with node. Removing them avoids shipping their unused dependency
# trees in the production image.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /opt/yarn* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app

######################################  runner  ##############################
FROM runtime AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# Non-root runtime user.
RUN addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs nextjs

# Next.js standalone: server + only the node_modules it actually needs.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Liveness/readiness probe hitting the app health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# tini as PID 1 → forwards SIGTERM to node → Next flushes and exits cleanly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

######################################  worker  ##############################
# The worker is TypeScript run via tsx (a pinned project dependency). tsx honours
# the tsconfig path aliases (@/*), so the worker can import shared contracts such
# as `@/lib/env` without a separate bundling step.
FROM base AS worker
WORKDIR /app

RUN addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs worker

# Full dependency set (tsx lives in devDependencies and is required at runtime
# to execute the TypeScript worker). Install BEFORE setting NODE_ENV, otherwise
# pnpm prunes devDependencies and tsx is missing at runtime.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

ENV NODE_ENV=production

# Only the sources the worker needs: the worker entrypoint, the shared library
# contracts it imports, the DB layer, and tsconfig for path resolution.
COPY --chown=worker:nodejs tsconfig.json ./tsconfig.json
COPY --from=build --chown=worker:nodejs /app/worker ./worker
COPY --from=build --chown=worker:nodejs /app/src ./src

USER worker

# No exposed port; the worker is not an HTTP service. A process-liveness check
# keeps orchestrators informed without opening a socket.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD pgrep -f "worker/index.ts" > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "exec", "tsx", "worker/index.ts"]
