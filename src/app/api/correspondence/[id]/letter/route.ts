import { NextResponse } from 'next/server';
import { getLetterDownloadUrl } from '@/domains/correspondence';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** Staff download of a sent printed letter. */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { url } = await withRequestTenant(() => getLetterDownloadUrl(id));
  return NextResponse.redirect(url);
});
