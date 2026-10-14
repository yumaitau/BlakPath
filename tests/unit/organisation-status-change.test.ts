import { beforeEach, describe, expect, it, vi } from 'vitest';

const selected: unknown[][] = [];
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
      select: () => makeChain(() => selected.shift() ?? []),
      update: () =>
        makeChain(() => {
          updates += 1;
          return [];
        }),
    },
  };
});

vi.mock('@/domains/audit/service', () => ({
  recordPlatformAudit: vi.fn(),
}));

vi.mock('@/domains/audit', () => ({
  recordAudit: vi.fn(),
  recordPlatformAudit: vi.fn(),
}));

vi.mock('@/domains/organisation-keys/service', () => ({
  getOrganisationKey: vi.fn(),
}));

const { setOrganisationStatus, OrganisationNotFoundError } =
  await import('@/domains/organisations/service');
const { recordPlatformAudit } = await import('@/domains/audit/service');
const { getOrganisationKey } = await import('@/domains/organisation-keys/service');
const { OrganisationActivationError } =
  await import('@/domains/organisation-keys/activation');

const base = {
  organisationId: 'org-1',
  actorUserId: 'user-1',
  sessionId: 'session-1',
  correlationId: 'corr-1',
  requestId: 'req-1',
} as const;

beforeEach(() => {
  selected.length = 0;
  updates = 0;
  vi.mocked(recordPlatformAudit).mockReset();
  vi.mocked(getOrganisationKey).mockReset();
  vi.mocked(recordPlatformAudit).mockResolvedValue({
    id: 'audit-1',
    organisationId: null,
    hash: 'h',
    prevHash: null,
    timestamp: new Date(),
  });
});

describe('setOrganisationStatus', () => {
  it('rejects an unknown organisation without auditing', async () => {
    selected.push([]);
    await expect(
      setOrganisationStatus({ ...base, status: 'suspended' }),
    ).rejects.toBeInstanceOf(OrganisationNotFoundError);
    expect(updates).toBe(0);
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('does not audit when the status is unchanged', async () => {
    selected.push([{ id: 'org-1', status: 'suspended' }]);
    const result = await setOrganisationStatus({ ...base, status: 'suspended' });
    expect(result).toEqual({ id: 'org-1', status: 'suspended' });
    expect(updates).toBe(0);
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('writes the change onto the platform audit chain', async () => {
    selected.push([{ id: 'org-1', status: 'active' }]);
    const result = await setOrganisationStatus({
      ...base,
      status: 'suspended',
      reason: 'pilot ended',
    });
    expect(result).toEqual({ id: 'org-1', status: 'suspended' });
    expect(updates).toBe(1);
    expect(recordPlatformAudit).toHaveBeenCalledOnce();
    const event = vi.mocked(recordPlatformAudit).mock.calls[0]?.[0];
    expect(event).toMatchObject({
      action: 'organisation.status_changed',
      resourceType: 'organisation',
      resourceId: 'org-1',
      result: 'success',
      reason: 'pilot ended',
      actorUserId: 'user-1',
      actingRole: 'platform-operator',
      before: { data: { status: 'active' }, allow: ['status'] },
      after: { data: { status: 'suspended' }, allow: ['status'] },
    });
    expect(event).not.toHaveProperty('organisationId');
  });

  it('restores the previous status when the platform audit append fails', async () => {
    selected.push([{ id: 'org-1', status: 'active' }]);
    vi.mocked(recordPlatformAudit).mockRejectedValueOnce(new Error('audit down'));
    await expect(setOrganisationStatus({ ...base, status: 'closed' })).rejects.toThrow(
      'audit down',
    );
    expect(updates).toBe(2);
  });

  it('refuses to reactivate without a validated tenant key', async () => {
    for (const key of [
      null,
      { status: 'pending_validation', validationStatus: 'pending' },
      { status: 'disabled', validationStatus: 'passed' },
    ]) {
      selected.push([{ id: 'org-1', status: 'suspended' }]);
      vi.mocked(getOrganisationKey).mockResolvedValueOnce(key as never);
      await expect(
        setOrganisationStatus({ ...base, status: 'active' }),
      ).rejects.toBeInstanceOf(OrganisationActivationError);
    }
    expect(updates).toBe(0);
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('reactivates when the tenant key is active and validated', async () => {
    selected.push([{ id: 'org-1', status: 'suspended' }]);
    vi.mocked(getOrganisationKey).mockResolvedValueOnce({
      status: 'active',
      validationStatus: 'passed',
    } as never);
    const result = await setOrganisationStatus({ ...base, status: 'active' });
    expect(result).toEqual({ id: 'org-1', status: 'active' });
    expect(updates).toBe(1);
    expect(recordPlatformAudit).toHaveBeenCalledOnce();
  });
});
