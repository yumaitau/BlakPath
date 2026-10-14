import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Database } from '@/db/client';
import type { TenantScope } from '@/db/tenant-db';
import { requireTenantContext, TenantIsolationError } from '@/lib/tenancy/context';

/**
 * Unit tests that replace `@/db/client` with a fake `db` also need the bound
 * handles (`scopeFor(...).db`, `platformDb`) to reach that fake, because the
 * real ones run on the postgres.js pool. Use from a `vi.mock` factory:
 *
 *   vi.mock('@/db/platform-db', () => import('../helpers/bound-db-mocks').then((m) => m.platformDbModule()));
 *   vi.mock('@/db/tenant-db', () => import('../helpers/bound-db-mocks').then((m) => m.tenantDbModule()));
 */
async function mockedDb(): Promise<Database> {
  const client = await import('@/db/client');
  return client.db;
}

export async function platformDbModule(): Promise<{ platformDb: Database }> {
  return { platformDb: await mockedDb() };
}

export function scopeOver(database: Database, organisationId: string): TenantScope {
  return {
    organisationId,
    db: database,
    where(orgColumn: PgColumn, ...extra: Array<SQL | undefined>) {
      const predicates = extra.filter((p): p is SQL => p !== undefined);
      return and(eq(orgColumn, organisationId), ...predicates) as SQL;
    },
    assertOwned(row) {
      if (row && row.organisationId !== organisationId) {
        throw new TenantIsolationError('Row does not belong to the active tenant scope.');
      }
      return row;
    },
    insertValues(values) {
      return { ...values, organisationId };
    },
  };
}

export async function tenantDbModule() {
  const database = await mockedDb();
  const scopeFor = (organisationId: string) => scopeOver(database, organisationId);
  return {
    scopeFor,
    currentScope: () => scopeFor(requireTenantContext().organisationId),
    assertTenant(expected: string, actual: string) {
      if (expected !== actual) throw new TenantIsolationError('Tenant mismatch');
    },
  };
}
