import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganisationKeyRow } from '@/domains/organisation-keys';
import { KmsKeyAccessError, type KeyProvider } from '@/lib/encryption/key-provider';
import { LocalKeyProvider } from '@/lib/encryption/local-provider';
import { runWithTenantContext, type TenantContext } from '@/lib/tenancy/context';

const { recordAudit, recordPlatformAudit, select, update } = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  recordPlatformAudit: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {
    select: (...args: unknown[]) => select(...args),
    update: (...args: unknown[]) => update(...args),
    insert: vi.fn(),
  },
}));

vi.mock('@/domains/audit', () => ({
  recordAudit: (...args: unknown[]) => recordAudit(...args),
  recordPlatformAudit: (...args: unknown[]) => recordPlatformAudit(...args),
}));

const orgA = '018f0000-0000-7000-8000-00000000000a';
const clientArn =
  'arn:aws:kms:ap-southeast-2:222222222222:key/abcdefab-1234-4678-9abc-def012345678';

function keyRow(overrides: Partial<OrganisationKeyRow> = {}): OrganisationKeyRow {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    organisationId: orgA,
    custodyMode: 'client_owned',
    kmsKeyArn: clientArn,
    keyVersion: 2,
    status: 'active',
    previousKmsKeyArn: null,
    previousKeyVersion: null,
    validationStatus: 'passed',
    validatedAt: null,
    validationFailure: null,
    canaryCiphertext: null,
    lastHealthAt: null,
    lastHealthState: null,
    escrow: false,
    escrowConsentReference: null,
    escrowConsentedAt: null,
    escrowPackageDigest: null,
    blindIndexWrappedDek: null,
    rotatedAt: new Date('2026-10-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

/** Fake `select().from().where().limit()` returning the given rows. */
function selectReturning(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  return { from: () => ({ where: () => ({ limit }) }) };
}

/** Fake `update().set().where().returning()` returning the given rows. */
function updateReturning(rows: unknown[]) {
  const set = vi.fn(() => ({
    where: () => ({ returning: vi.fn().mockResolvedValue(rows) }),
  }));
  return { set };
}

function ctx(permissions: string[]): TenantContext {
  return {
    organisationId: orgA,
    userId: '018f0000-0000-7000-8000-0000000000f1',
    membershipId: '018f0000-0000-7000-8000-0000000000f2',
    permissions: new Set(permissions),
    roles: ['organisation-admin'],
    sessionId: 's',
    correlationId: 'c',
    requestId: 'r',
  };
}

const localProvider = new LocalKeyProvider(Buffer.alloc(32, 7));

beforeEach(() => {
  recordAudit.mockReset();
  recordPlatformAudit.mockReset();
  select.mockReset();
  update.mockReset();
});

describe('checkOrganisationKeyHealth', () => {
  it('passes a wrap-and-unwrap round trip under the key_health context', async () => {
    select.mockReturnValueOnce(selectReturning([keyRow()]));
    const calls: unknown[] = [];
    const provider: KeyProvider = {
      async generateDataKey(input) {
        calls.push(input.encryptionContext);
        return localProvider.generateDataKey(input);
      },
      async decrypt(input) {
        calls.push(input.encryptionContext);
        return localProvider.decrypt(input);
      },
      wrap: (input) => localProvider.wrap(input),
    };

    const { checkOrganisationKeyHealth } = await import('@/domains/organisation-keys');
    const result = await checkOrganisationKeyHealth(orgA, { provider });

    expect(result).toMatchObject({ ok: true, failure: null });
    expect(calls).toEqual([
      { org_id: orgA, purpose: 'key_health' },
      { org_id: orgA, purpose: 'key_health' },
    ]);
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'key.health_checked',
        resourceType: 'organisation_key',
        result: 'success',
        reason: null,
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('fails closed on a KMS refusal and marks the key unavailable', async () => {
    select.mockReturnValueOnce(selectReturning([keyRow()]));
    update.mockReturnValueOnce(updateReturning([keyRow({ status: 'unavailable' })]));
    const provider: KeyProvider = {
      generateDataKey: () => Promise.reject(new KmsKeyAccessError('DisabledException')),
      decrypt: () => Promise.reject(new Error('not reached')),
      wrap: () => Promise.reject(new Error('not reached')),
    };

    const { checkOrganisationKeyHealth } = await import('@/domains/organisation-keys');
    const result = await checkOrganisationKeyHealth(orgA, { provider });

    expect(result).toMatchObject({ ok: false, failure: 'DisabledException' });
    const actions = recordPlatformAudit.mock.calls.map(
      ([input]) => (input as { action: string }).action,
    );
    expect(actions).toEqual(['key.unavailable', 'key.health_checked']);
    expect(recordPlatformAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: 'failure', reason: 'DisabledException' }),
    );
  });

  it('reports a mismatch when KMS answers for a different key', async () => {
    select.mockReturnValueOnce(selectReturning([keyRow()]));
    const provider: KeyProvider = {
      async generateDataKey(input) {
        const out = await localProvider.generateDataKey(input);
        return { ...out, keyId: 'arn:aws:kms:ap-southeast-2:333333333333:key/other' };
      },
      decrypt: (input) => localProvider.decrypt(input),
      wrap: (input) => localProvider.wrap(input),
    };

    const { checkOrganisationKeyHealth } = await import('@/domains/organisation-keys');
    const result = await checkOrganisationKeyHealth(orgA, { provider });

    expect(result).toMatchObject({ ok: false, failure: 'mismatch' });
  });

  it('reports no_key without touching KMS or the audit chain', async () => {
    select.mockReturnValueOnce(selectReturning([]));
    const provider: KeyProvider = {
      generateDataKey: vi.fn(),
      decrypt: vi.fn(),
      wrap: vi.fn(),
    };

    const { checkOrganisationKeyHealth } = await import('@/domains/organisation-keys');
    const result = await checkOrganisationKeyHealth(orgA, { provider });

    expect(result).toMatchObject({ ok: false, failure: 'no_key' });
    expect(provider.generateDataKey).not.toHaveBeenCalled();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });
});

describe('tenant-scoped key custody', () => {
  it('denies and audits a view without tenant:configure', async () => {
    const { getKeyCustodyOverview } = await import('@/domains/organisation-keys');
    await expect(
      runWithTenantContext(ctx(['report:view']), () => getKeyCustodyOverview()),
    ).rejects.toMatchObject({ name: 'AuthorizationError' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'key.viewed',
        resourceType: 'organisation_key',
        result: 'denied',
      }),
    );
    expect(select).not.toHaveBeenCalled();
  });

  it('refuses a health check without tenant:configure', async () => {
    const { runKeyHealthCheck } = await import('@/domains/organisation-keys');
    await expect(
      runWithTenantContext(ctx(['membership:manage']), () => runKeyHealthCheck()),
    ).rejects.toMatchObject({ name: 'AuthorizationError' });
    expect(select).not.toHaveBeenCalled();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('restores an unavailable key only after a passing check', async () => {
    const unavailable = keyRow({ status: 'unavailable' });
    select
      .mockReturnValueOnce(selectReturning([unavailable]))
      .mockReturnValueOnce(selectReturning([unavailable]));
    update.mockReturnValueOnce(updateReturning([keyRow({ status: 'active' })]));

    const { runKeyHealthCheck } = await import('@/domains/organisation-keys');
    const outcome = await runWithTenantContext(ctx(['tenant:configure']), () =>
      runKeyHealthCheck({ restore: true }),
    );

    expect(outcome).toMatchObject({ ok: true, restored: true });
    expect(update.mock.results[0]?.value.set).toHaveBeenCalledWith({ status: 'active' });
    expect(recordPlatformAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'key.status_changed', result: 'success' }),
    );
  });

  it('never lifts a deliberate disable, even when KMS answers', async () => {
    const disabled = keyRow({ status: 'disabled' });
    select
      .mockReturnValueOnce(selectReturning([disabled]))
      .mockReturnValueOnce(selectReturning([disabled]));

    const { runKeyHealthCheck } = await import('@/domains/organisation-keys');
    const outcome = await runWithTenantContext(ctx(['tenant:configure']), () =>
      runKeyHealthCheck({ restore: true }),
    );

    expect(outcome).toMatchObject({ ok: true, restored: false });
    expect(update).not.toHaveBeenCalled();
  });

  it('audits a permitted view and returns null when no key is registered', async () => {
    select.mockReturnValueOnce(selectReturning([]));
    const { getKeyCustodyOverview } = await import('@/domains/organisation-keys');
    const overview = await runWithTenantContext(ctx(['tenant:configure']), () =>
      getKeyCustodyOverview(),
    );
    expect(overview).toBeNull();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'key.viewed', result: 'success' }),
    );
  });
});
