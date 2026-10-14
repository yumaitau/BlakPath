import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { generateCertificate, listCertificates } from '@/domains/certificates';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';

/**
 * Certificates collection.
 * - GET  ?applicationId=<uuid> — list an application's certificates.
 * - POST { decisionId }        — generate a draft certificate from a finalised,
 *                                confirmed decision on a decided case.
 */
export const GET = tenantHandler(async function GET(
  request: NextRequest,
): Promise<Response> {
  const applicationId = new URL(request.url).searchParams.get('applicationId');
  if (!applicationId) {
    throw new ClientSafeError(400, 'VALIDATION_ERROR', 'applicationId is required');
  }
  const items = await withRequestTenant(() => listCertificates(applicationId));
  return NextResponse.json({
    items: items.map((item) => {
      const { holderBindingSalt, holderNameHash, holderDobHash, ...publicItem } = item;
      void holderBindingSalt;
      void holderNameHash;
      void holderDobHash;
      return publicItem;
    }),
  });
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
