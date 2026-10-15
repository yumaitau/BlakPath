import { AuthorizationError } from '@/lib/permissions/errors';
import { canOpenStaffTool } from '@/lib/navigation/staff-tools';
import { withRequestTenant } from '@/lib/http/tenant-route';
import type { TenantContext } from '@/lib/tenancy/context';

export type ToolPageResult<T> =
  { kind: 'ready'; data: T } | { kind: 'denied' } | { kind: 'unavailable' };

/**
 * Load a permission-gated staff screen.
 * Missing permission and authorisation failures render the same denial, so a
 * direct address does not reveal whether records exist.
 */
export async function loadToolPage<T>(
  href: string,
  load: (ctx: TenantContext) => Promise<T>,
): Promise<ToolPageResult<T>> {
  try {
    return await withRequestTenant(async (ctx) => {
      if (!canOpenStaffTool(ctx.permissions, href)) return { kind: 'denied' };
      return { kind: 'ready', data: await load(ctx) };
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return { kind: 'denied' };
    return { kind: 'unavailable' };
  }
}
