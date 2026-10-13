import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';

/**
 * Static schema-integrity rules (issue #86). These read the Drizzle schema, so
 * a new table or FK that breaks a rule fails here before it reaches a
 * migration. The database-backed counterpart lives in
 * tests/integration/schema-integrity.test.ts.
 */

const tables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));

const configByName = new Map(tables.map((config) => [config.name, config]));

/** Every column list that an index, unique constraint or primary key leads with. */
function indexedColumnLists(config: ReturnType<typeof getTableConfig>): string[][] {
  const lists: string[][] = [];
  for (const index of config.indexes) {
    lists.push(
      index.config.columns.map((column) =>
        'name' in column && typeof column.name === 'string' ? column.name : '<expr>',
      ),
    );
  }
  for (const unique of config.uniqueConstraints) {
    lists.push(unique.columns.map((column) => column.name));
  }
  for (const pk of config.primaryKeys) {
    lists.push(pk.columns.map((column) => column.name));
  }
  for (const column of config.columns) {
    if (column.primary || column.isUnique) lists.push([column.name]);
  }
  return lists;
}

const foreignKeys = tables.flatMap((config) =>
  config.foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      table: config.name,
      name: fk.getName(),
      onDelete: fk.onDelete,
      columns: ref.columns.map((column) => column.name),
      foreignTable: getTableConfig(ref.foreignTable).name,
      foreignColumns: ref.foreignColumns.map((column) => column.name),
    };
  }),
);

const migrationSql = readdirSync(join(process.cwd(), 'src/db/migrations'))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(join(process.cwd(), 'src/db/migrations', file), 'utf8'))
  .join('\n');

/** The last ADD CONSTRAINT statement for a named constraint across all migrations. */
function lastConstraintDefinition(name: string): string | undefined {
  const pattern = new RegExp(`ADD CONSTRAINT "${name}" [^;]*;`, 'g');
  return [...migrationSql.matchAll(pattern)].at(-1)?.[0];
}

describe('schema integrity', () => {
  it('discovers the schema', () => {
    expect(tables.length).toBeGreaterThan(40);
    expect(foreignKeys.length).toBeGreaterThan(80);
  });

  it('backs every foreign key with an index led by its columns', () => {
    const missing = foreignKeys
      .filter((fk) => {
        const lists = indexedColumnLists(configByName.get(fk.table)!);
        return !lists.some((list) =>
          fk.columns.every((column, position) => list[position] === column),
        );
      })
      .map((fk) => `${fk.table}(${fk.columns.join(',')})`);
    expect(missing).toEqual([]);
  });

  it('links tenant rows to tenant parents through organisation_id', () => {
    // Roles may be null-organisation system templates, which a composite FK
    // cannot reference: the enforce_role_same_tenant trigger covers role
    // assignment, and a role's permission grants have no tenant of their own.
    const exempt = new Set([
      'membership_roles.role_id',
      'membership_invitations.role_id',
      'role_permissions.role_id',
    ]);
    const crossTenantCapable = foreignKeys
      .filter((fk) => fk.foreignTable !== 'organisations')
      .filter((fk) => configByName.get(fk.foreignTable)!.columns.some(isOrgColumn))
      .filter((fk) => !exempt.has(`${fk.table}.${fk.columns.join(',')}`))
      .filter((fk) => {
        const orgPosition = fk.columns.indexOf('organisation_id');
        return orgPosition === -1 || fk.foreignColumns[orgPosition] !== 'organisation_id';
      })
      .map((fk) => `${fk.table}(${fk.columns.join(',')}) -> ${fk.foreignTable}`);
    expect(crossTenantCapable).toEqual([]);
  });

  it('gives every tenant table that references a tenant parent its own organisation_id', () => {
    const orgless = foreignKeys
      .filter((fk) => fk.foreignTable !== 'organisations')
      .filter((fk) =>
        configByName
          .get(fk.foreignTable)!
          .columns.some((c) => isOrgColumn(c) && c.notNull),
      )
      .filter((fk) => !configByName.get(fk.table)!.columns.some(isOrgColumn))
      .map((fk) => `${fk.table} -> ${fk.foreignTable}`);
    expect(orgless).toEqual([]);
  });

  it('clears only the reference column when a nullable same-tenant FK is set null', () => {
    const composite = foreignKeys.filter(
      (fk) => fk.onDelete === 'set null' && fk.columns.length > 1,
    );
    expect(composite.length).toBeGreaterThan(0);
    const unamended = composite
      .filter((fk) => {
        const reference = fk.columns.find((column) => column !== 'organisation_id');
        const sql = lastConstraintDefinition(fk.name);
        return !sql?.includes(`ON DELETE SET NULL ("${reference}")`);
      })
      .map((fk) => fk.name);
    expect(unamended).toEqual([]);
  });

  it('never cascades a user delete into governance records', () => {
    const governance = [
      'decision_votes.voter_user_id',
      'conflict_declarations.declared_by_user_id',
      'consent_records.subject_user_id',
    ];
    for (const key of governance) {
      const [table, column] = key.split('.');
      const fk = foreignKeys.find((f) => f.table === table && f.columns[0] === column);
      expect(fk, key).toBeDefined();
      expect(fk?.foreignTable).toBe('users');
      expect(fk?.onDelete, key).toBe('restrict');
    }
  });

  it('treats null organisation_id as one platform scope in unique keys', () => {
    for (const [table, name] of [
      ['roles', 'roles_org_slug_unique'],
      ['feature_flags', 'feature_flags_org_key_unique'],
    ] as const) {
      const unique = configByName
        .get(table)!
        .uniqueConstraints.find((constraint) => constraint.getName() === name);
      expect(unique, name).toBeDefined();
      expect(unique?.nullsNotDistinct, name).toBe(true);
    }
  });

  it('keeps explicit constraint and index names within the PostgreSQL limit', () => {
    // Older drizzle-generated FK names already exceed 63 bytes and were
    // truncated by PostgreSQL; explicit names must not rely on that.
    const names = [
      ...foreignKeys.map((fk) => fk.name).filter((name) => name.endsWith('_same_org_fk')),
      ...tables.flatMap((config) =>
        config.indexes.map((index) => index.config.name ?? ''),
      ),
      ...tables.flatMap((config) =>
        config.uniqueConstraints.map((unique) => unique.getName() ?? ''),
      ),
    ];
    expect(names.filter((name) => Buffer.byteLength(name) > 63)).toEqual([]);
  });

  it('installs the role same-tenant trigger', () => {
    expect(migrationSql).toContain('CREATE FUNCTION "enforce_role_same_tenant"()');
    expect(migrationSql).toMatch(/CREATE TRIGGER "membership_roles_role_same_tenant"/);
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "membership_invitations_role_same_tenant"/,
    );
  });
});

function isOrgColumn(column: { name: string }): boolean {
  return column.name === 'organisation_id';
}
