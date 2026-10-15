import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '@/lib/auth/session';
import type { UserMembership } from '@/lib/tenancy/memberships';

/**
 * Staff shell guard. Order matters: no session → sign-in, no organisation →
 * picker, unavailable organisation → generic refusal (before role routing),
 * revoked membership → picker, applicant-only → portal, otherwise the shell.
 */

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const state = vi.hoisted(() => ({
  session: null as unknown,
  path: null as string | null,
  cookie: null as string | null,
  memberships: [] as unknown[],
  access: 'operational' as 'operational' | 'unavailable' | 'none',
  roles: [] as string[],
  calls: [] as string[],
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers(state.path ? { 'x-blakpath-path': state.path } : undefined),
}));

vi.mock('better-auth/cookies', () => ({
  getSessionCookie: () => state.cookie,
}));

vi.mock('@/lib/auth/session', () => ({
  getServerSession: async () => state.session,
}));

vi.mock('@/lib/tenancy/memberships', () => ({
  getActiveOrganisationId: (session: ServerSession) =>
    (session.session as { activeOrganisationId?: string | null }).activeOrganisationId ??
    null,
  listMembershipsForUser: async () => {
    state.calls.push('memberships');
    return state.memberships;
  },
  organisationAccessForUser: async () => {
    state.calls.push('access');
    return state.access;
  },
  listRoleSlugsForUserOrganisation: async () => {
    state.calls.push('roles');
    return state.roles;
  },
}));

const { loadStaffShell } = await import('@/lib/tenancy/staff-shell');

const ORG = 'org-1';
const membership: UserMembership = {
  organisationId: ORG,
  organisationName: 'Dev Org',
  slug: 'dev-org',
  status: 'active',
};

function signedIn(activeOrganisationId: string | null = ORG): void {
  state.session = {
    user: { id: 'user-1' },
    session: { id: 'session-1', activeOrganisationId },
  };
}

async function redirectOf(): Promise<string> {
  try {
    await loadStaffShell();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  state.session = null;
  state.path = null;
  state.cookie = null;
  state.memberships = [membership];
  state.access = 'operational';
  state.roles = ['case-officer'];
  state.calls = [];
});

describe('loadStaffShell', () => {
  it('sends a signed-out visitor to sign-in with the requested page', async () => {
    state.path = '/applications';
    await expect(redirectOf()).resolves.toBe('/sign-in?returnTo=%2Fapplications');
  });

  it('marks a leftover session cookie as an expired session', async () => {
    state.path = '/dashboard';
    state.cookie = 'stale-token';
    await expect(redirectOf()).resolves.toBe(
      '/sign-in?returnTo=%2Fdashboard&reason=expired',
    );
  });

  it('sends a session with no organisation to the picker, keeping returnTo', async () => {
    signedIn(null);
    state.path = '/meetings';
    await expect(redirectOf()).resolves.toBe('/select-organisation?returnTo=%2Fmeetings');
  });

  it('refuses an unavailable organisation before reading roles', async () => {
    signedIn();
    state.access = 'unavailable';
    state.roles = ['applicant'];
    await expect(loadStaffShell()).resolves.toEqual({
      unavailable: true,
      canSwitch: true,
    });
    expect(state.calls).not.toContain('roles');
  });

  it('reports no other organisation to switch to', async () => {
    signedIn();
    state.access = 'unavailable';
    state.memberships = [];
    await expect(loadStaffShell()).resolves.toEqual({
      unavailable: true,
      canSwitch: false,
    });
  });

  it('treats a revoked membership like no selection', async () => {
    signedIn('org-revoked');
    await expect(redirectOf()).resolves.toBe('/select-organisation');
    expect(state.calls).not.toContain('roles');
  });

  it('sends an applicant-only membership to the portal, never the shell', async () => {
    signedIn();
    state.path = '/dashboard';
    state.roles = ['applicant'];
    await expect(redirectOf()).resolves.toBe('/portal');

    state.roles = ['applicant', 'applicant-representative'];
    await expect(redirectOf()).resolves.toBe('/portal');
  });

  it('keeps staff and mixed-role memberships in the staff shell', async () => {
    signedIn();
    for (const roles of [['case-officer'], ['applicant', 'intake-officer'], []]) {
      state.roles = roles;
      await expect(loadStaffShell()).resolves.toEqual({
        unavailable: false,
        session: state.session,
        organisations: [membership],
        activeOrganisationId: ORG,
      });
    }
  });
});
