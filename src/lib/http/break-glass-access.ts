import { headers } from 'next/headers';
import { recordAudit } from '@/domains/audit/service';
import { resolveBreakGlassContext } from '@/domains/break-glass';
import { requirePlatformOperatorIdentity } from '@/lib/http/platform-route';
import { runWithTenantContext, type TenantContext } from '@/lib/tenancy/context';

/**
 * Run `fn` inside a live break-glass grant.
 *
 * The grant id comes from the route, never from a membership. The caller must
 * be the platform operator who requested it, and the grant must still be
 * active and unexpired. Writes through the tenant scope throw. Every call
 * records `break_glass.accessed`; events written inside `fn` also carry the
 * break-glass flag because they run under the grant context.
 */
export async function withBreakGlassAccess<T>(
  requestId: string,
  fn: (ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const operator = await requirePlatformOperatorIdentity();
  const h = await headers();
  const ctx = await resolveBreakGlassContext({
    requestId,
    userId: operator.userId,
    correlationId: globalThis.crypto.randomUUID(),
    reqId: globalThis.crypto.randomUUID(),
    ipAddress: h.get('x-forwarded-for') ?? undefined,
    userAgent: h.get('user-agent') ?? undefined,
  });

  return runWithTenantContext(ctx, async () => {
    try {
      const result = await fn(ctx);
      await recordAudit({
        action: 'break_glass.accessed',
        resourceType: 'break_glass_request',
        resourceId: requestId,
        result: 'success',
        after: {
          data: { breakGlass: true, breakGlassRequestId: requestId },
          allow: ['breakGlass', 'breakGlassRequestId'],
        },
      });
      return result;
    } catch (error) {
      try {
        await recordAudit({
          action: 'break_glass.accessed',
          resourceType: 'break_glass_request',
          resourceId: requestId,
          result: 'denied',
        });
      } catch {
        // Keep the original failure. The denied audit is best-effort here
        // because the read itself already failed.
      }
      throw error;
    }
  });
}
