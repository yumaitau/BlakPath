import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkCertificateHolder } from '@/domains/certificates';
import { clientIp } from '@/lib/http/client-ip';

/**
 * POST /api/public/verify/[code] — compare a printed name with the sealed hash.
 *
 * Unauthenticated. The code is the capability. The response is match, no-match
 * or unbound. It never includes the recorded name, date of birth, or hashes.
 */

export const dynamic = 'force-dynamic';

const STATUS: Record<string, number> = {
  match: 200,
  no_match: 200,
  unbound: 200,
  not_found: 404,
  rate_limited: 429,
  invalid: 400,
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const ipAddress = clientIp(request);
  const userAgent = request.headers.get('user-agent');

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  try {
    const result = await checkCertificateHolder({ code, body, ipAddress, userAgent });
    return NextResponse.json({ result }, { status: STATUS[result] ?? 500 });
  } catch {
    return NextResponse.json({ result: 'error' }, { status: 500 });
  }
}
