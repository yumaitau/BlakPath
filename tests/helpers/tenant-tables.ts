import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@/db/schema';

/** Tables whose null `organisation_id` rows are platform defaults tenants may read. */
export const SHARED_READ_TABLES = ['feature_flags', 'roles'] as const;

/**
 * Null `organisation_id` on these tables is the platform audit chain. Tenants
 * must not read it, and closing a tenant must not delete it, so there is no
 * organisation foreign key.
 */
export const PLATFORM_CHAIN_TABLES = [
  'audit_events',
  'audit_integrity_checkpoints',
] as const;

export interface TenantTable {
  readonly name: string;
  /** True when `organisation_id` references `organisations.id`. */
  readonly referencesOrganisation: boolean;
  readonly onDelete: string | null;
}

function isTable(value: unknown): value is PgTable {
  return is(value, PgTable);
}

/** Every Drizzle table that has an `organisationId` column, sorted by SQL name. */
export function tenantTables(): TenantTable[] {
  const tables: TenantTable[] = [];
  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue;
    const columns = getTableColumns(value);
    if (!('organisationId' in columns)) continue;
    const config = getTableConfig(value);
    let referencesOrganisation = false;
    let onDelete: string | null = null;
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const local = ref.columns.some((column) => column.name === 'organisation_id');
      if (!local) continue;
      if (getTableName(ref.foreignTable) !== 'organisations') continue;
      referencesOrganisation = true;
      onDelete = fk.onDelete ?? null;
    }
    tables.push({ name: getTableName(value), referencesOrganisation, onDelete });
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));
  return tables;
}

export function migrationSql(root = process.cwd()): string {
  const dir = join(root, 'src/db/migrations');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}
