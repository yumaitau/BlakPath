import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  OrganisationNotFoundError,
  setOrganisationStatus,
} from '@/domains/organisations';
import { OrganisationActivationError } from '@/domains/organisation-keys';
import { clientIp } from '@/lib/http/client-ip';
import {
  breakGlassErrorResponse,
  requirePlatformOperator,
} from '@/lib/http/platform-route';
import { ORGANISATION_STATUSES } from '@/lib/tenancy/organisation-status';

/**
 * POST /api/admin/organisations/[id]/status — platform operator lifecycle change.
 *
 * Requires a recently authenticated platform operator. The new status is
 * written and appended to the platform audit chain. A move to `active` needs a
 * validated tenant key (409 otherwise). Staff of the organisation cannot call
 * this route.
 */
const bodySchema = z.object({
  status: z.enum(ORGANISATION_STATUSES),
  reason: z.string().trim().min(1).max(500).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { userId, sessionId } = await requirePlatformOperator();
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const organisation = await setOrganisationStatus({
      organisationId: id,
      status: parsed.data.status,
      actorUserId: userId,
      sessionId,
      correlationId: globalThis.crypto.randomUUID(),
      requestId: globalThis.crypto.randomUUID(),
      reason: parsed.data.reason,
      ipAddress: clientIp(request) ?? undefined,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
    return NextResponse.json(organisation);
  } catch (error) {
    if (error instanceof OrganisationNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (error instanceof OrganisationActivationError) {
      return NextResponse.json(
        { error: 'Organisation cannot become active' },
        { status: 409 },
      );
    }
    return breakGlassErrorResponse(error);
  }
}
