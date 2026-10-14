/**
 * Session-expiry detection for client-side `fetch`.
 *
 * Most client components call our JSON API directly and, on a 401, either
 * ignored it or showed a dead-end message. The staff shell installs this guard
 * once: when a same-origin API call comes back 401 because the session is gone,
 * `onExpired` runs (the shell sends the user to sign-in, returning them to the
 * current page afterwards). The response is still handed back unchanged so the
 * calling component behaves as before.
 *
 * A step-up refusal (`code: 'STEP_UP_REQUIRED'`) or a failed step-up completion
 * (`code: 'REAUTH_FAILED'`) is also a 401 but the session is still valid — the
 * component asks for re-authentication itself — so neither is treated as
 * expiry. Auth endpoints (`/api/auth/*`) answer 401
 * for wrong passwords and codes, so they are excluded too.
 */

interface FetchHost {
  fetch: typeof fetch;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** True when `input` targets this origin's session-authenticated API. */
export function isGuardedApiRequest(input: RequestInfo | URL, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(requestUrl(input), origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  return url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/');
}

/** 401 codes that mean "re-authenticate", not "signed out". */
const STEP_UP_CODES: ReadonlySet<unknown> = new Set([
  'STEP_UP_REQUIRED',
  'REAUTH_FAILED',
]);

/** True when a 401 body says "re-authenticate" rather than "signed out". */
async function isStepUpRefusal(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    return (
      typeof body === 'object' &&
      body !== null &&
      STEP_UP_CODES.has((body as { code?: unknown }).code)
    );
  } catch {
    return false;
  }
}

/**
 * Wraps `host.fetch`. Returns an uninstall function that restores the original
 * (only if nothing else has replaced it since).
 */
export function installSessionExpiryGuard(
  host: FetchHost,
  origin: string,
  onExpired: () => void,
): () => void {
  const original = host.fetch;

  const guarded: typeof fetch = async (input, init) => {
    const response = await original.call(host, input, init);
    if (
      response.status === 401 &&
      isGuardedApiRequest(input, origin) &&
      !(await isStepUpRefusal(response))
    ) {
      onExpired();
    }
    return response;
  };

  host.fetch = guarded;
  return () => {
    if (host.fetch === guarded) host.fetch = original;
  };
}
