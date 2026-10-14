import { beforeEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { url });
});
const headerValues = new Map<string, string>();

vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirect(url),
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Error && error.message === 'NEXT_REDIRECT') throw error;
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => headerValues.get(name) ?? null }),
}));
// The real session module boots Better Auth; only the error class is needed.
vi.mock('@/lib/auth/session', () => ({
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));
vi.mock('@/lib/http/tenant-route', () => ({
  NoActiveOrganisationError: class NoActiveOrganisationError extends Error {},
}));

const { classifyPageError, handlePageError, isRecordId } =
  await import('@/lib/http/page-errors');
const { UnauthenticatedError } = await import('@/lib/auth/session');
const { NoActiveOrganisationError } = await import('@/lib/http/tenant-route');
const { AuthorizationError } = await import('@/lib/permissions/errors');
const { TenantContextError } = await import('@/lib/tenancy/context');
const { CURRENT_PATH_HEADER } = await import('@/lib/auth/return-to');

describe('classifyPageError', () => {
  it('separates expiry, organisation, access and unexpected failures', () => {
    expect(classifyPageError(new UnauthenticatedError())).toBe('unauthenticated');
    expect(classifyPageError(new NoActiveOrganisationError())).toBe('no-organisation');
    expect(classifyPageError(new AuthorizationError('POLICY_DENIED'))).toBe('forbidden');
    expect(classifyPageError(new TenantContextError('no membership'))).toBe('forbidden');
    // An outage must never be mistaken for an access refusal.
    expect(classifyPageError(new Error('connect ECONNREFUSED'))).toBe('unexpected');
    expect(classifyPageError('boom')).toBe('unexpected');
  });
});

describe('handlePageError', () => {
  beforeEach(() => {
    redirect.mockClear();
    headerValues.clear();
  });

  it('sends an expired session to sign-in, returning to the current page', async () => {
    headerValues.set(CURRENT_PATH_HEADER, '/applications?status=open');
    await expect(handlePageError(new UnauthenticatedError())).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(redirect).toHaveBeenCalledWith(
      '/sign-in?returnTo=%2Fapplications%3Fstatus%3Dopen&reason=expired',
    );
  });

  it('sends a missing organisation to the picker, keeping the destination', async () => {
    headerValues.set(CURRENT_PATH_HEADER, '/board');
    await expect(handlePageError(new NoActiveOrganisationError())).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(redirect).toHaveBeenCalledWith('/select-organisation?returnTo=%2Fboard');
  });

  it('returns for an access refusal so the page renders its 403 state', async () => {
    await expect(
      handlePageError(new AuthorizationError('PERMISSION_DENIED')),
    ).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('rethrows unexpected errors for the 500 boundary', async () => {
    const outage = new Error('database unavailable');
    await expect(handlePageError(outage)).rejects.toBe(outage);
  });
});

describe('isRecordId', () => {
  it('accepts UUIDs only', () => {
    expect(isRecordId('0192f3a4-5b6c-7d8e-9f01-23456789abcd')).toBe(true);
    expect(isRecordId('not-an-id')).toBe(false);
    expect(isRecordId("1' or 1=1")).toBe(false);
  });
});
