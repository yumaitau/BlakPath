import { beforeEach, describe, expect, it, vi } from 'vitest';
import { script } from './helpers/scripted-db';

const resolve = vi.hoisted(() => ({ resolveTenantContext: vi.fn() }));

vi.mock('@/lib/tenancy/resolve', () => ({
  resolveTenantContext: resolve.resolveTenantContext,
}));

vi.mock('@/db/client', async () => {
  const { scriptedDatabase } = await import('./helpers/scripted-db');
  return { db: scriptedDatabase() };
});

const { setActiveOrganisation } = await import('@/domains/tenancy-selection/service');
const { TenantContextError } = await import('@/lib/tenancy/context');

const input = {
  userId: 'user-1',
  sessionId: 'session-1',
  organisationId: 'org-1',
};

beforeEach(() => {
  script.reset();
  resolve.resolveTenantContext.mockReset();
});

describe('setActiveOrganisation', () => {
  it('does not write an organisation the user has no active membership of', async () => {
    resolve.resolveTenantContext.mockRejectedValue(
      new TenantContextError('You do not have active access to this organisation.'),
    );

    await expect(setActiveOrganisation(input)).rejects.toBeInstanceOf(TenantContextError);
    expect(script.ops).toEqual([]);
    expect(resolve.resolveTenantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        sessionId: 'session-1',
        organisationId: 'org-1',
      }),
    );
  });

  it('persists the organisation only after membership is verified', async () => {
    resolve.resolveTenantContext.mockResolvedValue({ organisationId: 'org-1' });
    script.results.push([]);

    await setActiveOrganisation(input);

    expect(script.ops).toEqual(['update']);
    expect(script.writes[0]?.payload).toEqual({ activeOrganisationId: 'org-1' });
  });
});
