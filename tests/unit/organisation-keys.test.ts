import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertCodedAuditReason } from '@/domains/audit/hash';

const { insert, update, select, recordPlatformAudit } = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
  recordPlatformAudit: vi.fn(),
}));

vi.mock('@/db/client', () => {
  const db = {
    insert: (...args: unknown[]) => insert(...args),
    update: (...args: unknown[]) => update(...args),
    select: (...args: unknown[]) => select(...args),
    // Writes and their audit share one transaction; run the callback on the mock.
    transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});

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
      expect.anything(),
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
        reason: 'key.kms_refused',
        after: expect.objectContaining({
          data: expect.objectContaining({ kmsError: 'DisabledException' }),
        }),
      }),
      expect.anything(),
    );
  });

  it('marks the key unavailable on an arbitrary KMS message and audits a coded reason', async () => {
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ ...row, status: 'unavailable' }]),
      }),
    });
    update.mockReturnValue({ set });

    const { markOrganisationKeyUnavailable } =
      await import('@/domains/organisation-keys');
    const message =
      'User: arn:aws:sts::222222222222:assumed-role/x is not authorized to perform: kms:Decrypt (Service: Kms, Status Code: 400)';
    await markOrganisationKeyUnavailable(row.organisationId, message);

    expect(set).toHaveBeenCalledWith({ status: 'unavailable' });
    const [event] = recordPlatformAudit.mock.calls[0] as [
      { reason: string; after: { data: Record<string, unknown> } },
    ];
    expect(assertCodedAuditReason(event.reason)).toBe('key.kms_refused');
    expect(event.after.data.kmsError).toBe('other');
    expect(JSON.stringify(event)).not.toContain('not authorized');
  });

  it('audits a health change with a coded reason and a closed key state', async () => {
    const returning = vi.fn().mockResolvedValue([{ ...row, status: 'disabled' }]);
    update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }),
    });

    const { saveKeyHealthObservation } =
      await import('@/domains/organisation-keys/service');
    await saveKeyHealthObservation({
      organisationId: row.organisationId,
      status: 'disabled',
      healthState: 'Disabled',
      previousStatus: 'active',
    });
    await saveKeyHealthObservation({
      organisationId: row.organisationId,
      status: 'unavailable',
      healthState: 'socket hang up, retry later',
      previousStatus: 'disabled',
    });

    const events = recordPlatformAudit.mock.calls.map(
      ([event]) => event as { reason: string; after: { data: Record<string, unknown> } },
    );
    expect(events.map((e) => e.reason)).toEqual([
      'key.health_degraded',
      'key.health_degraded',
    ]);
    expect(events.map((e) => e.after.data.healthState)).toEqual(['Disabled', 'other']);
    for (const event of events) {
      expect(assertCodedAuditReason(event.reason)).toBe(event.reason);
    }
  });

  it('limits KMS signals to exception names and key states', async () => {
    const { auditableKmsSignal } = await import('@/domains/organisation-keys/service');
    expect(auditableKmsSignal('AccessDeniedException')).toBe('AccessDeniedException');
    expect(auditableKmsSignal('PendingDeletion')).toBe('PendingDeletion');
    expect(auditableKmsSignal('Access denied for user@example.org')).toBe('other');
    expect(auditableKmsSignal('')).toBe('other');
    expect(auditableKmsSignal(null)).toBe('other');
  });

  it('joins the deletion audit to the pending_deletion status change', async () => {
    const returning = vi.fn().mockResolvedValue([{ ...row, status: 'pending_deletion' }]);
    update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }),
    });
    const transaction = vi.spyOn(
      (await import('@/db/client')).db as unknown as {
        transaction: (fn: (tx: unknown) => unknown) => unknown;
      },
      'transaction',
    );

    const { scheduleKeyDeletion } = await import('@/domains/organisation-keys');
    await scheduleKeyDeletion(row.organisationId);

    expect(transaction).toHaveBeenCalledTimes(1);
    const actions = recordPlatformAudit.mock.calls.map(
      ([event, tx]) => [(event as { action: string }).action, Boolean(tx)] as const,
    );
    expect(actions).toEqual([
      ['key.status_changed', true],
      ['key.deletion_scheduled', true],
    ]);
    transaction.mockRestore();
  });

  it('records a replacement re-wrap and refuses automatic rotation of the same ARN', async () => {
    const nextArn =
      'arn:aws:kms:ap-southeast-2:222222222222:key/bbbbbbbb-1234-4678-9abc-def012345678';
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [row],
        }),
      }),
    });
    const keyReturning = vi.fn().mockResolvedValue([
      {
        ...row,
        kmsKeyArn: nextArn,
        keyVersion: 2,
        previousKmsKeyArn: row.kmsKeyArn,
        previousKeyVersion: 1,
      },
    ]);
    update.mockReturnValue({
      set: () => ({ where: () => ({ returning: keyReturning }) }),
    });
    const rewrapReturning = vi
      .fn()
      .mockResolvedValue([{ id: '018f0000-0000-7000-8000-000000000099' }]);
    insert.mockReturnValue({
      values: () => ({ returning: rewrapReturning }),
    });

    const { rotateOrganisationKey } = await import('@/domains/organisation-keys');
    await expect(
      rotateOrganisationKey(row.organisationId, row.kmsKeyArn),
    ).rejects.toThrow(/automatic rotation/);
    expect(update).not.toHaveBeenCalled();

    const replaced = await rotateOrganisationKey(row.organisationId, nextArn);
    expect(replaced.rewrapId).toBe('018f0000-0000-7000-8000-000000000099');
    expect(replaced.key.previousKmsKeyArn).toBe(row.kmsKeyArn);
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'key.replacement_started',
        resourceType: 'organisation_key_rewrap',
        resourceId: replaced.rewrapId,
      }),
      expect.anything(),
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
      expect.anything(),
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
    await withdrawEscrow(
      row.organisationId,
      optIn.recordedByUserId,
      'escrow.client_notice',
    );

    expect(set).toHaveBeenCalledWith({ escrow: false, escrowPackageDigest: null });
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'key.escrow_withdrawn',
        reason: 'escrow.client_notice',
        actorUserId: optIn.recordedByUserId,
      }),
      expect.anything(),
    );
  });

  it('clears escrow when the key is rotated', async () => {
    const nextArn =
      'arn:aws:kms:ap-southeast-2:333333333333:key/cccccccc-1234-4678-9abc-def012345678';
    currentKey({ ...escrowRow, escrow: true, escrowPackageDigest: digest });
    const set = updateReturns({ ...escrowRow, keyVersion: 2, kmsKeyArn: nextArn });
    insert.mockReturnValue({
      values: () => ({
        returning: async () => [{ id: '018f0000-0000-7000-8000-000000000099' }],
      }),
    });
    const { rotateOrganisationKey } = await import('@/domains/organisation-keys');
    await rotateOrganisationKey(row.organisationId, nextArn);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        keyVersion: 2,
        escrow: false,
        escrowPackageDigest: null,
      }),
    );
  });
});
