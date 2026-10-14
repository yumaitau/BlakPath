/**
 * Post-sign-in return paths.
 *
 * When a session expires (or the user is signed out for inactivity) we send
 * them to sign-in with a `returnTo` pointing at the page they were on, so they
 * land back where they left off. `returnTo` arrives from the query string, so
 * it is untrusted: only a same-origin, relative application path is honoured.
 * Anything else (absolute URLs, protocol-relative `//host`, backslash tricks,
 * control characters, API or auth routes) collapses to the fallback. This is
 * the open-redirect guard — keep it strict.
 *
 * Pure and dependency-free so it can run in the browser, on the server and in
 * unit tests.
 */

/** Request header the proxy uses to tell server components the current path. */
export const CURRENT_PATH_HEADER = 'x-blakpath-path';

/** Where a signed-in user goes when no (valid) return path was requested. */
export const DEFAULT_RETURN_PATH = '/dashboard';

/** Why the user was sent to sign-in; drives the notice shown there. */
export type SignInReason = 'expired' | 'idle';

const MAX_RETURN_PATH_LENGTH = 512;

/** Routes that must never be a post-sign-in destination. */
const BLOCKED_PREFIXES = [
  '/api/',
  '/_next/',
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  // Redirects to its own `returnTo`; as a destination it would loop.
  '/select-organisation',
];

// A throwaway origin: parsing against it lets us prove the result stayed
// same-origin without depending on `window`.
const PROBE_ORIGIN = 'https://return-to.invalid';

/**
 * Returns `raw` normalised to `pathname + search` when it is a safe in-app
 * path, otherwise `fallback`.
 */
export function safeReturnTo(
  raw: string | null | undefined,
  fallback: string = DEFAULT_RETURN_PATH,
): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  if (raw.length > MAX_RETURN_PATH_LENGTH) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  // Backslashes are treated as slashes by browsers (`/\evil.example`), and
  // control characters / whitespace have no business in a return path.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return fallback;

  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;

  const path = url.pathname;
  if (BLOCKED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return fallback;
  }
  return `${path}${url.search}`;
}

/**
 * Builds the sign-in URL that returns the user to `returnTo` afterwards. An
 * unsafe or missing `returnTo` is dropped rather than forwarded.
 */
export function signInPath(returnTo?: string | null, reason?: SignInReason): string {
  const params = new URLSearchParams();
  const safe = safeReturnTo(returnTo, '');
  if (safe) params.set('returnTo', safe);
  if (reason) params.set('reason', reason);
  const query = params.toString();
  return query ? `/sign-in?${query}` : '/sign-in';
}

/**
 * Builds the organisation-picker URL that continues to `returnTo` once an
 * organisation is chosen (a fresh sign-in has none selected yet). The default
 * destination is implied, so it is not carried.
 */
export function selectOrganisationPath(returnTo?: string | null): string {
  const safe = safeReturnTo(returnTo, '');
  return safe && safe !== DEFAULT_RETURN_PATH
    ? `/select-organisation?${new URLSearchParams({ returnTo: safe })}`
    : '/select-organisation';
}

/** Reads the `reason` query value, accepting only known reasons. */
export function parseSignInReason(raw: string | null | undefined): SignInReason | null {
  return raw === 'expired' || raw === 'idle' ? raw : null;
}
