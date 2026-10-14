import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import {
  listRepresentativeAuthorisations,
  requestRepresentativeAccess,
} from '@/domains/representatives';

/** GET /api/representatives — list authorisations in the active organisation. */
export async function GET(): Promise<Response> {
  try {
    const authorisations = await withRequestTenant(() =>
      listRepresentativeAuthorisations(),
    );
    return NextResponse.json({ authorisations });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** POST /api/representatives — request access (live consent required). */
export async function POST(request: NextRequest): Promise<Response> {
  try {
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
  } catch (error) {
    return toErrorResponse(error);
  }
}
