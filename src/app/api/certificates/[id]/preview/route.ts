import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { getPreviewUrl } from '@/domains/certificates';

/**
 * GET /api/certificates/[id]/preview — inline URL for a draft certificate PDF.
 * Signed certificates are not previewed here; they use the download route.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const { url } = await withRequestTenant(() => getPreviewUrl(id));
    return NextResponse.redirect(url);
  } catch (error) {
    return toErrorResponse(error);
  }
}
