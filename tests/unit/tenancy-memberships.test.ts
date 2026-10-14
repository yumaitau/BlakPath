import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '@/lib/auth/session';
import { script } from './helpers/scripted-db';

// Bound handles (scopeFor / platformDb) reach the mocked client below.
vi.mock('@/db/platform-db', () =>
  import('../helpers/bound-db-mocks').then((m) => m.platformDbModule()),
);
vi.mock('@/db/tenant-db', () =>
  import('../helpers/bound-db-mocks').then((m) => m.tenantDbModule()),
);
vi.mock('@/db/client', async () => {
  const { scriptedDatabase } = await import('./helpers/scripted-db');
  return { db: scriptedDatabase() };
});

const { getActiveOrganisationId, listMembershipsForUser } =
  await import('@/lib/tenancy/memberships');

beforeEach(() => {
  script.reset();
});

describe('organisation selection reads', () => {
  it('prefers a trading name and returns null when no organisation is active', async () => {
    script.results.push([
      {
        organisationId: 'org-1',
        legalName: 'Legal Name',
        tradingName: 'Trading Name',
        slug: 'trading',
        status: 'active',
      },
      {
        organisationId: 'org-2',
        legalName: 'Only Legal',
        tradingName: null,
        slug: 'legal',
        status: 'active',
      },
    ]);

    await expect(listMembershipsForUser('user-1')).resolves.toEqual([
      {
        organisationId: 'org-1',
        organisationName: 'Trading Name',
        slug: 'trading',
        status: 'active',
      },
      {
        organisationId: 'org-2',
        organisationName: 'Only Legal',
        slug: 'legal',
        status: 'active',
      },
    ]);

    const selected = { session: { activeOrganisationId: 'org-1' } } as ServerSession;
    const empty = { session: {} } as ServerSession;
    expect(getActiveOrganisationId(selected)).toBe('org-1');
    expect(getActiveOrganisationId(empty)).toBeNull();
  });
});
