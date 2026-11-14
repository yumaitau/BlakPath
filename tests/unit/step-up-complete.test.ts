import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  requireSession: vi.fn(),
  sets: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/auth/session', () => {
  class UnauthenticatedError extends Error {}
  return { requireSession: state.requireSession, UnauthenticatedError };
});

vi.mock('@/db/client', () => ({
  db: {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        state.sets.push(patch);
        return { where: async () => [] };
      },
    }),
  },
}));

const { env } = await import('@/lib/env');
const { sealStepUpContext, STEP_UP_CONTEXT_COOKIE } =
  await import('@/lib/auth/step-up-context-cookie');
const { POST } = await import('@/app/api/session/step-up/complete/route');

const COMPLETE_URL = 'http://localhost/api/session/step-up/complete';

function requestWith(context?: {
  userId: string;
  sessionId: string;
  organisationId: string | null;
}): NextRequest {
  const headers = new Headers();
  if (context) {
    const token = sealStepUpContext(
      { ...context, exp: Date.now() + 60_000 },
      env.BETTER_AUTH_SECRET,
    );
    headers.set('cookie', `${STEP_UP_CONTEXT_COOKIE}=${token}`);
  }
  return new NextRequest(COMPLETE_URL, { method: 'POST', headers });
}

function signedInAs(sessionId: string, userId = 'user-1'): void {
  state.requireSession.mockResolvedValue({
    user: { id: userId },
    session: { id: sessionId },
  });
}

function expectCleared(response: Response): void {
  const cookie = response.headers.get('set-cookie') ?? '';
  expect(cookie).toContain(`${STEP_UP_CONTEXT_COOKIE}=`);
  expect(cookie).toContain('Max-Age=0');
}

describe('POST /api/session/step-up/complete', () => {
  beforeEach(() => {
    state.sets.length = 0;
    state.requireSession.mockReset();
  });

  it('refuses when the session completing is the session that prepared', async () => {
    signedInAs('session-1');
    const response = await POST(
      requestWith({ userId: 'user-1', sessionId: 'session-1', organisationId: 'org-1' }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: 'REAUTH_FAILED' });
    expect(state.sets).toEqual([]);
  });

  it('copies the organisation onto a new session and nothing else', async () => {
    signedInAs('session-2');
    const response = await POST(
      requestWith({ userId: 'user-1', sessionId: 'session-1', organisationId: 'org-1' }),
    );
    expect(response.status).toBe(200);
    expect(state.sets).toEqual([{ activeOrganisationId: 'org-1' }]);
    expect(state.sets[0]).not.toHaveProperty('lastAuthenticatedAt');
  });

  it('writes nothing when there is no organisation to copy', async () => {
    signedInAs('session-2');
    const response = await POST(
      requestWith({ userId: 'user-1', sessionId: 'session-1', organisationId: null }),
    );
    expect(response.status).toBe(200);
    expect(state.sets).toEqual([]);
  });

  it('refuses a context sealed for a different user', async () => {
    signedInAs('session-2');
    const response = await POST(
      requestWith({ userId: 'user-9', sessionId: 'session-1', organisationId: 'org-1' }),
    );
    expect(response.status).toBe(401);
    expect(state.sets).toEqual([]);
  });

  it('refuses when there is no context cookie', async () => {
    signedInAs('session-2');
    const response = await POST(requestWith());
    expect(response.status).toBe(401);
    expect(state.sets).toEqual([]);
  });

  it('clears the context cookie on refusal and on success', async () => {
    signedInAs('session-1');
    expectCleared(
      await POST(
        requestWith({
          userId: 'user-1',
          sessionId: 'session-1',
          organisationId: 'org-1',
        }),
      ),
    );
    signedInAs('session-2');
    expectCleared(
      await POST(
        requestWith({
          userId: 'user-1',
          sessionId: 'session-1',
          organisationId: 'org-1',
        }),
      ),
    );
  });
});
