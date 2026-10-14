import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import {
  listRepresentativeAuthorisations,
  requestRepresentativeAccess,
} from '@/domains/representatives';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/representatives — list authorisations in the active organisation. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const authorisations = await withRequestTenant(() =>
    listRepresentativeAuthorisations(),
  );
  return NextResponse.json({ authorisations });
});

/** POST /api/representatives — request access (live consent required). */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as {
    subjectUserId: string;
    representativeUserId: string;
    purpose: string;
    consentRecordId: string;
    expiresAt?: string;
  };
  const row = await withRequestTenant(() =>
    requestRepresentativeAccess({
      ...body,
      ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {}),
    }),
  );
  return NextResponse.json({ authorisation: row }, { status: 201 });
});
