import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';
import { RESET_RESPONSE_BUDGET_MS, withConstantTime } from '@/lib/auth/reset-timing';

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
 * the `auth` instance; this file only wires that instance to Next.js request
 * handling. Rate limiting depends on `cf-connecting-ip`.
 *
 * Password-reset requests are held to a fixed budget so a known address and
 * an unknown one finish together when the work itself is faster than that.
 */
const { GET, POST: authPost } = toNextJsHandler(auth);

const RESET_PATHS = ['/forget-password', '/request-password-reset'] as const;

export async function POST(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!RESET_PATHS.some((path) => pathname.endsWith(path))) return authPost(request);
  return withConstantTime(RESET_RESPONSE_BUDGET_MS, () => authPost(request));
}

export { GET };
