import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DekCache, DEK_CACHE_MAX_TTL_MS } from '@/lib/encryption/dek-cache';
import { TenantKeyUnavailableError } from '@/lib/encryption/errors';
import {
  KEY_HEALTH_INTERVAL_MS,
  probeKeyProvider,
  runKeyHealth,
  type KeyHealthSubject,
} from '@/lib/encryption/key-health';
import { LocalKeyProvider } from '@/lib/encryption/local-provider';
import { scopeFor } from '@/lib/encryption/scope';
import { applyTenantJobGate, tenantKeyPauseSignal } from '@worker/tenant-key-gate';
import { DelayedError } from 'bullmq';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ARN_A =
  'arn:aws:kms:ap-southeast-2:111111111111:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ARN_B =
  'arn:aws:kms:ap-southeast-2:222222222222:key/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

interface KeyRow {
  id: string;
  organisationId: string;
  custodyMode: 'client_owned';
  kmsKeyArn: string;
  keyVersion: number;
  previousKmsKeyArn: string | null;
  previousKeyVersion: number | null;
  status: 'active' | 'disabled' | 'pending_deletion' | 'unavailable';
  escrow: boolean;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
}

const { rows } = vi.hoisted(() => ({
  rows: new Map<string, KeyRow>(),
}));

vi.mock('@/domains/organisation-keys', () => ({
  getOrganisationKey: vi.fn(
    async (organisationId: string) => rows.get(organisationId) ?? null,
  ),
  markOrganisationKeyUnavailable: vi.fn(),
}));

const binding = { table: 'notes', column: 'body', rowId: 'row-1' };

function put(organisationId: string, kmsKeyArn: string, status: KeyRow['status']): void {
  rows.set(organisationId, {
    id: `key-${organisationId}`,
    organisationId,
    custodyMode: 'client_owned',
    kmsKeyArn,
    keyVersion: 1,
    previousKmsKeyArn: null,
    previousKeyVersion: null,
    status,
    escrow: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    rotatedAt: null,
  });
}

