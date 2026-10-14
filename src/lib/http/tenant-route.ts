import { headers } from 'next/headers';
import { requireSession } from '@/lib/auth/session';
import { requireStaffMfa } from '@/lib/auth/staff-policy';
import { env } from '@/lib/env';
import { withTenant } from '@/lib/tenancy/with-tenant';
import { type TenantContext } from '@/lib/tenancy/context';
import { clientIp } from '@/lib/http/client-ip';
import { currentRequestIds } from '@/lib/observability/correlation';

/**
 * Route-handler helper: run `fn` inside a DB-verified tenant context.
 *
 * It authenticates the person from the signed session cookie, reads the
 * session's ADVISORY active organisation, then hands off to the tenancy layer
 * (`withTenant`), which re-verifies the user's active membership of that
 * organisation against the database. The org id is therefore never trusted from
 * client input, and no tenant-scoped code runs without a verified context.
 * `withTenant` also enforces the staff second-factor policy before `fn`.
 */

/** Thrown when a signed-in user has no active organisation selected. */
export class NoActiveOrganisationError extends Error {
  readonly code = 'NO_ACTIVE_ORGANISATION';
  readonly status = 409;
  constructor() {
    super('No active organisation is selected for this session.');
    this.name = 'NoActiveOrganisationError';
  }
}

export async function withRequestTenant<T>(
  fn: (ctx: TenantContext) => Promise<T> | T,
): Promise<T> {
  const session = await requireSession();
  const activeOrganisationId = (
    session.session as { activeOrganisationId?: string | null }
  ).activeOrganisationId;
  if (!activeOrganisationId) {
    throw new NoActiveOrganisationError();
  }
  if (env.NODE_ENV === 'production') {
    await requireStaffMfa(session.user.id);
  }

  const h = await headers();
  const bound = currentRequestIds();
  return withTenant(
    {
      userId: session.user.id,
      sessionId: session.session.id,
      organisationId: activeOrganisationId,
      correlationId: bound?.correlationId ?? globalThis.crypto.randomUUID(),
      requestId: bound?.requestId ?? globalThis.crypto.randomUUID(),
      ipAddress: clientIp({ headers: h }) ?? undefined,
      userAgent: h.get('user-agent') ?? undefined,
    },
    fn,
  );
}
