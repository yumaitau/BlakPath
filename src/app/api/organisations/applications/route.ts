import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getPublicOrganisationBySlug,
  startPublicApplication,
} from '@/domains/organisations';
import { requireSession } from '@/lib/auth/session';
import { clientIp } from '@/lib/http/client-ip';
import { tenantHandler } from '@/lib/http/error-response';
import { AuthorizationError } from '@/lib/permissions/errors';
import { withTenant } from '@/lib/tenancy/with-tenant';

const bodySchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  applicantName: z.string().trim().min(1).max(200),
});

/**
 * POST /api/organisations/applications
 *
 * Starts an application for a signed-in member of an organisation that has
 * opened public applications. Unknown and closed organisations return the same
 * response. The flag is checked before a tenant context is opened, and again
 * inside the start service.
 *
 * This is a session-cookie mutation, so it lives outside `/api/public` (which
 * the cookie-mutation origin and content-type guard exempts).
 */
export const POST = tenantHandler(async function POST(
  request: Request,
): Promise<Response> {
  const body = bodySchema.parse(await request.json().catch(() => null));
  const organisation = await getPublicOrganisationBySlug(body.slug);
  // Unknown and closed organisations get the same denial.
  if (!organisation) throw new AuthorizationError('POLICY_DENIED');

  const session = await requireSession();
  const application = await withTenant(
    {
      userId: session.user.id,
      sessionId: session.session.id,
      organisationId: organisation.id,
      correlationId: globalThis.crypto.randomUUID(),
      requestId: globalThis.crypto.randomUUID(),
      ipAddress: clientIp(request) ?? undefined,
      userAgent: request.headers.get('user-agent') ?? undefined,
    },
    () => startPublicApplication({ applicantName: body.applicantName }),
  );

  return NextResponse.json(
    {
      application: {
        id: application.id,
        reference: application.reference,
        organisationId: application.organisationId,
      },
    },
    { status: 201 },
  );
});
