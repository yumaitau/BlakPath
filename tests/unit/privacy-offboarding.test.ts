import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/queues', () => ({ QueueName: { Privacy: 'privacy' }, addJob: vi.fn() }));

import * as schema from '@/db/schema';
import {
  EXPORT_OMITTED_COLUMNS,
  RETAINED_AFTER_PURGE,
  tenantTables,
} from '@/domains/privacy/offboarding';

const configs = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t) => getTableConfig(t));

function cascadesFrom(
  config: ReturnType<typeof getTableConfig>,
  parent: string,
): boolean {
  return config.foreignKeys.some((fk) => {
    const ref = fk.reference();
    return getTableConfig(ref.foreignTable).name === parent && fk.onDelete === 'cascade';
  });
}

describe('tenant purge reach', () => {
  it('deletes every tenant-owned table by cascade, except deliberate keepers', () => {
    const orphaned = configs
      .filter((c) => c.columns.some((col) => col.name === 'organisation_id'))
      .filter((c) => !cascadesFrom(c, 'organisations'))
      .map((c) => c.name)
      .sort();
    expect(orphaned).toEqual([...RETAINED_AFTER_PURGE].sort());
  });

  it('reaches tenant tables without organisation_id through a cascading parent', () => {
    const membershipRoles = configs.find((c) => c.name === 'membership_roles')!;
    expect(cascadesFrom(membershipRoles, 'memberships')).toBe(true);
  });

  it('exports every tenant table except the offboarding log', () => {
    const names = tenantTables().map((t) => getTableConfig(t).name);
    expect(names).not.toContain('tenant_offboardings');
    for (const expected of [
      'applications',
      'evidence',
      'audit_events',
      'rights_requests',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('never exports credentials, and names only real columns', () => {
    for (const [table, columns] of Object.entries(EXPORT_OMITTED_COLUMNS)) {
      const config = configs.find((c) => c.name === table);
      expect(config, table).toBeDefined();
      for (const column of columns) {
        expect(
          config!.columns.some((c) => c.name === column),
          `${table}.${column}`,
        ).toBe(true);
      }
    }
    expect(EXPORT_OMITTED_COLUMNS.webhook_endpoints).toContain('secret');
    expect(EXPORT_OMITTED_COLUMNS.api_keys).toContain('key_hash');
  });
});
