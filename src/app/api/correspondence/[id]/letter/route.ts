import { NextResponse } from 'next/server';
import { getLetterDownloadUrl } from '@/domains/correspondence';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Staff download of a sent printed letter. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const { url } = await withRequestTenant(() => getLetterDownloadUrl(id));
    return NextResponse.redirect(url);
  } catch (error) {
    return toErrorResponse(error);
  }
}
