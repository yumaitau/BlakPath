import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { sessions } from '@/db/schema';
import { requireSession, UnauthenticatedError } from '@/lib/auth/session';
import {
  openStepUpContext,
  STEP_UP_CONTEXT_COOKIE,
} from '@/lib/auth/step-up-context-cookie';
import { env, isProduction } from '@/lib/env';
import { logger } from '@/lib/observability/logger';

/**
 * After a passkey assertion, copy the previous active organisation onto the
 * new session when the sealed user id matches the signed-in user and the
 * session finishing is not the one that prepared. Completion only copies the
 * organisation; it never changes `lastAuthenticatedAt`. Freshness comes from
 * the sign-in that created the new session. The cookie is cleared either way.
 * Membership is re-checked on the next tenant request.
 */

function cleared(response: NextResponse): NextResponse {
  response.cookies.set({
    name: STEP_UP_CONTEXT_COOKIE,
    value: '',
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    maxAge: 0,
  });
  return response;
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const session = await requireSession();
    const raw = request.cookies.get(STEP_UP_CONTEXT_COOKIE)?.value;
    const opened = raw ? openStepUpContext(raw, env.BETTER_AUTH_SECRET) : null;
    if (
      !opened ||
      opened.userId !== session.user.id ||
      // The session that prepared is the session completing: no sign-in
      // happened in between, so there is nothing to confirm.
      opened.sessionId === session.session.id
    ) {
      return cleared(NextResponse.json({ code: 'REAUTH_FAILED' }, { status: 401 }));
    }
    if (opened.organisationId) {
      await db
        .update(sessions)
        .set({ activeOrganisationId: opened.organisationId })
        .where(eq(sessions.id, session.session.id));
    }
    return cleared(NextResponse.json({ ok: true }));
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return cleared(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    }
    logger.error({ err: error }, 'step-up complete failed');
    return cleared(NextResponse.json({ error: 'Internal error' }, { status: 500 }));
  }
}
