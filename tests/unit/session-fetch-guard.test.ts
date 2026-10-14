import { describe, expect, it, vi } from 'vitest';
import { installSessionExpiryGuard, isGuardedApiRequest } from '@/lib/auth/fetch-guard';

const ORIGIN = 'https://app.blakpath.test';

function hostReturning(response: () => Response) {
  const original = vi.fn(async () => response());
  const host = { fetch: original as unknown as typeof fetch };
  return { host, original };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('isGuardedApiRequest', () => {
  it('guards same-origin API calls only', () => {
    expect(isGuardedApiRequest('/api/applications', ORIGIN)).toBe(true);
    expect(isGuardedApiRequest(`${ORIGIN}/api/tasks/1/move`, ORIGIN)).toBe(true);
    expect(isGuardedApiRequest(new URL('/api/forms', ORIGIN), ORIGIN)).toBe(true);
    expect(isGuardedApiRequest(new Request(`${ORIGIN}/api/clients`), ORIGIN)).toBe(true);
  });

  it('ignores auth endpoints, pages and other origins', () => {
    expect(isGuardedApiRequest('/api/auth/sign-in/email', ORIGIN)).toBe(false);
    expect(isGuardedApiRequest('/dashboard', ORIGIN)).toBe(false);
    expect(isGuardedApiRequest('https://other.example/api/x', ORIGIN)).toBe(false);
  });
});

describe('installSessionExpiryGuard', () => {
  it('signals expiry on a session 401 and still returns the response', async () => {
    const { host } = hostReturning(() => json(401, { error: 'Unauthorized' }));
    const onExpired = vi.fn();
    installSessionExpiryGuard(host, ORIGIN, onExpired);

    const response = await host.fetch('/api/applications');
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
    // The body is still readable by the calling component.
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('does not treat a step-up refusal as expiry', async () => {
    const { host } = hostReturning(() =>
      json(401, { error: 'Re-authentication required', code: 'STEP_UP_REQUIRED' }),
    );
    const onExpired = vi.fn();
    installSessionExpiryGuard(host, ORIGIN, onExpired);

    await host.fetch('/api/certificates/1/sign', { method: 'POST' });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('does not treat a failed step-up completion as expiry', async () => {
    const { host } = hostReturning(() => json(401, { code: 'REAUTH_FAILED' }));
    const onExpired = vi.fn();
    installSessionExpiryGuard(host, ORIGIN, onExpired);

    await host.fetch('/api/session/step-up/complete', { method: 'POST' });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('treats a non-JSON 401 as expiry', async () => {
    const { host } = hostReturning(() => new Response('nope', { status: 401 }));
    const onExpired = vi.fn();
    installSessionExpiryGuard(host, ORIGIN, onExpired);

    await host.fetch('/api/tasks');
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('ignores other statuses and auth endpoint 401s', async () => {
    const statuses = [200, 403, 500];
    for (const status of statuses) {
      const { host } = hostReturning(() => json(status, {}));
      const onExpired = vi.fn();
      installSessionExpiryGuard(host, ORIGIN, onExpired);
      await host.fetch('/api/applications');
      expect(onExpired).not.toHaveBeenCalled();
    }

    const { host } = hostReturning(() => json(401, { error: 'Unauthorized' }));
    const onExpired = vi.fn();
    installSessionExpiryGuard(host, ORIGIN, onExpired);
    await host.fetch('/api/auth/two-factor/verify-totp', { method: 'POST' });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('passes arguments through and restores the original fetch on uninstall', async () => {
    const { host, original } = hostReturning(() => json(200, { ok: true }));
    const uninstall = installSessionExpiryGuard(host, ORIGIN, vi.fn());
    expect(host.fetch).not.toBe(original);

    const init = { method: 'POST', body: '{}' };
    await host.fetch('/api/forms', init);
    expect(original).toHaveBeenCalledWith('/api/forms', init);

    uninstall();
    expect(host.fetch).toBe(original);
  });
});