describe('tenant key revocation', () => {
  const provider = new LocalKeyProvider(randomBytes(32));
  let cache: DekCache;

  beforeEach(() => {
    rows.clear();
    provider.enableKey(ARN_A);
    provider.enableKey(ARN_B);
    cache = new DekCache({ ttlMs: DEK_CACHE_MAX_TTL_MS, maxUses: 64 });
    put(ORG_A, ARN_A, 'active');
    put(ORG_B, ARN_B, 'active');
  });

  it('fails closed within the DEK cache TTL, pauses A, and leaves B running', async () => {
    expect(KEY_HEALTH_INTERVAL_MS).toBeLessThanOrEqual(DEK_CACHE_MAX_TTL_MS);

    const scopeA = await scopeFor(ORG_A, { provider, cache });
    const sealed = await scopeA.encrypt('tenant-a-secret', binding);
    expect(await scopeA.decrypt(sealed, binding)).toBe('tenant-a-secret');

    provider.disableKey(ARN_A, 'disabled');
    const stillCached = await scopeFor(ORG_A, { provider, cache });
    expect(await stillCached.decrypt(sealed, binding)).toBe('tenant-a-secret');

    const pause = vi.fn(async (_organisationId: string) => undefined);
    const resume = vi.fn(async (_organisationId: string) => undefined);
    const subjects = (): KeyHealthSubject[] =>
      [...rows.values()].map((row) => ({
        organisationId: row.organisationId,
        kmsKeyArn: row.kmsKeyArn,
        status: row.status,
      }));

    const revoked = await runKeyHealth({
      subjects: subjects(),
      probe: (subject) =>
        probeKeyProvider(provider, subject.kmsKeyArn, subject.organisationId),
      setStatus: async (organisationId, status) => {
        const current = rows.get(organisationId);
        if (current) rows.set(organisationId, { ...current, status });
      },
      evict: (organisationId) => cache.evictOrganisation(organisationId),
      pause,
      resume,
    });

    expect(revoked.find((result) => result.organisationId === ORG_A)).toMatchObject({
      action: 'paused',
      status: 'unavailable',
    });
    expect(revoked.find((result) => result.organisationId === ORG_B)).toMatchObject({
      action: 'none',
      status: 'active',
    });
    expect(pause.mock.calls.map((call) => call[0])).toEqual([ORG_A]);
    expect(resume).not.toHaveBeenCalled();

    const locked = await scopeFor(ORG_A, { provider, cache })
      .then((scope) => scope.decrypt(sealed, binding))
      .catch((error: unknown) => error);
    expect(locked).toBeInstanceOf(TenantKeyUnavailableError);
    expect((locked as TenantKeyUnavailableError).code).toBe('TENANT_KEY_UNAVAILABLE');

    const scopeB = await scopeFor(ORG_B, { provider, cache });
    const sealedB = await scopeB.encrypt('tenant-b-secret', {
      ...binding,
      rowId: 'row-b',
    });
    expect(await scopeB.decrypt(sealedB, { ...binding, rowId: 'row-b' })).toBe(
      'tenant-b-secret',
    );

    const delayedA: number[] = [];
    const paused = await applyTenantJobGate({
      status: rows.get(ORG_A)?.status ?? null,
      now: 1_000,
      moveToDelayed: async (timestamp) => {
        delayedA.push(timestamp);
      },
    });
    expect(paused).toBe('paused');
    expect(delayedA).toEqual([1_000 + 30_000]);
    const signal = tenantKeyPauseSignal();
    expect(signal).toBeInstanceOf(DelayedError);
    expect(signal.name).toBe('DelayedError');

    const delayedB: number[] = [];
    const ran = await applyTenantJobGate({
      status: rows.get(ORG_B)?.status ?? null,
      moveToDelayed: async (timestamp) => {
        delayedB.push(timestamp);
      },
    });
    expect(ran).toBe('run');
    expect(delayedB).toEqual([]);

    provider.enableKey(ARN_A);
    const restored = await runKeyHealth({
      subjects: subjects(),
      probe: (subject) =>
        probeKeyProvider(provider, subject.kmsKeyArn, subject.organisationId),
      setStatus: async (organisationId, status) => {
        const current = rows.get(organisationId);
        if (current) rows.set(organisationId, { ...current, status });
      },
      evict: (organisationId) => cache.evictOrganisation(organisationId),
      pause,
      resume,
    });
    expect(restored.find((result) => result.organisationId === ORG_A)?.action).toBe(
      'restored',
    );
    expect(resume).toHaveBeenCalledWith(ORG_A);
    expect(rows.get(ORG_B)?.status).toBe('active');

    const reopened = await scopeFor(ORG_A, { provider, cache });
    expect(await reopened.decrypt(sealed, binding)).toBe('tenant-a-secret');
    const ranAgain = await applyTenantJobGate({
      status: rows.get(ORG_A)?.status ?? null,
      moveToDelayed: async () => {
        throw new Error('should not pause');
      },
    });
    expect(ranAgain).toBe('run');
  });

  it('pauses a key pending deletion and does not restore it from a healthy probe', async () => {
    const pause = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    const setStatus = vi.fn(async () => undefined);
    const probe = vi.fn(async () => 'ok' as const);
    const results = await runKeyHealth({
      subjects: [{ organisationId: ORG_A, kmsKeyArn: ARN_A, status: 'pending_deletion' }],
      probe,
      setStatus,
      evict: () => undefined,
      pause,
      resume,
    });
    expect(results).toEqual([
      { organisationId: ORG_A, status: 'pending_deletion', action: 'paused' },
    ]);
    expect(probe).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledWith(ORG_A);
  });

  it('does not pause the other tenant when a probe errors', async () => {
    const pause = vi.fn(async () => undefined);
    const results = await runKeyHealth({
      subjects: [
        { organisationId: ORG_A, kmsKeyArn: ARN_A, status: 'active' },
        { organisationId: ORG_B, kmsKeyArn: ARN_B, status: 'active' },
      ],
      probe: async (subject) => {
        if (subject.organisationId === ORG_A) throw new Error('network');
        return 'ok';
      },
      setStatus: async () => undefined,
      evict: () => undefined,
      pause,
      resume: async () => undefined,
    });
    expect(results.map((result) => result.action)).toEqual(['probe_failed', 'none']);
    expect(pause).not.toHaveBeenCalled();
  });
});
