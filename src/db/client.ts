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
    // Prepared statements are planned as the role that first executes them.
    // Tenant and platform work SET LOCAL ROLE on pooled connections, so a
    // cached plan would outlive the role change. Unprepared queries re-plan.
    prepare: false,
  });

if (env.NODE_ENV !== 'production') {
  globalForDb.__blakpathSql = client;
}

export const db = drizzle(client, { schema, casing: 'snake_case' });
export type Database = typeof db;
export { client as sqlClient };
export { schema };
