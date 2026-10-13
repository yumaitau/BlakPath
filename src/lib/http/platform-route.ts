import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import {
  requireRecentAuth,
  requireSession,
  StepUpRequiredError,
  STEP_UP_WINDOWS,
  UnauthenticatedError,
} from '@/lib/auth/session';
import { AuthorizationError } from '@/lib/permissions/errors';
import {
  BreakGlassError,
  BreakGlassNotifyError,
  BreakGlassReviewOverdueError,
} from '@/domains/break-glass';
import { BreakGlassWriteError } from '@/lib/tenancy/break-glass-write';

/**
 * Route guard for PLATFORM-operator actions (e.g. requesting/activating
 * break-glass). Requires an authenticated, recently-authenticated (step-up)
 * session whose user is flagged `isPlatformOperator` in the database — the flag
 * is re-checked against the DB, never trusted from the session payload. Returns
 * the verified operator's user id.
 */
async function operatorFlag(userId: string): Promise<boolean> {
  const rows = await db
    .select({ isPlatformOperator: users.isPlatformOperator })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.isPlatformOperator === true;
}

export async function requirePlatformOperator(): Promise<{ userId: string }> {
  const session = await requireRecentAuth(STEP_UP_WINDOWS.privileged);
  if (!(await operatorFlag(session.user.id))) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  return { userId: session.user.id };
}

/**
 * Platform operator with a valid session, without a fresh step-up.
 * Used for reads under a grant that was already step-up checked at request
 * and activation. The grant's own expiry is the time box (step-up is 5
 * minutes; a grant may last up to 8 hours).
 */
export async function requirePlatformOperatorIdentity(): Promise<{
  userId: string;
  sessionId: string;
}> {
  const session = await requireSession();
  if (!(await operatorFlag(session.user.id))) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  return { userId: session.user.id, sessionId: session.session.id };
}

/** Map break-glass / step-up / auth errors to non-leaking responses. */
export function breakGlassErrorResponse(error: unknown): NextResponse {
  if (error instanceof StepUpRequiredError) {
    return NextResponse.json(
      { error: 'Re-authentication required', code: 'STEP_UP_REQUIRED' },
      { status: 401 },
    );
  }
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (
    error instanceof BreakGlassNotifyError ||
    error instanceof BreakGlassReviewOverdueError
  ) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (
    error instanceof BreakGlassError ||
    error instanceof BreakGlassWriteError ||
    error instanceof AuthorizationError
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}
