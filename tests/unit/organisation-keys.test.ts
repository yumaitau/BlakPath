import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insert, update, recordPlatformAudit } = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  recordPlatformAudit: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => insert(...args),
    update: (...args: unknown[]) => update(...args),
    select: vi.fn(),
  },
}));

vi.mock('@/domains/audit', () => ({
  recordPlatformAudit: (...args: unknown[]) => recordPlatformAudit(...args),
}));

const crossAccountArn =
  'arn:aws:kms:ap-southeast-2:222222222222:key/abcdefab-1234-4678-9abc-def012345678';

const row = {
  id: '018f0000-0000-7000-8000-000000000001',
  organisationId: '018f0000-0000-7000-8000-000000000002',
  custodyMode: 'client_owned' as const,
  kmsKeyArn: crossAccountArn,
  keyVersion: 1,
  status: 'active' as const,
  escrow: false,
  createdAt: new Date('2026-10-13T00:00:00Z'),
  updatedAt: new Date('2026-10-13T00:00:00Z'),
  rotatedAt: null,
};

describe('organisation key changes', () => {
  beforeEach(() => {
    insert.mockReset();
    update.mockReset();
    recordPlatformAudit.mockReset();
  });

  it('audits registration on the platform chain, including a cross-account ARN', async () => {
    const returning = vi.fn().mockResolvedValue([row]);
    insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) });

    const { registerOrganisationKey } = await import('@/domains/organisation-keys');
    await registerOrganisationKey({
      organisationId: row.organisationId,
      custodyMode: 'client_owned',
      kmsKeyArn: crossAccountArn,
    });

    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'key.registered',
        resourceType: 'organisation_key',
        resourceId: row.id,
        result: 'success',
      }),
    );
    const values = insert.mock.results[0]?.value.values as ReturnType<typeof vi.fn>;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending_validation',
        validationStatus: 'pending',
        kmsKeyArn: crossAccountArn,
      }),
    );
  });

  it('rejects an ARN that is not a KMS key', async () => {
    const { registerOrganisationKey } = await import('@/domains/organisation-keys');
    await expect(
      registerOrganisationKey({
        organisationId: row.organisationId,
        custodyMode: 'blakpath_managed',
        kmsKeyArn: 'alias/blakpath',
      }),
    ).rejects.toThrow(/Invalid request/);
    expect(insert).not.toHaveBeenCalled();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('audits a KMS outage as key.unavailable', async () => {
    const returning = vi.fn().mockResolvedValue([{ ...row, status: 'unavailable' }]);
    update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }),
    });

    const { markOrganisationKeyUnavailable } =
      await import('@/domains/organisation-keys');
    await markOrganisationKeyUnavailable(row.organisationId, 'DisabledException');

    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'key.unavailable',
        resourceType: 'organisation_key',
        resourceId: row.id,
        result: 'failure',
        reason: 'DisabledException',
      }),
    );
  });
});
