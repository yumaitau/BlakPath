import { requireStaffMfa, tenantActorRequiresStaffMfa } from '@/lib/auth/staff-policy';
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
 *
 * Staff accounts (and platform operators) must already hold a verified second
 * factor. The check runs after membership is confirmed and before `fn`, so a
 * password-only staff session never enters tenant-scoped work. Applicant-only
 * memberships are exempt. A refusal is audited, then thrown.
 */
export async function withTenant<T>(
  input: ResolveTenantInput,
  fn: (ctx: TenantContext) => Promise<T> | T,
): Promise<T> {
  const ctx = await resolveTenantContext(input);
  if (await tenantActorRequiresStaffMfa(ctx.userId, ctx.roles)) {
    await requireStaffMfa(ctx.userId, {
      organisationId: ctx.organisationId,
      sessionId: ctx.sessionId,
      actingRole: ctx.roles[0] ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
  return runWithTenantContext(ctx, () => fn(ctx));
}
