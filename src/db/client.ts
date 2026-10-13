import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/lib/env';
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

const client =
  globalForDb.__blakpathSql ??
  postgres(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    // Lets the worker report pool usage per workload without listing every
    // connection string. Web and worker set distinct OTEL_SERVICE_NAME values.
    connection: {
      application_name: env.OTEL_SERVICE_NAME,
    },
  });

if (env.NODE_ENV !== 'production') {
  globalForDb.__blakpathSql = client;
}

export const db = drizzle(client, { schema, casing: 'snake_case' });
export type Database = typeof db;
export { client as sqlClient };
export { schema };
