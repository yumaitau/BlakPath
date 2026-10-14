import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import 'dotenv/config';
import {
  applyAuditAppPrivileges,
  applyAuditAppendOnlyGuard,
  DEFAULT_AUDIT_APP_ROLE,
} from './audit-guard';
import { resolveMigrationDatabaseUrl } from './migration-url';
import { postgresClientOptions } from './postgres-options';

/**
 * Migration entrypoint used by the Docker migration init container and
 * `pnpm db:migrate`. Uses a dedicated single-connection client that is closed
 * on completion so the process exits cleanly.
 */
async function main() {
  const url = resolveMigrationDatabaseUrl(process.env);
  const role = process.env.AUDIT_DB_APP_ROLE || DEFAULT_AUDIT_APP_ROLE;

  const sql = postgres(
    url,
    postgresClientOptions({ role: 'migrate', poolMax: 1, databaseUrl: url }),
  );
  try {
    const database = drizzle(sql, { casing: 'snake_case' });

    console.log('[migrate] applying migrations…');
    await migrate(database, { migrationsFolder: './src/db/migrations' });
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

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
