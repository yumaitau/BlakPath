import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The db mock returns a chainable query-builder stub. Each top-level
 * `db.select(...)` call in resolve.ts consumes the next queued result:
 *   1. membership lookup
 *   2. roles lookup
 *   3. permissions lookup
 * A queued result is the array the awaited chain should resolve to.
 */
const queue: unknown[][] = [];

// Bound handles (scopeFor / platformDb) reach the mocked client below.
vi.mock('@/db/platform-db', () =>
  import('../helpers/bound-db-mocks').then((m) => m.platformDbModule()),
);
vi.mock('@/db/tenant-db', () =>
  import('../helpers/bound-db-mocks').then((m) => m.tenantDbModule()),
);
vi.mock('@/db/client', () => {
  /** A thenable, chainable stub. Any builder method returns the same object;
   *  awaiting it resolves to the head of the result queue. */
  function makeChain(): unknown {
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    for (const method of [
      'from',
      'where',
      'innerJoin',
      'leftJoin',
      'limit',
      'orderBy',
      'groupBy',
    ]) {
      chain[method] = passthrough;
    }
    // Make the chain awaitable: it resolves to the next queued result.
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

  return {
    db: {
      select: () => makeChain(),
    },
  };
});

// Import AFTER the mock is registered.
const { resolveTenantContext } = await import('@/lib/tenancy/resolve');
const { TenantContextError } = await import('@/lib/tenancy/context');
const { OrganisationUnavailableError } =
  await import('@/lib/tenancy/organisation-status');

const baseInput = {
  userId: 'user-1',
  sessionId: 'session-1',
  organisationId: 'org-1',
  correlationId: 'corr-1',
  requestId: 'req-1',
} as const;

beforeEach(() => {
  queue.length = 0;
});

describe('resolveTenantContext', () => {
  it('rejects a user with no active membership of the supplied org', async () => {
    // Membership lookup returns nothing -> access denied.
    queue.push([]);
    await expect(resolveTenantContext({ ...baseInput })).rejects.toBeInstanceOf(
      TenantContextError,
    );
  });

  it('does not leak org existence in the denial message', async () => {
    queue.push([]);
    try {
      await resolveTenantContext({ ...baseInput });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantContextError);
      const message = (error as Error).message;
      expect(message).not.toContain('org-1');
      expect(message.toLowerCase()).toContain('do not have active access');
    }
  });

  it('builds a context from an active membership, its roles and permissions', async () => {
    queue.push([{ id: 'membership-1', organisationStatus: 'active' }]); // membership
    queue.push([
      { id: 'role-a', slug: 'case-officer' },
      { id: 'role-b', slug: 'committee-member' },
    ]); // roles
    queue.push([
      { permissionKey: 'application:read-assigned' },
      { permissionKey: 'decision:vote' },
      { permissionKey: 'not-a-real-permission' }, // must be dropped
    ]); // permissions

    const ctx = await resolveTenantContext({
      ...baseInput,
      ipAddress: '203.0.113.5',
      userAgent: 'test-agent',
    });

    expect(ctx.organisationId).toBe('org-1');
    expect(ctx.userId).toBe('user-1');
    expect(ctx.membershipId).toBe('membership-1');
    expect(ctx.roles).toEqual(['case-officer', 'committee-member']);
    expect([...ctx.permissions].sort()).toEqual([
      'application:read-assigned',
      'decision:vote',
    ]);
    // Stale grant to an unknown permission key never confers access.
    expect(ctx.permissions.has('not-a-real-permission')).toBe(false);
    expect(ctx.ipAddress).toBe('203.0.113.5');
    expect(ctx.userAgent).toBe('test-agent');
  });

  it.each(['suspended', 'closed'] as const)(
    'rejects a %s organisation without naming the status',
    async (organisationStatus) => {
      queue.push([{ id: 'membership-1', organisationStatus }]);
      try {
        await resolveTenantContext({ ...baseInput });
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(OrganisationUnavailableError);
        expect(error).toMatchObject({ status: 403 });
        const message = (error as Error).message.toLowerCase();
        expect(message).toContain('organisation unavailable');
        expect(message).not.toContain(organisationStatus);
        expect(message).not.toContain('org-1');
      }
    },
  );

  it.each(['draft', 'onboarding'] as const)(
    'allows an active membership while the organisation is %s',
    async (organisationStatus) => {
      queue.push([{ id: 'membership-3', organisationStatus }]);
      queue.push([]);
      const ctx = await resolveTenantContext({ ...baseInput });
      expect(ctx.membershipId).toBe('membership-3');
      expect(ctx.organisationId).toBe('org-1');
    },
  );

  it('yields an empty permission set when the membership has no roles', async () => {
    queue.push([{ id: 'membership-2', organisationStatus: 'active' }]); // membership
    queue.push([]); // roles
    // permissions lookup is skipped entirely when there are no roles.

    const ctx = await resolveTenantContext({ ...baseInput });
    expect(ctx.roles).toEqual([]);
    expect(ctx.permissions.size).toBe(0);
  });
});
