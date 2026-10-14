import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue: unknown[][] = [];
let updates = 0;

vi.mock('@/db/client', () => {
  function makeChain(next: () => unknown): unknown {
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    for (const method of ['from', 'where', 'limit', 'set']) {
      chain[method] = passthrough;
    }
    chain.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve().then(next).then(resolve, reject);
    return chain;
  }

  return {
    db: {
      select: () => makeChain(() => queue.shift() ?? []),
      update: () =>
        makeChain(() => {
          updates += 1;
          return [];
        }),
    },
  };
});

const { resolveApiKeyContext, ApiKeyError } = await import('@/domains/api-keys/resolve');
const { OrganisationUnavailableError } =
  await import('@/lib/tenancy/organisation-status');
const { apiErrorResponse } = await import('@/lib/http/api-route');

const trace = { correlationId: 'corr-1', requestId: 'req-1' };
const keyRow = {
  id: 'key-1',
  organisationId: 'org-1',
  revokedAt: null,
  expiresAt: null,
  scopes: ['application:read-any'],
};

beforeEach(() => {
  queue.length = 0;
  updates = 0;
});

describe('resolveApiKeyContext organisation status', () => {
  it('refuses a suspended organisation before recording use', async () => {
    queue.push([keyRow], [{ status: 'suspended' }]);
    await expect(resolveApiKeyContext('bp_secret', trace)).rejects.toBeInstanceOf(
      OrganisationUnavailableError,
    );
    expect(updates).toBe(0);
  });

  it('maps that refusal to 403', () => {
    const response = apiErrorResponse(new OrganisationUnavailableError());
    expect(response.status).toBe(403);
  });

  it('accepts a key for an active organisation', async () => {
    queue.push([keyRow], [{ status: 'active' }]);
    const ctx = await resolveApiKeyContext('bp_secret', trace);
    expect(ctx.organisationId).toBe('org-1');
    expect(ctx.roles).toEqual(['api-key']);
    expect(updates).toBe(1);
  });

  it('still rejects a revoked key as an invalid key', async () => {
    queue.push([{ ...keyRow, revokedAt: new Date() }]);
    await expect(resolveApiKeyContext('bp_secret', trace)).rejects.toBeInstanceOf(
      ApiKeyError,
    );
    expect(updates).toBe(0);
  });
});
