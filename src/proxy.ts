import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { clientIpForLimits, originRequestAllowed } from '@/lib/http/client-ip';
import { REQUEST_LIMITS, enforcePair } from '@/lib/http/request-limits';

/**
 * Production origin gate, then request limits for the public form and
 * certificate pages.
 *
 * The load balancer verifies the zone client certificate. This check is the
 * application backstop: a request that reaches the process without the
 * origin-verify secret is refused. Health probes are excluded by the matcher.
 *
 * Form and certificate pages are server components, which cannot set a 429
 * status. The limit runs here, before render. The pages themselves do not
 * count again.
 */

function subjectFrom(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(`${prefix}/`)) return null;
  const raw = pathname.slice(prefix.length + 1);
  if (!raw || raw.includes('/')) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (
    !originRequestAllowed({
      pathname: request.nextUrl.pathname,
      headers: request.headers,
      nodeEnv: env.NODE_ENV,
      originVerifySecret: env.ORIGIN_VERIFY_SECRET,
    })
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { pathname } = request.nextUrl;
  const formToken = subjectFrom(pathname, '/form');
  if (formToken) {
    const limited = await enforcePair(
      REQUEST_LIMITS.formPage,
      clientIpForLimits(request.headers),
      formToken,
    );
    if (limited) return limited;
  }
  const code = subjectFrom(pathname, '/verify');
  if (code) {
    const limited = await enforcePair(
      REQUEST_LIMITS.verifyPage,
      clientIpForLimits(request.headers),
      code,
    );
    if (limited) return limited;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health|api/ready|api/live).*)'],
};
