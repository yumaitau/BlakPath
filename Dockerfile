# syntax=docker/dockerfile:1.7

###############################################################################
# BlakPath production image — multi-stage build for Next.js 16 standalone.
#
# Stages:
#   base    - pinned Node, OS packages, tini; package managers removed
#   with-pnpm - Corepack pnpm for install, build, and the worker
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

# Node 24 LTS (Krypton). The digest is the multi-arch index for this exact
# build (linux/amd64 and linux/arm64). Bump the version and both digests together.
ARG NODE_VERSION=24.22.1

########################################  base  ###############################
FROM node:${NODE_VERSION}-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
# tini gives us a real init for signal handling; ca-certificates for TLS to
# managed Postgres/Redis/S3. curl is used only by the web HEALTHCHECK; procps
# provides pgrep for the worker HEALTHCHECK. Upgrade first so the worker is
# not stuck on the Alpine snapshot baked into the pinned Node image.
RUN apk upgrade --no-cache \
  && apk add --no-cache tini curl ca-certificates procps
# npm and Yarn ship with the Node image and are unused. Drop them here so the
# base image (and the worker's OS layer) does not carry npm's dependency tree.
# The web runtime repeats this because it starts from a fresh Node image.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app

#####################################  with-pnpm  ############################
FROM base AS with-pnpm
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

########################################  deps  ###############################
FROM with-pnpm AS deps
# Only the manifest + lockfile so this layer caches across source changes.
COPY package.json pnpm-lock.yaml .npmrc .pnpmfile.cjs ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

#######################################  build  ##############################
FROM with-pnpm AS build
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
# Bundle the migrator into the app image so the migrate Job uses the same
# digest as the web release. esbuild is already installed via tsx.
RUN ESBUILD="$(find node_modules/.pnpm -path '*/node_modules/esbuild/bin/esbuild' -type f | sort | tail -1)" \
  && test -n "$ESBUILD" \
  && "$ESBUILD" src/db/migrate.ts \
    --bundle --platform=node --target=node24 --format=cjs --outfile=migrate.cjs
# Plain JS release gate. Runtime images do not ship pnpm, tsx, or the source
# tree, so the pre-deploy Job runs `node release-check.cjs`.
RUN node scripts/build-release-check.mjs
# Build the Next.js standalone server. `output: 'standalone'` is set in
# next.config.ts, producing .next/standalone with a minimal node_modules.
RUN pnpm build

######################################  runtime  #############################
# Keep build tooling (Corepack/pnpm and its transitive dependencies) out of the
# production image. The Node image is pinned by digest above; upgrade Alpine
# packages here so the web runtime is not stuck on that snapshot.
FROM node:${NODE_VERSION}-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime
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
# The RDS global CA is not traced into standalone; copy it so verify-full can
# load certs/rds-global-bundle.pem from the working directory.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# Same digest runs migrations. Layout matches src/db/migrate.ts: migrate.cjs
# reads ./migrations next to itself unless MIGRATIONS_FOLDER is set. It verifies
# the database against the RDS bundle below (cwd-relative, WORKDIR /app).
COPY --from=build --chown=nextjs:nodejs /app/migrate.cjs ./migrate.cjs
COPY --from=build --chown=nextjs:nodejs /app/src/db/migrations ./migrations
COPY --from=build --chown=nextjs:nodejs /app/certs/rds-global-bundle.pem ./certs/rds-global-bundle.pem
COPY --from=build --chown=nextjs:nodejs /app/dist/release-check/release-check.cjs ./release-check.cjs
COPY --from=build --chown=nextjs:nodejs /app/dist/release-check/production-readiness.cjs ./production-readiness.cjs
COPY --from=build --chown=nextjs:nodejs /app/dist/release-check/migration-url.cjs ./migration-url.cjs
# Certificate renderer reads Noto Sans from the working directory. The
# standalone server does not otherwise keep that path.
COPY --from=build --chown=nextjs:nodejs /app/src/domains/certificates/fonts ./src/domains/certificates/fonts

USER nextjs
EXPOSE 3000

# Process liveness only. Dependency failure is readiness (/api/ready), not a
# container restart — otherwise a short RDS or Redis blip restarts the web tier.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/live" || exit 1

# tini as PID 1 → forwards SIGTERM to node → Next flushes and exits cleanly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

######################################  worker  ##############################
# The worker is TypeScript run via tsx (a pinned project dependency). tsx honours
# the tsconfig path aliases (@/*), so the worker can import shared contracts such
# as `@/lib/env` without a separate bundling step.
FROM with-pnpm AS worker
WORKDIR /app

RUN addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs worker

# Full dependency set (tsx lives in devDependencies and is required at runtime
# to execute the TypeScript worker). Install BEFORE setting NODE_ENV, otherwise
# pnpm prunes devDependencies and tsx is missing at runtime.
COPY package.json pnpm-lock.yaml .npmrc .pnpmfile.cjs ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

ENV NODE_ENV=production
# Selects DATABASE_WORKER_POOL_MAX. The web image leaves this unset (web pool).
ENV BLAKPATH_PROCESS=worker

# Only the sources the worker needs: the worker entrypoint, the shared library
# contracts it imports, the DB layer, operational scripts, and tsconfig for
# path alias resolution (@/*) under tsx. The CA bundle is the same file the
# web image verifies against.
COPY --chown=worker:nodejs tsconfig.json ./tsconfig.json
COPY --from=build --chown=worker:nodejs /app/worker ./worker
COPY --from=build --chown=worker:nodejs /app/src ./src
COPY --from=build --chown=worker:nodejs /app/scripts ./scripts
COPY --from=build --chown=worker:nodejs /app/certs/rds-global-bundle.pem ./certs/rds-global-bundle.pem
COPY --from=build --chown=worker:nodejs /app/dist/release-check/release-check.cjs ./release-check.cjs
COPY --from=build --chown=worker:nodejs /app/dist/release-check/production-readiness.cjs ./production-readiness.cjs
COPY --from=build --chown=worker:nodejs /app/dist/release-check/migration-url.cjs ./migration-url.cjs

USER worker

# No exposed port; the worker is not an HTTP service. A process-liveness check
# keeps orchestrators informed without opening a socket.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD pgrep -f "worker/index.ts" > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "exec", "tsx", "worker/index.ts"]
