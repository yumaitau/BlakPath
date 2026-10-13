import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getPublicOrganisationBySlug,
  startPublicApplication,
} from '@/domains/organisations';
import { requireSession } from '@/lib/auth/session';
import { toErrorResponse } from '@/lib/http/tenant-route';
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
 * POST /api/public/applications
 *
 * Starts an application for a signed-in member of an organisation that has
 * opened public applications. Unknown and closed organisations return the same
 * response. The flag is checked before a tenant context is opened, and again
 * inside the start service.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = bodySchema.parse(await request.json().catch(() => null));
    const organisation = await getPublicOrganisationBySlug(body.slug);
    if (!organisation) {
      return NextResponse.json({ error: 'Applications are not open' }, { status: 403 });
    }

    const session = await requireSession();
    const h = await headers();
    const application = await withTenant(
      {
        userId: session.user.id,
        sessionId: session.session.id,
        organisationId: organisation.id,
        correlationId: globalThis.crypto.randomUUID(),
        requestId: globalThis.crypto.randomUUID(),
        ipAddress: h.get('x-forwarded-for') ?? undefined,
        userAgent: h.get('user-agent') ?? undefined,
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
  } catch (error) {
    return toErrorResponse(error);
  }
}
