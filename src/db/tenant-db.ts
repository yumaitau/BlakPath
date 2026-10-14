import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from './client';
import { tenantBoundDb } from './bound-db';
import { requireTenantContext, TenantIsolationError } from '@/lib/tenancy/context';

/**
 * Tenant-aware data access.
 *
 * Every read/write against a tenant-owned table must go through a scope
 * obtained here so the `organisation_id` predicate is applied centrally and
 * cannot be forgotten at a call site. The scope's organisation id is taken
 * from the active, DB-verified TenantContext — never from request input.
 */
export interface TenantScope {
  readonly organisationId: string;
  readonly db: Database;
  /**
   * Build a WHERE clause that is always constrained to this tenant. Pass extra
   * predicates that are AND-ed after the tenant guard.
   */
  where(orgColumn: PgColumn, ...extra: Array<SQL | undefined>): SQL;
  /**
   * Assert that a fetched row belongs to this tenant. Defence-in-depth against
   * a query that was accidentally written without the tenant predicate.
   */
  assertOwned<T extends { organisationId: string }>(row: T | undefined): T | undefined;
  /** Values to spread into an insert so the tenant column is always set. */
  insertValues<T extends Record<string, unknown>>(
    values: T,
  ): T & { organisationId: string };
}

/**
 * Scope queries to `organisationId`. The id must already be trusted: request
 * paths take it from the verified TenantContext, and the worker checks the
 * organisation is active before calling this.
 */
export function scopeFor(organisationId: string): TenantScope {
  return {
    organisationId,
    /**
     * Queries run inside a transaction with SET LOCAL role `blakpath_app` and
     * `app.org_id`, so Postgres RLS still filters a predicate that was forgotten.
     */
    db: tenantBoundDb(organisationId),
    where(orgColumn, ...extra) {
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

/** Convenience: derive a scope from the ambient TenantContext. */
export function currentScope(): TenantScope {
  return scopeFor(requireTenantContext().organisationId);
}

/**
 * Guard used by isolation tests and hot paths: throws if a table row's tenant
 * differs from expected. `table` is accepted for symmetry / future RLS checks.
 */
export function assertTenant(expected: string, actual: string, _table?: PgTable): void {
  if (expected !== actual) {
    throw new TenantIsolationError(
      `Tenant mismatch: expected ${expected}, got ${actual}.`,
    );
  }
}
