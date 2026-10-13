import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_CHAIN_TABLES,
  SHARED_READ_TABLES,
  migrationSql,
  tenantTables,
} from '../helpers/tenant-tables';

const POLICY =
  "USING (organisation_id = current_setting('app.org_id')::uuid) WITH CHECK (organisation_id = current_setting('app.org_id')::uuid)";

describe('tenant RLS migration', () => {
  const tables = tenantTables();
  const sql = migrationSql();

  it('enables and forces RLS with tenant_isolation on every tenant table', () => {
    expect(tables.length).toBeGreaterThan(40);
    const missing: string[] = [];
    for (const table of tables) {
      const enable = `ALTER TABLE "${table.name}" ENABLE ROW LEVEL SECURITY`;
      const force = `ALTER TABLE "${table.name}" FORCE ROW LEVEL SECURITY`;
      const policy = `CREATE POLICY "tenant_isolation" ON "${table.name}"`;
      if (
        !sql.includes(enable) ||
        !sql.includes(force) ||
        !sql.includes(`${policy} AS PERMISSIVE FOR ALL TO public ${POLICY}`)
      ) {
        missing.push(table.name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('shares null-org reads only for roles and feature flags', () => {
    for (const name of SHARED_READ_TABLES) {
      expect(sql).toContain(
        `CREATE POLICY "tenant_shared_read" ON "${name}" AS PERMISSIVE FOR SELECT TO public USING (organisation_id is null)`,
      );
    }
    for (const table of tables) {
      const shared = (SHARED_READ_TABLES as readonly string[]).includes(table.name);
      const present = sql.includes(
        `CREATE POLICY "tenant_shared_read" ON "${table.name}"`,
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
    ]) {
      expect(sql).not.toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).not.toContain(`ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY`);
    }
  });

  it('does not create roles inside the transactional migration', () => {
    const force = readFileSync(
      join(process.cwd(), 'src/db/migrations/0020_rls-force-and-roles.sql'),
      'utf8',
    );
    const statements = force
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/CREATE ROLE/i);
    expect(force).toContain('GRANT blakpath_app TO CURRENT_USER');
    expect(force).toContain('GRANT blakpath_platform TO CURRENT_USER');
    const roles = readFileSync(join(process.cwd(), 'src/db/rls-roles.ts'), 'utf8');
    expect(roles).toContain('NOBYPASSRLS');
    expect(roles).toMatch(/PLATFORM_ROLE[\s\S]*BYPASSRLS/);
    expect(roles).not.toMatch(/PLATFORM_ROLE[\s\S]{0,120}NOBYPASSRLS/);
  });
});
