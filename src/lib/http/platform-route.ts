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
import { AuthorizationError } from '@/lib/permissions/errors';
import { BreakGlassError } from '@/domains/break-glass';
import { captureException } from '@/lib/observability/errors';

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
  return { userId: session.user.id };
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
  if (error instanceof BreakGlassError || error instanceof AuthorizationError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  captureException(error);
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}
