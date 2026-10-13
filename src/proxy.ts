import { NextResponse, type NextRequest } from 'next/server';
import { CURRENT_PATH_HEADER } from '@/lib/auth/return-to';

/**
 * Request proxy (Next.js 16 `proxy.ts`, formerly middleware).
 *
 * It does ONE thing: forward the requested page path to server components as
 * a request header, so a server-side redirect to sign-in (expired session) can
 * carry `returnTo` and bring the user back to the page they were on. Layouts
 * cannot otherwise read the current pathname.
 *
 * It makes no authentication or authorisation decision — those stay in the
 * staff layout, route handlers and the tenancy layer. Any client-supplied value
 * for the header is overwritten here, and every consumer still passes it
 * through `safeReturnTo` before use.
 */
export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const search = new URLSearchParams(url.search);
  // React Server Component fetches carry an internal cache-busting parameter
  // that is meaningless as a destination.
  search.delete('_rsc');
  const query = search.toString();

  const headers = new Headers(request.headers);
  headers.set(CURRENT_PATH_HEADER, query ? `${url.pathname}?${query}` : url.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Pages only: skip API routes, Next internals and static files.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[A-Za-z0-9]+$).*)'],
};
