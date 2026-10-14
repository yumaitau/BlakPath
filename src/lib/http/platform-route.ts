import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { requireRecentAuth, requireSession, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { requireStaffMfa } from '@/lib/auth/staff-policy';
import { AuthorizationError } from '@/lib/permissions/errors';

async function operatorFlag(userId: string): Promise<boolean> {
  const rows = await db
    .select({ isPlatformOperator: users.isPlatformOperator })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.isPlatformOperator === true;
}

/**
 * Route guard for PLATFORM-operator actions (e.g. requesting/activating
 * break-glass). Requires an authenticated, recently-authenticated (step-up)
 * session whose user is flagged `isPlatformOperator` in the database — the flag
 * is re-checked against the DB, never trusted from the session payload. Returns
 * the verified operator's user id.
 */
export async function requirePlatformOperator(
  stepUpWindowSeconds: number = STEP_UP_WINDOWS.privileged,
): Promise<{
  userId: string;
  sessionId: string;
}> {
  const session = await requireRecentAuth(stepUpWindowSeconds);
  if (!(await operatorFlag(session.user.id))) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  await requireStaffMfa(session.user.id, {
    organisationId: null,
    sessionId: session.session.id,
    actingRole: 'platform-operator',
  });
  return { userId: session.user.id, sessionId: session.session.id };
}

/**
 * Platform operator with a valid session, without a fresh step-up.
 * Used for reads under a grant that was already step-up checked at request
 * and activation. The grant's own expiry is the time box (step-up is 5
 * minutes; a grant may last up to 8 hours). Staff MFA still applies.
 */
export async function requirePlatformOperatorIdentity(): Promise<{
  userId: string;
  sessionId: string;
}> {
  const session = await requireSession();
  if (!(await operatorFlag(session.user.id))) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  await requireStaffMfa(session.user.id, {
    organisationId: null,
    sessionId: session.session.id,
    actingRole: 'platform-operator',
  });
  return { userId: session.user.id, sessionId: session.session.id };
}
