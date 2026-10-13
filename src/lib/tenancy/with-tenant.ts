import { runWithTenantContext, type TenantContext } from './context';
import { resolveTenantContext, type ResolveTenantInput } from './resolve';

/**
 * Resolve a verified TenantContext and run `fn` inside it.
 *
 * This is the ergonomic wrapper route handlers, server actions and jobs use:
 * it performs the DB-verified tenancy resolution (which throws for an
 * unauthorised or unavailable org) and, only on success, establishes the
 * ambient context via
 * `runWithTenantContext` so `currentScope()` / `requireTenantContext()` work
 * for the duration of `fn`. If resolution throws, `fn` is never called — there
 * is no window in which tenant-scoped code runs without a verified context.
 *
 * The callback receives the resolved context for convenience; it may also read
 * it ambiently via `requireTenantContext()`.
 */
export async function withTenant<T>(
  input: ResolveTenantInput,
  fn: (ctx: TenantContext) => Promise<T> | T,
): Promise<T> {
  const ctx = await resolveTenantContext(input);
  return runWithTenantContext(ctx, () => fn(ctx));
}
