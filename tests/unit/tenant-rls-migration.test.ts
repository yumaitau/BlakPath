import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import {
  PLATFORM_CHAIN_TABLES,
  SHARED_READ_TABLES,
  migrationSql,
  tenantTables,
} from '../helpers/tenant-tables';

const POLICY =
  'AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id))';

/**
 * Fails when a table with an `organisation_id` column has no RLS policy, in
 * the Drizzle schema or in the committed migrations. A new tenant table needs
 * `tenantIsolationPolicy()` + `.enableRLS()` in its schema and a hand-written
 * `FORCE ROW LEVEL SECURITY` in its migration.
 */
describe('tenant RLS coverage', () => {
  const tables = tenantTables();
  const sql = migrationSql();

  it('every schema table with organisation_id enables RLS with tenant_isolation', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      if (!config.columns.some((column) => column.name === 'organisation_id')) continue;
      seen += 1;
      const isolation = config.policies.find(
        (policy) => policy.name === 'tenant_isolation',
      );
      if (!config.enableRLS || !isolation || isolation.for !== 'all') {
        missing.push(config.name);
      }
    }
    expect(seen).toBe(tables.length);
    expect(seen).toBeGreaterThanOrEqual(60);
    expect(missing).toEqual([]);
  });

  it('migrations enable, force and install tenant_isolation on every tenant table', () => {
    const missing: string[] = [];
    for (const table of tables) {
      const enable = `ALTER TABLE "${table.name}" ENABLE ROW LEVEL SECURITY`;
      const force = `ALTER TABLE "${table.name}" FORCE ROW LEVEL SECURITY`;
      const policy = `CREATE POLICY "tenant_isolation" ON "${table.name}" ${POLICY}`;
      if (!sql.includes(enable) || !sql.includes(force) || !sql.includes(policy)) {
        missing.push(table.name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('defines the policy function with the bypass first and tenant match last', () => {
    const start = sql.indexOf(
      'CREATE OR REPLACE FUNCTION blakpath_rls_allows(row_org uuid)',
    );
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf('$rls$;', start));
    expect(body).toContain('STABLE');
    expect(body).not.toMatch(/SECURITY DEFINER/i);
    expect(body).toMatch(
      /current_setting\('app\.bypass_rls', true\) = 'on' THEN true[\s\S]*ELSE row_org = pg_catalog\.current_setting\('app\.org_id', true\)::uuid/,
    );
  });

  it('shares null-org reads only for roles and feature flags', () => {
    for (const table of tables) {
      const shared = (SHARED_READ_TABLES as readonly string[]).includes(table.name);
      const present = sql.includes(
        `CREATE POLICY "tenant_shared_read" ON "${table.name}" AS PERMISSIVE FOR SELECT TO public USING (organisation_id is null)`,
      );
      expect(present, table.name).toBe(shared);
    }
    for (const name of PLATFORM_CHAIN_TABLES) {
      expect(sql).not.toContain(`CREATE POLICY "tenant_shared_read" ON "${name}"`);
    }
  });

  it('leaves tables without organisation_id out of RLS', () => {
    for (const name of [
      'organisations',
      'users',
      'sessions',
      'accounts',
      'permissions',
      'role_permissions',
      'email_suppressions',
      'signing_keys',
    ]) {
      expect(sql).not.toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`);
    }
  });

  it('creates no roles and grants no role membership in migrations', () => {
    expect(sql).not.toMatch(/CREATE ROLE|GRANT\s+\w+\s+TO\s+CURRENT_USER|BYPASSRLS/i);
  });
});
