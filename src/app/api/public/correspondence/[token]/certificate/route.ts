import { NextResponse } from 'next/server';
import { getPublicCertificateDownloadUrl } from '@/domains/correspondence';
import { clientIpForLimits } from '@/lib/http/client-ip';
import { sanitiseError } from '@/lib/http/error-response';
import { REQUEST_LIMITS, enforcePair } from '@/lib/http/request-limits';
import { logger } from '@/lib/observability/logger';

/**
 * Time-limited certificate download for an applicant holding a correspondence
 * link. No session; the token is the capability. Invalid, expired and revoked
 * links look the same.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const limited = await enforcePair(
    REQUEST_LIMITS.correspondencePage,
    clientIpForLimits(request.headers),
    token,
  );
  if (limited) return limited;
  try {
    const url = await getPublicCertificateDownloadUrl(token);
    if (!url) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.redirect(url);
  } catch (error) {
    logger.error({ err: sanitiseError(error) }, 'public certificate download failed');
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
