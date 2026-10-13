/**
 * Post-deploy smoke checks.
 * Sign-in proves the auth endpoint accepted a human account.
 * It does not score, rank, infer, approve, or reject identity.
 */

const SESSION_COOKIE = /(?:^|;\s*)(?:__Host-|__Secure-)?blakpath\.session_token=[^;]+/;

export function readyAccepted(status: number, body: unknown): boolean {
  if (status !== 200 || !body || typeof body !== 'object') return false;
  return (body as { status?: unknown }).status === 'ready';
}

export function hasSessionCookie(cookies: readonly string[]): boolean {
  return cookies.some((cookie) => SESSION_COOKIE.test(cookie));
}

/**
 * A completed session or a second-factor challenge both mean the password was accepted.
 * A second-factor challenge is success: staff MFA must not be bypassed to make smoke pass.
 */
export function signInAccepted(
  status: number,
  body: unknown,
  cookies: readonly string[],
): boolean {
  if (status !== 200 || !body || typeof body !== 'object') return false;
  const record = body as { twoFactorRedirect?: unknown; user?: unknown };
  if (record.twoFactorRedirect === true) return true;
  return hasSessionCookie(cookies) && !!record.user && typeof record.user === 'object';
}

export async function pollReady(
  probe: () => Promise<boolean>,
  options: { attempts: number; delayMs: number; sleep: (ms: number) => Promise<void> },
): Promise<boolean> {
  if (options.attempts < 1) throw new Error('ready probe needs at least one attempt');
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    if (await probe()) return true;
    if (attempt < options.attempts - 1) await options.sleep(options.delayMs);
  }
  return false;
}
