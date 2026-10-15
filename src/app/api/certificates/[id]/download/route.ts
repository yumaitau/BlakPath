import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { getDownloadUrl } from '@/domains/certificates';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET /api/certificates/[id]/download — mint a short-lived presigned URL for a
 * signed, non-revoked certificate PDF and redirect to it.
 */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { url } = await withRequestTenant(() => getDownloadUrl(id));
  return NextResponse.redirect(url);
});
