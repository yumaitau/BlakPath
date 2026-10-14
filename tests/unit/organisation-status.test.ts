import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue: unknown[][] = [];

vi.mock('@/db/client', () => {
  function makeChain(): unknown {
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    for (const method of ['from', 'where', 'limit']) {
      chain[method] = passthrough;
    }
    chain.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => {
      try {
        const next = queue.shift() ?? [];
        return Promise.resolve(next).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    };
    return chain;
  }

  return { db: { select: () => makeChain() } };
});

const {
  ORGANISATION_UNAVAILABLE_MESSAGE,
  OrganisationUnavailableError,
  assertOrganisationOperational,
  isOrganisationAcceptingWork,
  isOrganisationOperational,
} = await import('@/lib/tenancy/organisation-status');

beforeEach(() => {
  queue.length = 0;
});

describe('isOrganisationOperational', () => {
  it.each(['draft', 'onboarding', 'active'] as const)('accepts %s', (status) => {
    expect(isOrganisationOperational(status)).toBe(true);
  });

  it.each(['suspended', 'closed', null, undefined, ''] as const)(
    'rejects %s',
    (status) => {
      expect(isOrganisationOperational(status)).toBe(false);
    },
  );
});

describe('isOrganisationAcceptingWork', () => {
  it('skips an empty id or a missing organisation', async () => {
    expect(await isOrganisationAcceptingWork('')).toBe(false);
    queue.push([]);
    expect(await isOrganisationAcceptingWork('org-1')).toBe(false);
  });

  it('skips suspended and closed organisations', async () => {
    queue.push([{ status: 'suspended' }]);
    expect(await isOrganisationAcceptingWork('org-1')).toBe(false);
    queue.push([{ status: 'closed' }]);
    expect(await isOrganisationAcceptingWork('org-1')).toBe(false);
  });

  it('accepts an active organisation', async () => {
    queue.push([{ status: 'active' }]);
    expect(await isOrganisationAcceptingWork('org-1')).toBe(true);
  });
});

describe('assertOrganisationOperational', () => {
  it('throws a generic 403 for a closed organisation', async () => {
    queue.push([{ status: 'closed' }]);
    try {
      await assertOrganisationOperational('org-1');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OrganisationUnavailableError);
      expect(error).toMatchObject({ status: 403 });
      expect((error as Error).message).toBe(ORGANISATION_UNAVAILABLE_MESSAGE);
      expect((error as Error).message.toLowerCase()).not.toContain('closed');
    }
  });
});
