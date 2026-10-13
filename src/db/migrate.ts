import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import 'dotenv/config';
import { ensureRlsRoles } from './rls-roles';

/**
 * Migration entrypoint used by the Docker migration init container and
 * `pnpm db:migrate`. Uses a dedicated single-connection client that is closed
 * on completion so the process exits cleanly.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations');

  const sql = postgres(url, { max: 1 });
  try {
    const database = drizzle(sql, { casing: 'snake_case' });

    // CREATE ROLE cannot run inside the transaction drizzle wraps migrations in.
    console.log('[migrate] ensuring row-level security roles…');
    await ensureRlsRoles(sql);

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
