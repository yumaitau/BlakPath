# Local development

This guide gets BlakPath running locally. The local stack mirrors production
choices where it matters (Postgres, Redis, S3-compatible storage, ClamAV) so
security-relevant behaviour — tenant isolation, quarantine/scan, audit — behaves
the same on your machine as in `ap-southeast-2`.

## Prerequisites

- **Node.js** `24.21.0` (see `.nvmrc`; engines require `>= 24.21.0`)
- **pnpm** `9` (`packageManager: pnpm@9.12.0`) — `corepack enable` will pin it
- **Docker** + **Docker Compose** (for Postgres, Redis, MinIO, ClamAV, Mailpit)
- **OpenSSL** (to generate secrets)

## Environment

Copy the template and fill it in:

```bash
cp .env.example .env
```

Generate the two secrets you must not leave at their placeholder values:

```bash
openssl rand -base64 48   # BETTER_AUTH_SECRET  (>= 32 chars required)
openssl rand -base64 32   # ENCRYPTION_MASTER_KEY (base64-encoded 32-byte key)
```

Configuration is validated centrally by `src/lib/env.ts` (Zod). The process
**fails fast** with a list of offending keys (never values) if anything is
missing or malformed — so an invalid `.env` will not boot silently. Always import
`{ env }` from `@/lib/env`; never read `process.env` directly (the only
exceptions are `src/db/migrate.ts` and instrumentation).

Key local defaults (see `.env.example`):

| Variable                                      | Local value                                            | Notes                                          |
| --------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `DATABASE_URL`                                | `postgres://blakpath:blakpath@localhost:5432/blakpath` | Postgres                                       |
| `REDIS_URL`                                   | `redis://localhost:6379`                               | Queues / ephemeral state                       |
| `S3_ENDPOINT`                                 | `http://localhost:9000`                                | MinIO (S3-compatible)                          |
| `S3_BUCKET_EVIDENCE` / `S3_BUCKET_QUARANTINE` | `blakpath-evidence` / `blakpath-quarantine`            | Evidence lifecycle                             |
| `CLAMAV_HOST:PORT`                            | `localhost:3310`                                       | Malware scanning                               |
| `SMTP_HOST:PORT`                              | `localhost:1025`                                       | Mailpit (catches all mail)                     |
| `AI_FEATURES_ENABLED`                         | `false`                                                | Off by default — must never decide/score/infer |

## Local services (Docker)

Bring up the supporting services:

```bash
docker compose up -d      # Postgres, Redis, MinIO, ClamAV, Mailpit
docker compose ps         # check health
docker compose logs -f    # tail logs
```

Local endpoints you'll use:

- **Postgres** — `localhost:5432`
- **Redis** — `localhost:6379`
- **MinIO** — API `localhost:9000`, console `localhost:9001`
- **ClamAV** — `localhost:3310`
- **Mailpit** — SMTP `localhost:1025`, web UI `localhost:8025`

## Database setup

```bash
pnpm db:migrate     # apply migrations (tsx src/db/migrate.ts)
pnpm db:seed        # seed permission catalogue, system roles, dev org/user
```

`pnpm db:seed` creates the local administrator only when `ALLOW_DEV_SEED=1`
and `DATABASE_URL` points at `localhost`, `127.0.0.1`, or `::1`. Copying
`.env.example` sets the flag. A non-local database fails the command.

The non-production seed prints two synthetic test accounts. The administrator
combines the operational roles needed to exercise every staff screen locally.
The spare staff account starts with no organisation membership so the Playwright
suite can verify role assignment, suspension, restoration and revocation. These
development-only role combinations are never a production onboarding model.

Working on the schema:

```bash
pnpm db:generate    # generate a migration from schema changes (drizzle-kit)
pnpm db:studio      # browse data in Drizzle Studio
```

