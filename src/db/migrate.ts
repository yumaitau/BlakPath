import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import 'dotenv/config';
import {
  loadMigrationFiles,
  resolveMigratorUrl,
  resolveMigrationTimeouts,
  runMigrations,
  type MigrationClient,
} from './migrator';

/**
 * Migration entrypoint for `pnpm db:migrate` and the release migrate Job.
 * The Job runs this file from the app image (`node /app/migrate.cjs`) with
 * `DATABASE_MIGRATOR_URL` — the owner role, never the application role.
 */
async function main(): Promise<void> {
  const url = resolveMigratorUrl(process.env);
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
    console.log('[migrate] done');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
