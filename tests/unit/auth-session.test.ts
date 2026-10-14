import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

const { auth } = await import('@/lib/auth');
const {
  STEP_UP_WINDOWS,
  StepUpRequiredError,
  UnauthenticatedError,
  getServerSession,
  requireRecentAuth,
  requireSession,
  requireUser,
} = await import('@/lib/auth/session');

const getSession = vi.spyOn(auth.api, 'getSession');

beforeEach(() => {
  getSession.mockReset();
});

describe('server session', () => {
  it('exposes the auth config and treats a missing session as signed out', async () => {
    expect(auth).toBeTruthy();
    expect(STEP_UP_WINDOWS.privileged).toBe(5 * 60);
    getSession.mockResolvedValue(null);

    await expect(getServerSession()).resolves.toBeNull();
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('returns the user and enforces a fresh authentication for sensitive actions', async () => {
    getSession.mockResolvedValue({
      user: { id: 'user-1', email: 'staff@council.example', name: 'Staff' },
      session: { id: 'session-1', createdAt: new Date() },
    } as never);

    await expect(requireUser()).resolves.toMatchObject({ id: 'user-1' });
    await expect(
      requireRecentAuth(STEP_UP_WINDOWS.sensitiveAction),
    ).resolves.toMatchObject({
      user: { id: 'user-1' },
    });

    getSession.mockResolvedValue({
      user: { id: 'user-1' },
      session: { id: 'session-1', createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    } as never);
    await expect(requireRecentAuth(STEP_UP_WINDOWS.privileged)).rejects.toBeInstanceOf(
      StepUpRequiredError,
    );
  });
});
