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

const { getPublicForm, submitPublicResponse, FormTokenError } =
  await import('@/domains/forms/service');
const { OrganisationUnavailableError } =
  await import('@/lib/tenancy/organisation-status');

const invitation = {
  id: 'inv-1',
  status: 'pending',
  expiresAt: null,
  formId: 'form-1',
  organisationId: 'org-1',
};
const form = {
  id: 'form-1',
  organisationId: 'org-1',
  deletedAt: null,
  status: 'published',
};

beforeEach(() => {
  queue.length = 0;
  updates = 0;
});

describe('public form organisation status', () => {
  it('refuses a valid token when the organisation is closed', async () => {
    queue.push([invitation], [form], [{ status: 'closed' }]);
    await expect(getPublicForm('token')).rejects.toBeInstanceOf(
      OrganisationUnavailableError,
    );
    expect(updates).toBe(0);

    queue.push([invitation], [form], [{ status: 'suspended' }]);
    await expect(submitPublicResponse('token', {})).rejects.toBeInstanceOf(
      OrganisationUnavailableError,
    );
    expect(updates).toBe(0);
  });

  it('keeps a revoked token as an invalid link', async () => {
    queue.push([{ ...invitation, status: 'revoked' }]);
    await expect(getPublicForm('token')).rejects.toBeInstanceOf(FormTokenError);
  });
});
