import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import {
  requireRecentAuth,
  StepUpRequiredError,
  STEP_UP_WINDOWS,
  UnauthenticatedError,
} from '@/lib/auth/session';
import { requireStaffMfa, StaffMfaRequiredError } from '@/lib/auth/staff-policy';
import { stepUpRequiredBody } from '@/lib/auth/step-up-policy';
import { AuthorizationError } from '@/lib/permissions/errors';
import { BreakGlassError } from '@/domains/break-glass';
import { tenantKeyErrorResponse } from '@/lib/http/tenant-key-response';

/**
 * Route guard for PLATFORM-operator actions (e.g. requesting/activating
 * break-glass). Requires an authenticated, recently-authenticated (step-up)
 * session whose user is flagged `isPlatformOperator` in the database — the flag
 * is re-checked against the DB, never trusted from the session payload. Returns
 * the verified operator's user id.
 */
export async function requirePlatformOperator(): Promise<{ userId: string }> {
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
  return { userId: session.user.id };
}

/** Map break-glass / step-up / auth errors to non-leaking responses. */
export function breakGlassErrorResponse(error: unknown): NextResponse {
  const locked = tenantKeyErrorResponse(error);
  if (locked) return locked;
  if (error instanceof StepUpRequiredError) {
    return NextResponse.json(stepUpRequiredBody(), { status: 401 });
  }
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (error instanceof StaffMfaRequiredError) {
    return NextResponse.json(
      { error: 'A verified second factor is required', code: error.code },
      { status: error.status },
    );
  }
  if (error instanceof BreakGlassError || error instanceof AuthorizationError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}
