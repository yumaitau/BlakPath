import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insert, update, select, recordPlatformAudit } = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
  recordPlatformAudit: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => insert(...args),
    update: (...args: unknown[]) => update(...args),
    select: (...args: unknown[]) => select(...args),
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
  escrowConsentReference: null,
  escrowConsentedAt: null,
  escrowPackageDigest: null,
  createdAt: new Date('2026-10-13T00:00:00Z'),
  updatedAt: new Date('2026-10-13T00:00:00Z'),
  rotatedAt: null,
};

describe('organisation key changes', () => {
  beforeEach(() => {
    insert.mockReset();
    update.mockReset();
    select.mockReset();
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
  });

  it('rejects an ARN that is not a KMS key', async () => {
    const { registerOrganisationKey } = await import('@/domains/organisation-keys');
    await expect(
      registerOrganisationKey({
        organisationId: row.organisationId,
        custodyMode: 'blakpath_managed',
        kmsKeyArn: 'alias/blakpath',
      }),
    ).rejects.toThrow(/ARN/);
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

describe('escrow opt-in', () => {
  const digest = 'a'.repeat(64);
  const escrowRow = { ...row, custodyMode: 'client_owned_escrow' as const };
  const optIn = {
    organisationId: row.organisationId,
    consentReference: 'ESCROW-2026-0007',
    consentedAt: new Date('2026-10-01T00:00:00Z'),
    packageDigest: digest,
    recordedByUserId: '018f0000-0000-7000-8000-000000000009',
  };

  function currentKey(value: unknown): void {
    select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue(value ? [value] : []) }),
      }),
    });
  }

  function updateReturns(value: unknown): ReturnType<typeof vi.fn> {
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([value]) }),
    });
    update.mockReturnValue({ set });
    return set;
  }

  beforeEach(() => {
    update.mockReset();
    select.mockReset();
    recordPlatformAudit.mockReset();
  });

  it('records consent, package digest and the recording user', async () => {
    currentKey(escrowRow);
    const set = updateReturns({
      ...escrowRow,
      escrow: true,
      escrowConsentReference: optIn.consentReference,
      escrowConsentedAt: optIn.consentedAt,
      escrowPackageDigest: digest,
    });

    const { recordEscrowOptIn } = await import('@/domains/organisation-keys');
    const result = await recordEscrowOptIn(optIn);

    expect(result.escrow).toBe(true);
    expect(set).toHaveBeenCalledWith({
      escrow: true,
      escrowConsentReference: 'ESCROW-2026-0007',
      escrowConsentedAt: optIn.consentedAt,
      escrowPackageDigest: digest,
    });
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'key.escrow_opted_in',
        resourceType: 'organisation_key',
        actorUserId: optIn.recordedByUserId,
        after: expect.objectContaining({
          data: expect.objectContaining({
            escrow: true,
            escrowConsentReference: 'ESCROW-2026-0007',
            escrowPackageDigest: digest,
          }),
        }),
      }),
    );
  });

  it('refuses keys whose material AWS generated', async () => {
    currentKey(row);
    const { recordEscrowOptIn } = await import('@/domains/organisation-keys');
    await expect(recordEscrowOptIn(optIn)).rejects.toThrow(/client_owned_escrow/);
    expect(update).not.toHaveBeenCalled();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('requires a consent reference and a SHA-256 package digest', async () => {
    currentKey(escrowRow);
    const { recordEscrowOptIn } = await import('@/domains/organisation-keys');
    await expect(recordEscrowOptIn({ ...optIn, consentReference: '  ' })).rejects.toThrow(
      /consent reference/,
    );
    await expect(recordEscrowOptIn({ ...optIn, packageDigest: 'abc' })).rejects.toThrow(
      /SHA-256/,
    );
    await expect(
      recordEscrowOptIn({ ...optIn, consentedAt: new Date('not a date') }),
    ).rejects.toThrow(/signing date/);
    expect(update).not.toHaveBeenCalled();
  });

  it('audits a withdrawal and clears the package digest', async () => {
    const set = updateReturns({
      ...escrowRow,
      escrowConsentReference: 'ESCROW-2026-0007',
    });
    const { withdrawEscrow } = await import('@/domains/organisation-keys');
    await withdrawEscrow(row.organisationId, optIn.recordedByUserId, 'client request');

    expect(set).toHaveBeenCalledWith({ escrow: false, escrowPackageDigest: null });
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'key.escrow_withdrawn',
        reason: 'client request',
        actorUserId: optIn.recordedByUserId,
      }),
    );
  });

  it('clears escrow when the key is rotated', async () => {
    currentKey({ ...escrowRow, escrow: true, escrowPackageDigest: digest });
    const set = updateReturns({ ...escrowRow, keyVersion: 2 });
    const { rotateOrganisationKey } = await import('@/domains/organisation-keys');
    await rotateOrganisationKey(row.organisationId, crossAccountArn);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        keyVersion: 2,
        escrow: false,
        escrowPackageDigest: null,
      }),
    );
  });
});
