import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';
import { RESET_RESPONSE_BUDGET_MS, withConstantTime } from '@/lib/auth/reset-timing';
import { headersWithTrustedClientIp } from '@/lib/http/client-ip';

/**
 * Better Auth HTTP surface.
 *
 * This catch-all mounts every Better Auth endpoint (sign in/up, verification,
 * password reset, passkey registration/authentication, TOTP enrolment and
 * verification) under `/api/auth/*`. Keeping it same-origin means the auth
 * cookies stay httpOnly and scoped to this origin; the browser client in
 * `@/lib/auth/client` talks to exactly these routes.
 *
 * All security policy — hashing, rate limits, cookie flags, MFA — is defined in
 * the `auth` instance; this file wires that instance to Next.js. Before the
 * handler runs, forwarded address headers are replaced with the trusted client
 * address so rate limits and stored session addresses follow `clientIp`.
 *
 * Password-reset requests are held to a fixed budget so a known address and
 * an unknown one finish together when the work itself is faster than that.
 */
const handler = toNextJsHandler(auth);

/**
 * Next hands the route its own Request subclass, which `new Request(request)`
 * cannot clone (`#state` belongs to another class). Copy the parts instead.
 */
async function withTrustedClientIp(request: Request): Promise<Request> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(request.url, {
    method: request.method,
    headers: headersWithTrustedClientIp(request.headers),
    signal: request.signal,
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
  });
}

export async function GET(request: Request): Promise<Response> {
  return handler.GET(await withTrustedClientIp(request));
}

const RESET_PATHS = ['/forget-password', '/request-password-reset'] as const;

export async function POST(request: Request): Promise<Response> {
  const trusted = await withTrustedClientIp(request);
  const { pathname } = new URL(request.url);
  if (!RESET_PATHS.some((path) => pathname.endsWith(path))) return handler.POST(trusted);
  return withConstantTime(RESET_RESPONSE_BUDGET_MS, () => handler.POST(trusted));
}
