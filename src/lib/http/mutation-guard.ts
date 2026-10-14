/**
 * Origin and content-type gate for cookie-authenticated `/api` mutations.
 *
 * A mutation is allowed only when `Origin` matches the configured application
 * origin and the body is `application/json`.
 *
 * Paths in `MUTATION_ORIGIN_EXEMPT_PREFIXES` are not session-cookie authorities.
 * Do not mount a cookie-authenticated mutation under one of them.
 */

export const MUTATION_ORIGIN_EXEMPT_PREFIXES = [
  '/api/auth',
  '/api/mcp',
  '/api/v1',
  '/api/scim',
  '/api/email/events',
  '/api/admin/pilot-bootstrap',
  '/api/public',
  '/api/csp-report',
] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export type MutationGuardDecision =
  | { allow: true }
  | { allow: false; reason: 'origin' | 'content-type' };

export function isMutationOriginExempt(pathname: string): boolean {
  return MUTATION_ORIGIN_EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function originsMatch(header: string | null, appOrigin: string): boolean {
  if (!header || header === 'null') return false;
  try {
    return new URL(header).origin === appOrigin;
  } catch {
    return false;
  }
}

/**
 * `appOrigin` is `new URL(APP_URL).origin`, not the raw configured string.
 * Non-API paths and safe methods are ignored. Exempt prefixes skip both checks.
 */
export function evaluateCookieMutation(input: {
  pathname: string;
  method: string;
  origin: string | null;
  contentType: string | null;
  appOrigin: string;
}): MutationGuardDecision {
  if (!input.pathname.startsWith('/api/')) return { allow: true };
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { allow: true };
  if (isMutationOriginExempt(input.pathname)) return { allow: true };
  if (!originsMatch(input.origin, input.appOrigin)) {
    return { allow: false, reason: 'origin' };
  }
  if (!isJsonContentType(input.contentType)) {
    return { allow: false, reason: 'content-type' };
  }
  return { allow: true };
}
