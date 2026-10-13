import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import {
  requireRecentAuth,
  StepUpRequiredError,
  STEP_UP_WINDOWS,
} from '@/lib/auth/session';
import {
  CertificateTemplateRequiredError,
  reissueCertificate,
} from '@/domains/certificates';

/**
 * POST /api/certificates/[id]/reissue — revoke a signed certificate and open
 * a replacement draft linked to it.
 *
 * SECURITY: revoking a live credential is an authority-bearing act, so this
 * requires step-up in addition to generate + revoke permissions.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.sensitiveAction);
    const { id } = await params;
    const certificate = await withRequestTenant(() => reissueCertificate(id));
    return NextResponse.json({
      id: certificate.id,
      reference: certificate.reference,
      status: certificate.status,
    });
  } catch (error) {
    if (error instanceof StepUpRequiredError) {
      return NextResponse.json(
        { error: 'Re-authentication required', code: 'STEP_UP_REQUIRED' },
        { status: 401 },
      );
    }
    if (error instanceof CertificateTemplateRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return toErrorResponse(error);
  }
}
