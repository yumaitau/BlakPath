import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SESSION_DATA_COOKIE_NAMES } from '@/lib/auth';
import { requireSession } from '@/lib/auth/session';
import { setActiveOrganisation } from '@/domains/tenancy-selection/service';
import { tenantHandler } from '@/lib/http/error-response';

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
  // Malformed JSON (SyntaxError) and a bad id (ZodError) both map to 400.
  const parsed = bodySchema.parse(await request.json());

  // A missing/inactive membership surfaces as TenantContextError and an
  // unusable organisation as OrganisationUnavailableError. The shared mapper
  // collapses both to a generic 403.
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
      secure: name.startsWith('__Secure-') || name.startsWith('__Host-'),
      maxAge: 0,
    });
  }
  return response;
});
