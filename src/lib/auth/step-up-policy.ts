/**
 * Step-up windows and the route map that must use them.
 *
 * Freshness is a pure comparison: a session is stale when its authentication
 * age is greater than the window. A session exactly at the window is still
 * fresh. Invalid timestamps fail closed.
 *
 * Routes call `requireRecentAuth(STEP_UP_ROUTES[key])` before reading params,
 * the body, or tenant data. The JSON body for a stale session always includes
 * `code` so the client can prompt without signing the person out.
 */

/** Common step-up windows, in seconds. Named so call sites read intent. */
export const STEP_UP_WINDOWS = {
  /** Break-glass decisions, secrets, and permission changes: 5 minutes. */
  privileged: 5 * 60,
  /** Evidence export and certificate signing or revocation: 10 minutes. */
  sensitiveAction: 10 * 60,
  /** Destructive retention changes: 15 minutes. */
  destructive: 15 * 60,
} as const;

export const STEP_UP_REQUIRED_CODE = 'STEP_UP_REQUIRED' as const;

/**
 * Documented route → window map for actions that export data, mint secrets,
 * or change authority. Keys are `METHOD /path` with Next.js dynamic segments.
 */
export const STEP_UP_ROUTES = {
  'GET /api/evidence/[id]/download': STEP_UP_WINDOWS.sensitiveAction,
  'POST /api/reports/exports': STEP_UP_WINDOWS.sensitiveAction,
  'GET /api/reports/exports/[id]/download': STEP_UP_WINDOWS.sensitiveAction,
  'POST /api/certificates/[id]/revoke': STEP_UP_WINDOWS.sensitiveAction,
  'POST /api/keys': STEP_UP_WINDOWS.privileged,
  'POST /api/webhooks': STEP_UP_WINDOWS.privileged,
  'POST /api/sso/providers': STEP_UP_WINDOWS.privileged,
  'DELETE /api/retention/holds/[id]': STEP_UP_WINDOWS.destructive,
  'DELETE /api/retention/policies/[id]': STEP_UP_WINDOWS.destructive,
  'POST /api/retention/policies/[id]/activate': STEP_UP_WINDOWS.destructive,
  'POST /api/retention/disposal-authorities': STEP_UP_WINDOWS.destructive,
  'POST /api/break-glass/[id]/deny': STEP_UP_WINDOWS.privileged,
  'POST /api/break-glass/[id]/revoke': STEP_UP_WINDOWS.privileged,
} as const;

export type StepUpRoute = keyof typeof STEP_UP_ROUTES;

/** True when `authenticatedAt` is missing, invalid, or older than the window. */
export function isAuthenticationStale(
  authenticatedAt: Date,
  maxAgeSeconds: number,
  now: Date = new Date(),
): boolean {
  const ageSeconds = (now.getTime() - authenticatedAt.getTime()) / 1000;
  return !Number.isFinite(ageSeconds) || ageSeconds > maxAgeSeconds;
}

/** Non-leaking 401 body. `code` is stable for the re-auth prompt. */
export function stepUpRequiredBody(): {
  error: string;
  code: typeof STEP_UP_REQUIRED_CODE;
} {
  return {
    error: 'Re-authentication required',
    code: STEP_UP_REQUIRED_CODE,
  };
}
