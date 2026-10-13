import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { setActiveOrganisation } from '@/domains/tenancy-selection/service';
import { tenantHandler } from '@/lib/http/error-response';

const SESSION_DATA_COOKIE_NAMES = [
  'blakpath.session_data',
  '__Secure-blakpath.session_data',
] as const;

/**
 * POST /api/organisations/active — set the session's active organisation.
 *
 * The body carries the chosen organisation id, which is untrusted. The service
 * verifies an active membership before writing it (see `setActiveOrganisation`),
 * so a failed membership check collapses to a generic 403 that reveals nothing
 * about whether the organisation exists.
 *
 * The auth configuration reads session state from the database on each request,
 * so the next navigation observes the new organisation immediately. Expiring
 * legacy cache cookies below also makes upgrades from older sessions safe.
 */
const bodySchema = z.object({
  organisationId: z.uuid(),
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const session = await requireSession();
  const parsed = bodySchema.parse(await request.json());

  await setActiveOrganisation({
    userId: session.user.id,
    sessionId: session.session.id,
    organisationId: parsed.organisationId,
  });

  const response = NextResponse.json({ ok: true });
  // Older deployments may have issued a cached session-data cookie. Expire
  // both development and secure-production names during the transition.
  for (const name of SESSION_DATA_COOKIE_NAMES) {
    response.cookies.set({
      name,
      value: '',
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: name.startsWith('__Secure-'),
      maxAge: 0,
    });
  }
  return response;
});
