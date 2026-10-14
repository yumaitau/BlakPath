import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue: unknown[][] = [];

vi.mock('@/db/client', () => {
  function makeChain(): unknown {
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    for (const method of ['from', 'where', 'innerJoin', 'limit', 'orderBy']) {
      chain[method] = passthrough;
    }
    chain.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => {
      const next = queue.shift() ?? [];
      return Promise.resolve(next).then(resolve, reject);
    };
    return chain;
  }

  return { db: { select: () => makeChain() } };
});

const { hasUnavailableOrganisationMembership, organisationAccessForUser } =
  await import('@/lib/tenancy/memberships');

beforeEach(() => {
  queue.length = 0;
});

describe('organisationAccessForUser', () => {
  it('classifies operational, unavailable and missing memberships', async () => {
    queue.push([{ status: 'active' }]);
    expect(await organisationAccessForUser('user-1', 'org-1')).toBe('operational');

    queue.push([{ status: 'onboarding' }]);
    expect(await organisationAccessForUser('user-1', 'org-1')).toBe('operational');

    queue.push([{ status: 'suspended' }]);
    expect(await organisationAccessForUser('user-1', 'org-1')).toBe('unavailable');

    queue.push([{ status: 'closed' }]);
    expect(await organisationAccessForUser('user-1', 'org-1')).toBe('unavailable');

    queue.push([]);
    expect(await organisationAccessForUser('user-1', 'org-1')).toBe('none');
  });
});

describe('hasUnavailableOrganisationMembership', () => {
  it('is true only when a row is returned', async () => {
    queue.push([{ id: 'membership-1' }]);
    expect(await hasUnavailableOrganisationMembership('user-1')).toBe(true);
    queue.push([]);
    expect(await hasUnavailableOrganisationMembership('user-1')).toBe(false);
  });
});
