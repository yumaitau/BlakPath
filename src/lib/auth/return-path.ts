/**
 * Allow-list of post-sign-in paths. Anything else, including absolute URLs,
 * falls back to role routing. Invitation links stay on the join page.
 */
const SAFE_RETURN_PATHS: readonly RegExp[] = [
  /^\/join\/[A-Za-z0-9_-]{20,200}$/,
  /^\/home$/,
  /^\/portal$/,
  /^\/portal\/[0-9a-fA-F-]{36}$/,
  /^\/organisations\/[a-z0-9]+(?:-[a-z0-9]+)*\/apply$/,
];

export function safeReturnPath(requested: string | null, fallback = '/home'): string {
  if (!requested) return fallback;
  return SAFE_RETURN_PATHS.some((pattern) => pattern.test(requested))
    ? requested
    : fallback;
}