Schema lives in `src/db/schema/*`. Remember: every table must be re-exported from
`src/db/schema/index.ts`, or it is invisible to the query builder and to
migration generation. Define columns with camelCase TS names — the snake_case
mapper handles DB naming (`casing: 'snake_case'`).

## Running the app

Run the web app and the background worker in separate shells:

```bash
pnpm dev            # Next.js app  → http://localhost:3000
pnpm worker:dev     # BullMQ worker (watch mode)
```

The worker handles evidence scanning, email, audit-integrity verification and
retention jobs (`docs/architecture.md`). For end-to-end flows that touch evidence
or email, keep it running.

## Common commands

| Command                                                | Purpose                                     |
| ------------------------------------------------------ | ------------------------------------------- |
| `pnpm dev`                                             | Run the app in development                  |
| `pnpm worker:dev`                                      | Run the worker in watch mode                |
| `pnpm build` / `pnpm start`                            | Production build / start                    |
| `pnpm typecheck`                                       | `tsc --noEmit` (strict; run before pushing) |
| `pnpm lint` / `pnpm lint:fix`                          | ESLint                                      |
| `pnpm format` / `pnpm format:check`                    | Prettier                                    |
| `pnpm test` / `pnpm test:watch`                        | Vitest unit + integration                   |
| `pnpm test:e2e`                                        | Playwright e2e                              |
| `pnpm test:live`                                       | Disposable full-service Playwright drill    |
| `pnpm test:restore`                                    | Disposable backup and restore exercise      |
| `pnpm db:migrate` / `pnpm db:seed`                     | Migrate / seed                              |
| `pnpm db:generate` / `pnpm db:push` / `pnpm db:studio` | Drizzle Kit tools                           |

## Testing

- **Unit & integration** run under **Vitest** (`vitest.config.ts`). Includes
  `tests/unit/**`, `tests/integration/**` and co-located `src/**/*.test.ts`;
  environment is `node`; `@` and `@worker` path aliases are configured.
- **E2E** runs under **Playwright** (`pnpm test:e2e`) and covers public/auth
  boundaries, tenant selection, applications, board persistence, meetings
  import/export, the full public-form lifecycle, membership/role changes,
  account security, sign-out and automated accessibility acceptance.
- **Live-stack E2E** (`pnpm test:live`) starts a disposable Compose project on
  isolated high ports, migrates and seeds its database, and proves real sign-in,
  MinIO quarantine, ClamAV promotion, worker queues, Mailpit delivery and public
  form submission. It removes only its own containers and volumes when finished.
- **Isolation tests are release gates.** The tenant-isolation test suite
  (`docs/tenant-isolation.md`) must pass — treat a failure there as a blocker.
- **Accessibility.** `axe-core` is available for WCAG 2.2 AA checks in tests.

## Troubleshooting

- **"Invalid environment configuration".** `src/lib/env.ts` rejected your `.env`;
  the error lists the failing keys. Common causes: `BETTER_AUTH_SECRET` shorter
  than 32 chars, or `ENCRYPTION_MASTER_KEY` not a base64 32-byte key. Regenerate
  with the `openssl` commands above.
- **DB connection refused / migrations fail.** Ensure `docker compose ps` shows
  Postgres healthy and `DATABASE_URL` matches. `pnpm db:migrate` uses a dedicated
  single connection and exits cleanly on success.
- **Uploads never become downloadable.** By design — a file stays in quarantine
  until ClamAV scans it clean. Check ClamAV is up (`localhost:3310`) and the
  worker is running. If the scanner is down, files **correctly** remain
  quarantined (fail-secure; `docs/evidence-scanning-design.md`).
- **No emails arriving.** Local mail is caught by Mailpit — open its web UI at
  `localhost:8025` instead of expecting real delivery.
- **Redis / queue jobs not processing.** Confirm Redis is up and `pnpm worker:dev`
  is running; the app enqueues, the worker consumes.
- **Type or lint errors before pushing.** Run `pnpm typecheck` and `pnpm lint`;
  the project is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` — use `import type` for type-only imports).
