import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import 'dotenv/config';
import {
  applyAuditAppPrivileges,
  applyAuditAppendOnlyGuard,
  DEFAULT_AUDIT_APP_ROLE,
} from './audit-guard';
import { resolveMigrationDatabaseUrl } from './migration-url';
import {
  loadMigrationFiles,
  resolveMigrationTimeouts,
  runMigrations,
  type MigrationClient,
} from './migrator';

/**
 * Migration entrypoint for `pnpm db:migrate` and the release migrate Job.
 * The Job runs this file from the app image (`node /app/migrate.cjs`) with
 * `DATABASE_MIGRATION_URL` — the owner role, never the application role.
 */
async function main(): Promise<void> {
  const url = resolveMigrationDatabaseUrl(process.env);
  const role = process.env.AUDIT_DB_APP_ROLE || DEFAULT_AUDIT_APP_ROLE;
  const timeouts = resolveMigrationTimeouts(process.env);
  const folder =
    process.env.MIGRATIONS_FOLDER ??
    fileURLToPath(new URL('./migrations', import.meta.url));
  const migrations = loadMigrationFiles(folder);
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 30,
    connection: { application_name: 'blakpath-migrate' },
  });
  try {
    console.log('[migrate] applying migrations…');
    await runMigrations(sql as unknown as MigrationClient, migrations, timeouts);
    console.log('[migrate] enforcing append-only audit guards…');
    await applyAuditAppendOnlyGuard((statement) => sql.unsafe(statement));
    await applyAuditAppPrivileges(sql, {
      role,
      required: process.env.NODE_ENV === 'production',
    });
    console.log('[migrate] done');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
