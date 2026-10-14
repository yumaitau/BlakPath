import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { revokeCertificate } from '@/domains/certificates';

/** POST /api/certificates/[id]/revoke — revoke a signed certificate. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_ROUTES['POST /api/certificates/[id]/revoke']);
    const { id } = await params;
    const body: unknown = await request.json();
    const certificate = await withRequestTenant(() =>
      revokeCertificate(id, body as { reason: string }),
    );
    return NextResponse.json({ id: certificate.id, status: certificate.status });
  } catch (error) {
    return toErrorResponse(error);
  }
}
