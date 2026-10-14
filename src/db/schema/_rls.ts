import { sql } from 'drizzle-orm';
import { pgPolicy } from 'drizzle-orm/pg-core';

/**
 * Row-level security policies for tenant-owned tables.
 *
 * Every table with an `organisation_id` column has RLS enabled and forced, and
 * the policy below. `blakpath_rls_allows` (created in migration 0043) reads
 * the transaction-local settings applied by `src/db/bound-db.ts`:
 *
 * - `app.bypass_rls = on` (platform handle): every row.
 * - `app.org_id` set (tenant handle): only that organisation's rows, for
 *   reads and for the new row of an insert or update (`WITH CHECK`).
 * - neither set: allowed while release N-1 (which sets neither) can still be
 *   running. A later migration makes this deny; see docs/tenant-isolation.md.
 *
 * A fresh policy object is required per table — drizzle links one instance
 * to one table.
 */
export function tenantIsolationPolicy() {
  return pgPolicy('tenant_isolation', {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: sql`blakpath_rls_allows(organisation_id)`,
    withCheck: sql`blakpath_rls_allows(organisation_id)`,
  });
}

/**
 * Read of shared catalog rows whose `organisation_id` is null (system role
 * templates, platform feature-flag defaults). SELECT only, so a tenant cannot
 * write or update a null-org row, and other tenants' rows stay hidden.
 */
export function tenantSharedReadPolicy() {
  return pgPolicy('tenant_shared_read', {
    as: 'permissive',
    for: 'select',
    to: 'public',
    using: sql`organisation_id is null`,
  });
}
