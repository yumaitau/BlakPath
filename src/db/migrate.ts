import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import 'dotenv/config';
import { postgresClientOptions } from './postgres-options';

/**
 * Migration entrypoint used by the Docker migration init container and
 * `pnpm db:migrate`. Uses a dedicated single-connection client that is closed
 * on completion so the process exits cleanly.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations');

  const sql = postgres(
    url,
    postgresClientOptions({ role: 'migrate', poolMax: 1, databaseUrl: url }),
  );
  try {
    const database = drizzle(sql, { casing: 'snake_case' });

    console.log('[migrate] applying migrations…');
    await migrate(database, { migrationsFolder: './src/db/migrations' });

    console.log('[migrate] done');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
