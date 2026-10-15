import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { getPreviewUrl } from '@/domains/certificates';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET /api/certificates/[id]/preview — inline URL for a draft certificate PDF.
 * Signed certificates are not previewed here; they use the download route.
 */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { url } = await withRequestTenant(() => getPreviewUrl(id));
  return NextResponse.redirect(url);
});
