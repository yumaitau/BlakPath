import { NextResponse } from 'next/server';
import { requireSession, UnauthenticatedError } from '@/lib/auth/session';
import {
  sealStepUpContext,
  STEP_UP_CONTEXT_COOKIE,
  STEP_UP_CONTEXT_TTL_MS,
} from '@/lib/auth/step-up-context-cookie';
import { env, isProduction } from '@/lib/env';
import { logger } from '@/lib/observability/logger';

/**
 * Seal the current user and active organisation before a passkey re-auth.
 * The passkey flow mints a new session; completion copies this organisation
 * only when the signed-in user still matches.
 */

function stepUpCookie(value: string, maxAge: number) {
  return {
    name: STEP_UP_CONTEXT_COOKIE,
    value,
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProduction(),
    maxAge,
  };
}

export async function POST(): Promise<Response> {
  try {
    const session = await requireSession();
    const organisationId =
      (session.session as { activeOrganisationId?: string | null })
        .activeOrganisationId ?? null;
    const value = sealStepUpContext(
      {
        userId: session.user.id,
        organisationId,
        exp: Date.now() + STEP_UP_CONTEXT_TTL_MS,
      },
      env.BETTER_AUTH_SECRET,
    );
    const response = NextResponse.json({ ok: true });
    response.cookies.set(stepUpCookie(value, STEP_UP_CONTEXT_TTL_MS / 1000));
    return response;
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    logger.error({ err: error }, 'step-up prepare failed');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
