import { platformBoundDb } from './bound-db';

/**
 * Explicit row-level security bypass (`app.bypass_rls = on`).
 *
 * For vetted paths that run before a tenant is chosen (membership and API-key
 * resolution, public verification) or across organisations (operator
 * provisioning, worker sweeps, the platform audit chain). It still runs as the
 * application role, so the append-only audit grants apply.
 *
 * ESLint allowlists the importers, and `tests/unit/tenant-db-import-guard.test.ts`
 * pins the list. Tenant reads and writes go through `scopeFor` / `currentScope`.
 */
export const platformDb = platformBoundDb();
