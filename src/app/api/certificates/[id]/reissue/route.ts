import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { reissueCertificate } from '@/domains/certificates';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/certificates/[id]/reissue — revoke a signed certificate and open
 * a replacement draft linked to it.
 *
 * SECURITY: revoking a live credential is an authority-bearing act, so this
 * requires step-up in addition to generate + revoke permissions.
 */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/certificates/[id]/reissue']);
  const { id } = await params;
  const certificate = await withRequestTenant(() => reissueCertificate(id));
  return NextResponse.json({
    id: certificate.id,
    reference: certificate.reference,
    status: certificate.status,
  });
});
