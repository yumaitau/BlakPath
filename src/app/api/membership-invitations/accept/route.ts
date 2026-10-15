import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { acceptMembershipInvitation } from '@/domains/memberships';
import { SESSION_DATA_COOKIE_NAMES } from '@/lib/auth';
import { requireSession } from '@/lib/auth/session';
import { clientIpForLimits } from '@/lib/http/client-ip';
import { REQUEST_LIMITS, limitIp, limitSubject } from '@/lib/http/request-limits';
import { tenantHandler } from '@/lib/http/error-response';

const acceptSchema = z.object({ token: z.string().min(20).max(200) });

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const ipLimited = await limitIp(
    REQUEST_LIMITS.invitationAccept,
    clientIpForLimits(request.headers),
  );
  if (ipLimited) return ipLimited;
  const session = await requireSession();
  const { token } = acceptSchema.parse(await request.json().catch(() => null));
  const tokenLimited = await limitSubject(REQUEST_LIMITS.invitationAccept, token);
  if (tokenLimited) return tokenLimited;
  const membership = await acceptMembershipInvitation({
    token,
    userId: session.user.id,
    userEmail: session.user.email,
    emailVerified: session.user.emailVerified,
    sessionId: session.session.id,
  });
  const response = NextResponse.json({ membership });
  for (const name of SESSION_DATA_COOKIE_NAMES) {
    response.cookies.set({
      name,
      value: '',
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: name.startsWith('__Secure-') || name.startsWith('__Host-'),
      maxAge: 0,
    });
  }
  return response;
});
