# Database migrations

Migrations ship inside the app image and run as `blakpath_migrator` before web
or worker pods roll. The application connects as `blakpath_app` and cannot
change the schema. `docs/eks-runbook.md` is the release and rollback procedure.

## Roles

`infra/postgres/audit-roles.sql` creates the split. Apply it once as the RDS
master before the first production migrate.

- `blakpath_migrator` owns the tables and runs `src/db/migrate.ts`.
- `blakpath_app` has `SELECT`, `INSERT`, `UPDATE`, `DELETE` and sequence usage,
  granted by the migrate run itself. On `audit_events` and
  `audit_integrity_checkpoints` it has `SELECT` and `INSERT` only.
- The migrator URL is Secrets Manager `/blakpath/production/migrator`, synced
  to Secret `blakpath-migrator`, mounted only on the migrate Job.
- The Job reads `DATABASE_MIGRATION_URL`. In production it refuses to run
  when that URL is missing or uses the same role as `DATABASE_URL`.
- `DATABASE_URL` on web and worker is the app role. `pnpm release:check` fails
  if `DATABASE_URL` is not the app role.

Local development and CI keep using the single Compose/Postgres superuser.
`pnpm db:migrate` falls back to `DATABASE_URL` when `NODE_ENV` is not
`production` and `DATABASE_MIGRATION_URL` is unset.

## Timeouts

Every migration session sets:

- `lock_timeout` 4 seconds (`MIGRATION_LOCK_TIMEOUT_MS`, maximum 4000)
- `statement_timeout` 10 minutes (`MIGRATION_STATEMENT_TIMEOUT_MS`)

A statement that cannot get its lock aborts in under five seconds. The Job's
`backoffLimit` is 0, so the release stops instead of waiting. Raise the
statement timeout for a large concurrent index build. Do not raise the lock
timeout past 4 seconds.

## How a file runs

The runner reads `src/db/migrations/meta/_journal.json` and stores the same
sha256 and `created_at` as Drizzle in `drizzle.__drizzle_migrations`. It does
not wrap every pending file in one transaction.

- Ordinary statements for one file commit together.
- A statement runs outside a transaction when it contains `CONCURRENTLY`,
  `VALIDATE CONSTRAINT`, or a `-- @no-transaction` comment.
- Progress is recorded per statement, so a retry skips statements that already
  committed. Concurrent indexes must say `IF NOT EXISTS`. `VALIDATE CONSTRAINT`
  is safe to repeat. If `CREATE INDEX CONCURRENTLY` fails halfway, Postgres
  leaves an invalid index: drop that index concurrently, then retry.
- A second migrate takes `pg_try_advisory_lock` and exits if one is already
  running.

## Expand, then contract

Release N-1 must run on schema N. New SQL is linted. Migrations `0000`–`0034`
are grandfathered, including the foreign keys in `0015` and `0016` that were
added to existing tables without `NOT VALID` and the plain indexes on existing
tables in `0028` and `0032`. Do not edit those files.

Allowed in the release that introduces a change:

- New table.
- New nullable column, or `NOT NULL` with a `DEFAULT`.
- Index on a new table.
- On an existing table: `CREATE INDEX CONCURRENTLY IF NOT EXISTS`.
- Foreign key on an existing table: `ADD CONSTRAINT … NOT VALID`, then
  `VALIDATE CONSTRAINT` in the same file.

Not allowed until a later release, after N-1 is no longer running:

- `DROP TABLE`, `DROP COLUMN`, `RENAME COLUMN`, `RENAME TO`.
- `SET NOT NULL` (backfill first, enforce next release).
- A type change that rejects a value the previous release still writes.

Example:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS applications_status_idx
  ON applications (status);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id")
  ON DELETE set null NOT VALID;--> statement-breakpoint
ALTER TABLE "applications" VALIDATE CONSTRAINT "applications_client_id_fkey";
```

`VALIDATE CONSTRAINT` and `CONCURRENTLY` run outside the migration transaction.

## Drift and push

CI runs `pnpm db:drift`: `drizzle-kit check`, then `drizzle-kit generate`.
A generated file fails the job. Edit `src/db/schema`, run `pnpm db:generate`,
and commit the migration. Do not hand-edit snapshots.

`pnpm db:push` runs `drizzle-kit push` only for a loopback `DATABASE_URL`.
Any other host is refused.

## Rollback

Forward only. Redeploy the previous app and worker digests. Do not down-migrate.
Use point-in-time recovery only when data was corrupted, and only into a new
namespace. Steps are in `docs/eks-runbook.md` under Rollback. A disposable
Postgres rehearsal is recorded in
`docs/migration-drills/2026-10-13-disposable-postgres.md`. Staging still needs
one human rehearsal of those steps.
