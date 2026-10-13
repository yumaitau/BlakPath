import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { generateCertificate, listCertificates } from '@/domains/certificates';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';

/**
 * Certificates collection.
 * - GET  ?applicationId=<uuid> — list an application's certificates.
 * - POST { decisionId }        — generate a draft certificate from a finalised,
 *                                confirmed decision.
 */
export const GET = tenantHandler(async function GET(
  request: NextRequest,
): Promise<Response> {
  const applicationId = new URL(request.url).searchParams.get('applicationId');
  if (!applicationId) {
    throw new ClientSafeError(400, 'VALIDATION_ERROR', 'applicationId is required');
  }
  const items = await withRequestTenant(() => listCertificates(applicationId));
  return NextResponse.json({ items });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body: unknown = await request.json();
  const certificate = await withRequestTenant(() =>
    generateCertificate(body as { decisionId: string }),
  );
  return NextResponse.json({ id: certificate.id, reference: certificate.reference });
});
