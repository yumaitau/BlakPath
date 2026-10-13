import { NextResponse, type NextRequest } from 'next/server';
import { clientIp } from '@/lib/http/client-ip';
import { REQUEST_LIMITS, enforcePair } from '@/lib/http/request-limits';

/**
 * Request limits for the public form and certificate pages.
 *
 * Those routes are server components, which cannot set a 429 status. This
 * proxy runs on the Node.js runtime (the Proxy default) and answers before
 * render. The pages themselves do not count again.
 *
 * Matcher is only these two paths. Other routes limit inside their handlers.
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
  const { pathname } = request.nextUrl;
  const formToken = subjectFrom(pathname, '/form');
  if (formToken) {
    const limited = await enforcePair(
      REQUEST_LIMITS.formPage,
      clientIp(request.headers),
      formToken,
    );
    if (limited) return limited;
  }
  const code = subjectFrom(pathname, '/verify');
  if (code) {
    const limited = await enforcePair(
      REQUEST_LIMITS.verifyPage,
      clientIp(request.headers),
      code,
    );
    if (limited) return limited;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/form/:token', '/verify/:code'],
};
