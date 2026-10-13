import { NextResponse } from 'next/server';
import { getPublicCertificateDownloadUrl } from '@/domains/correspondence';
import { logger } from '@/lib/observability/logger';

/**
 * Time-limited certificate download for an applicant holding a correspondence
 * link. No session. Invalid, expired and revoked links look the same.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token } = await params;
    const url = await getPublicCertificateDownloadUrl(token);
    if (!url) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.redirect(url);
  } catch (error) {
    logger.error({ err: error }, 'public certificate download failed');
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
