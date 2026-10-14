import type { Permission } from '@/lib/permissions/catalog';
import type { TenantContext } from '@/lib/tenancy/context';

/** Stable tenant id shared by scripted scopes and context fixtures. */
export const ORG_ID = '00000000-0000-4000-8000-0000000000aa';

export const USER_ID = '00000000-0000-4000-8000-0000000000bb';

/** A DB-shaped tenant context. Permissions are the only thing tests vary. */
export function tenantContext(permissions: readonly Permission[]): TenantContext {
  return {
    organisationId: ORG_ID,
    userId: USER_ID,
    membershipId: '00000000-0000-4000-8000-0000000000cc',
    permissions: new Set(permissions),
    roles: ['intake-officer'],
    sessionId: '00000000-0000-4000-8000-0000000000dd',
    correlationId: 'corr-1',
    requestId: 'req-1',
  };
}
