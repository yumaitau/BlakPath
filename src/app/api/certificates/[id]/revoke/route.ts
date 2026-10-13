import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { revokeCertificate } from '@/domains/certificates';
import { tenantHandler } from '@/lib/http/error-response';

/** POST /api/certificates/[id]/revoke — revoke a signed certificate. */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body: unknown = await request.json();
  const certificate = await withRequestTenant(() =>
    revokeCertificate(id, body as { reason: string }),
  );
  return NextResponse.json({ id: certificate.id, status: certificate.status });
});
