import { platformBoundDb } from './bound-db';

/**
 * Database handle for vetted paths that run before a tenant is chosen, or that
 * must see rows the tenant role is not allowed to see (null-org catalog rows
 * are the exception handled by a SELECT policy; this handle is BYPASSRLS).
 *
 * Do not import this from ordinary tenant features. ESLint allowlists the
 * callers. New tenant reads and writes go through `scopeFor` / `currentScope`.
 */
export const platformDb = platformBoundDb();
