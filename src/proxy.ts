import { NextResponse, type NextRequest } from 'next/server';
import { CURRENT_PATH_HEADER } from '@/lib/auth/return-to';
import { env } from '@/lib/env';
import { clientIpForLimits, originRequestAllowed } from '@/lib/http/client-ip';
import {
  buildContentSecurityPolicy,
  uploadOrigin,
  createNonce,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
} from '@/lib/http/content-security-policy';
import { evaluateCookieMutation } from '@/lib/http/mutation-guard';
import { REQUEST_LIMITS, enforcePair } from '@/lib/http/request-limits';

/**
 * Production origin gate, cookie-authenticated mutation checks, CSP, then
 * request limits for the public form and certificate pages.
 *
 * The load balancer verifies the zone client certificate. A request that
 * reaches the process without the origin-verify secret is refused. Health
 * probes stay open. Cookie-authenticated `/api` mutations must come from the
 * app origin with a JSON content type. Authorisation still happens in the
 * route handlers.
 *
 * Page requests also get the requested path forwarded as a request header, so
 * a server-side redirect to sign-in (expired session) can carry `returnTo` and
 * bring the user back. That header makes no access decision; any
 * client-supplied value is dropped here, and every consumer still passes it
 * through `safeReturnTo` before use.
 */

/** `pathname?search` for the current page, minus the RSC cache-buster. */
function currentPagePath(url: URL): string {
  const search = new URLSearchParams(url.search);
  search.delete('_rsc');
  const query = search.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

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

function policyHeaders(contentSecurityPolicy: string): HeadersInit {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': contentSecurityPolicy,
    'Reporting-Endpoints': `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`,
  };
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

  const nonce = createNonce();
  const appOrigin = new URL(env.APP_URL).origin;
  const contentSecurityPolicy = buildContentSecurityPolicy({
    nonce,
    development: env.NODE_ENV === 'development',
    upgradeInsecureRequests: appOrigin.startsWith('https://'),
    connectSources: [
      uploadOrigin({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET_QUARANTINE,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      }),
    ],
  });

  const decision = evaluateCookieMutation({
    pathname: request.nextUrl.pathname,
    method: request.method,
    origin: request.headers.get('origin'),
    contentType: request.headers.get('content-type'),
    appOrigin,
  });
  if (!decision.allow) {
    return NextResponse.json(
      { error: 'Forbidden' },
      { status: 403, headers: policyHeaders(contentSecurityPolicy) },
    );
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
  const letterToken = subjectFrom(pathname, '/c');
  if (letterToken) {
    const limited = await enforcePair(
      REQUEST_LIMITS.correspondencePage,
      clientIpForLimits(request.headers),
      letterToken,
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

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.delete(CURRENT_PATH_HEADER);
  if (!pathname.startsWith('/api/')) {
    requestHeaders.set(CURRENT_PATH_HEADER, currentPagePath(request.nextUrl));
  }
  requestHeaders.set('Content-Security-Policy', contentSecurityPolicy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', contentSecurityPolicy);
  response.headers.set('Reporting-Endpoints', `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/health|api/ready|api/live|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
