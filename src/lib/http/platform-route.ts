import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { requireStaffMfa } from '@/lib/auth/staff-policy';
import { AuthorizationError } from '@/lib/permissions/errors';

/**
 * Route guard for PLATFORM-operator actions (e.g. requesting/activating
 * break-glass). Requires an authenticated, recently-authenticated (step-up)
 * session whose user is flagged `isPlatformOperator` in the database — the flag
 * is re-checked against the DB, never trusted from the session payload. Returns
 * the verified operator's user id.
 */
export async function requirePlatformOperator(): Promise<{
  userId: string;
  sessionId: string;
}> {
  const session = await requireRecentAuth(STEP_UP_WINDOWS.privileged);
  const rows = await db
    .select({ isPlatformOperator: users.isPlatformOperator })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (!rows[0]?.isPlatformOperator) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  await requireStaffMfa(session.user.id, {
    organisationId: null,
    sessionId: session.session.id,
    actingRole: 'platform-operator',
  });
  return { userId: session.user.id, sessionId: session.session.id };
}
