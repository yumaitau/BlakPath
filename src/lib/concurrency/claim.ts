import { getTableColumns, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Conditional state-change helpers.
 *
 * `version` is `timestamptz`. node-pg turns that into a Date and drops
 * microseconds, so comparing the Date back never matches the stored value.
 * Callers select `version::text` in the same read as the status check and pass
 * that string here.
 *
 * `beforeConditionalWrite` is a no-op unless a test installs
 * `globalThis.__blakpathClaimBarrier`. Production never sets it.
 */

const claimBarrierHost = globalThis as {
  __blakpathClaimBarrier?: () => Promise<void>;
};

export async function beforeConditionalWrite(): Promise<void> {
  const barrier = claimBarrierHost.__blakpathClaimBarrier;
  if (barrier) await barrier();
}

/** Exact match against the version string captured with the status read. */
export function versionMatches(version: SQLWrapper, versionText: string): SQL {
  return sql`${version} = ${versionText}::timestamptz`;
}

/**
 * Next OCC token. `clock_timestamp()` moves inside a transaction; `now()` does
 * not, and would stay equal to the value just read.
 */
export function nextRowVersion(): SQL {
  return sql`clock_timestamp()`;
}

/** Columns of `table` plus `versionText` (`version::text`) for a claim read. */
export function versionedSelection<T extends PgTable>(
  table: T & { version: SQLWrapper },
) {
  return {
    ...getTableColumns(table),
    versionText: sql<string>`${table.version}::text`.as('version_text'),
  };
}

export function takeVersionText<T extends { versionText: unknown }>(
  row: T,
): { record: Omit<T, 'versionText'>; versionText: string } | null {
  const { versionText, ...record } = row;
  if (typeof versionText !== 'string' || versionText.length === 0) return null;
  return { record, versionText };
}
