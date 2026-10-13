import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, applyRlsRole } from '@/db/rls';
import {
  PLATFORM_CHAIN_TABLES,
  SHARED_READ_TABLES,
  tenantTables,
} from '../helpers/tenant-tables';
import { seedTenantRows, type IsolationIds } from './tenant-rls-seed';

/**
 * Proves the migrated database, not just the SQL text: FORCE RLS is on, and a
 * predicate-less query as `blakpath_app` with org A set returns none of org B.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

function asRows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

integration('postgres row-level security', () => {
  const ids: IsolationIds = {
    orgA: randomUUID(),
    orgB: randomUUID(),
    userId: randomUUID(),
  };
  let tables: readonly string[] = [];
  let sqlClient: {
    unsafe(query: string, parameters?: readonly unknown[]): Promise<unknown>;
  };
  let db: {
    transaction<T>(
      fn: (tx: { execute(query: unknown): Promise<unknown> }) => Promise<T>,
    ): Promise<T>;
  };

  beforeAll(async () => {
    const client = await import('@/db/client');
    sqlClient = client.sqlClient;
    db = client.db;
    const seeded = await seedTenantRows(sqlClient, ids);
    tables = seeded.tables;
  }, 120_000);

  it('forces RLS and installs tenant_isolation on every tenant table', async () => {
    const expected = new Set(tenantTables().map((table) => table.name));
    expect(new Set(tables)).toEqual(expected);

    const classes = asRows(
      await sqlClient.unsafe(
        `select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'`,
      ),
    );
    const byName = new Map(classes.map((row) => [String(row.name), row]));
    const policies = asRows(
      await sqlClient.unsafe(
        `select c.relname as table_name, pol.polname as name,
                pg_get_expr(pol.polqual, pol.polrelid) as using_expr
         from pg_policy pol
         join pg_class c on c.oid = pol.polrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'`,
      ),
    );

    for (const name of expected) {
      const relation = byName.get(name);
      expect(relation?.enabled, name).toBe(true);
      expect(relation?.forced, name).toBe(true);
      const isolation = policies.find(
        (policy) => policy.table_name === name && policy.name === 'tenant_isolation',
      );
      expect(String(isolation?.using_expr ?? ''), name).toContain('app.org_id');
    }

    for (const name of SHARED_READ_TABLES) {
      expect(
        policies.some(
          (policy) => policy.table_name === name && policy.name === 'tenant_shared_read',
        ),
      ).toBe(true);
    }
    for (const name of PLATFORM_CHAIN_TABLES) {
      expect(
        policies.some(
          (policy) => policy.table_name === name && policy.name === 'tenant_shared_read',
        ),
      ).toBe(false);
    }
  });

  it('predicate-less query as the app role returns none of org B', async () => {
    await db.transaction(async (tx) => {
      await applyRlsRole(tx, APP_ROLE, ids.orgA);
      for (const table of tables) {
        const visible = asRows(
          await tx.execute(
            sql.raw(`select organisation_id::text as organisation_id from "${table}"`),
          ),
        );
        const foreign = visible.filter((row) => row.organisation_id === ids.orgB);
        const own = visible.filter((row) => row.organisation_id === ids.orgA);
        expect(foreign, table).toEqual([]);
        expect(own.length, table).toBeGreaterThan(0);
        const platform = visible.filter((row) => row.organisation_id === null);
        if ((PLATFORM_CHAIN_TABLES as readonly string[]).includes(table)) {
          expect(platform, table).toEqual([]);
        }
        if ((SHARED_READ_TABLES as readonly string[]).includes(table)) {
          expect(platform.length, table).toBeGreaterThan(0);
        }
      }
    });
  });
});
