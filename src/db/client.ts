import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/lib/env';
import { postgresClientOptions } from './postgres-options';
import * as schema from './schema';

/**
 * Low-level database client.
 *
 * Prefer the tenant-aware helpers in `src/db/tenant-db.ts` for any access to
 * tenant-owned data. Use this raw client only for auth, platform-level tables,
 * migrations and background infrastructure that operate outside a tenant
 * context.
 */
const globalForDb = globalThis as unknown as {
  __blakpathSql?: ReturnType<typeof postgres>;
};

const poolMax =
  env.BLAKPATH_PROCESS === 'worker'
    ? env.DATABASE_WORKER_POOL_MAX
    : env.DATABASE_POOL_MAX;

const client =
  globalForDb.__blakpathSql ??
  postgres(
    env.DATABASE_URL,
    postgresClientOptions({
      role: env.BLAKPATH_PROCESS,
      poolMax,
      databaseUrl: env.DATABASE_URL,
    }),
  );

if (env.NODE_ENV !== 'production') {
  globalForDb.__blakpathSql = client;
}

export const db = drizzle(client, { schema, casing: 'snake_case' });
export type Database = typeof db;
export { client as sqlClient };
export { schema };
