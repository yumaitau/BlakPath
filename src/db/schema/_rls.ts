import { sql } from 'drizzle-orm';
import { pgPolicy } from 'drizzle-orm/pg-core';

/**
 * Row-level security policies for tenant-owned tables.
 *
 * The app role sets `app.org_id` with `set_config(..., true)` (SET LOCAL)
 * inside a transaction. Missing or mismatched settings fail closed: the
 * comparison is false, or the cast/setting lookup errors. `WITH CHECK` stops
 * a tenant writing another tenant's key.
 *
 * A fresh policy object is required per table — drizzle links one instance
 * to one table.
 */
export function tenantIsolationPolicy() {
  return pgPolicy('tenant_isolation', {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: sql`organisation_id = current_setting('app.org_id')::uuid`,
    withCheck: sql`organisation_id = current_setting('app.org_id')::uuid`,
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
