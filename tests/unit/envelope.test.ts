import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DekCache } from '@/lib/encryption/dek-cache';
import { TenantKeyUnavailableError } from '@/lib/encryption/errors';
import { encryptFieldV1 } from '@/lib/encryption/envelope';
import type { KeyProvider } from '@/lib/encryption/key-provider';
import { LocalKeyProvider } from '@/lib/encryption/local-provider';
import { platformScope, scopeFor } from '@/lib/encryption/scope';
import { __resetEnvCache } from '@/lib/env';
import { tenantKeyErrorResponse } from '@/lib/http/tenant-key-response';

/**
 * Per-tenant envelope: round trip, tenant separation, AAD, version-1 read,
 * and fail-closed key status.
 */

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
  status: 'active' | 'disabled' | 'pending_deletion' | 'unavailable';
  escrow: boolean;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
}

const { rows, mark } = vi.hoisted(() => {
  const stored = new Map<string, KeyRow>();
  return {
    rows: stored,
    mark: vi.fn(async (organisationId: string, _kmsError: string) => {
      const current = stored.get(organisationId);
      if (current && current.status !== 'unavailable') {
        stored.set(organisationId, { ...current, status: 'unavailable' });
      }
    }),
  };
});

vi.mock('@/domains/organisation-keys', () => ({
  getOrganisationKey: vi.fn(
    async (organisationId: string) => rows.get(organisationId) ?? null,
  ),
  markOrganisationKeyUnavailable: (organisationId: string, kmsError: string) =>
    mark(organisationId, kmsError),
}));

const binding = { table: 'notes', column: 'body', rowId: 'row-1' };
const provider = new LocalKeyProvider(randomBytes(32));

function put(
  organisationId: string,
  kmsKeyArn: string,
  status: KeyRow['status'] = 'active',
): void {
  rows.set(organisationId, {
    id: `key-${organisationId}`,
    organisationId,
    custodyMode: 'client_owned',
    kmsKeyArn,
    keyVersion: 1,
    status,
    escrow: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    rotatedAt: null,
  });
}

function cache(): DekCache {
  return new DekCache({ ttlMs: 60_000, maxUses: 10 });
}

beforeAll(() => {
  process.env.ENCRYPTION_MASTER_KEY = randomBytes(32).toString('base64');
  __resetEnvCache();
});

beforeEach(() => {
  rows.clear();
  mark.mockClear();
});

describe('tenant envelope', () => {
  it('round-trips a value under that tenant key', async () => {
    put(ORG_A, ARN_A);
    const scope = await scopeFor(ORG_A, { provider, cache: cache() });
    const plaintext = 'Confirmation reference: ABC-123 — sensitive';
    const field = await scope.encrypt(plaintext, binding);

    expect(field.v).toBe(2);
    expect(field.kid).toBe(`${ARN_A}#1`);
    expect(field.ctx).toEqual({ org_id: ORG_A, purpose: 'field' });
    expect(field.ciphertext).not.toContain('sensitive');
    expect(await scope.decrypt(field, binding)).toBe(plaintext);
  });

  it('round-trips unicode and empty strings', async () => {
    put(ORG_A, ARN_A);
    const scope = await scopeFor(ORG_A, { provider, cache: cache() });
    for (const value of ['', 'straya 🌏', 'line1\nline2\ttab']) {
      const field = await scope.encrypt(value, binding);
      expect(await scope.decrypt(field, binding)).toBe(value);
    }
  });

  it('mints a distinct data key for identical plaintext', async () => {
    put(ORG_A, ARN_A);
    const scope = await scopeFor(ORG_A, { provider, cache: cache() });
    const a = await scope.encrypt('same', binding);
    const b = await scope.encrypt('same', binding);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
  });

  it('refuses tenant A ciphertext under tenant B', async () => {
    put(ORG_A, ARN_A);
    put(ORG_B, ARN_B);
    const scopeA = await scopeFor(ORG_A, { provider, cache: cache() });
    const field = await scopeA.encrypt('tenant-a-only', binding);
    const scopeB = await scopeFor(ORG_B, { provider, cache: cache() });

    await expect(scopeB.decrypt(field, binding)).rejects.toThrow(/does not belong/);
    expect(mark).not.toHaveBeenCalled();
  });

  it('fails authentication when the row id in the AAD changes', async () => {
    put(ORG_A, ARN_A);
    const scope = await scopeFor(ORG_A, { provider, cache: cache() });
    const field = await scope.encrypt('row-bound', binding);

    await expect(scope.decrypt(field, { ...binding, rowId: 'row-2' })).rejects.toThrow();
  });

  it('reads version 1 ciphertext through the tenant scope', async () => {
    put(ORG_A, ARN_A);
    const legacy = encryptFieldV1('legacy value');
    expect(legacy.v).toBe(1);
    const scope = await scopeFor(ORG_A, { provider, cache: cache() });
    expect(await scope.decrypt(legacy, binding)).toBe('legacy value');
  });

  it('fails authentication when ciphertext, tag, iv, or wrapped DEK changes', async () => {
    put(ORG_A, ARN_A);
    const scope = await scopeFor(ORG_A, { provider, cache: cache() });
    const field = await scope.encrypt('do not tamper', binding);

    const flip = (value: string) => {
      const bytes = Buffer.from(value, 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      return bytes.toString('base64');
    };

    await expect(
      scope.decrypt({ ...field, ciphertext: flip(field.ciphertext) }, binding),
    ).rejects.toThrow();
    await expect(
      scope.decrypt({ ...field, tag: flip(field.tag) }, binding),
    ).rejects.toThrow();
    await expect(
      scope.decrypt({ ...field, iv: flip(field.iv) }, binding),
    ).rejects.toThrow();
    await expect(
      scope.decrypt({ ...field, wrappedDek: flip(field.wrappedDek) }, binding),
    ).rejects.toThrow();
  });

  it('returns 423 TENANT_KEY_UNAVAILABLE for a disabled key', async () => {
    put(ORG_A, ARN_A, 'disabled');
    const scope = await scopeFor(ORG_A, { provider, cache: cache() });
    const error = await scope
      .encrypt('hidden', binding)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TenantKeyUnavailableError);
    const response = tenantKeyErrorResponse(error);
    expect(response?.status).toBe(423);
    const body = await response?.json();
    expect(body).toMatchObject({ code: 'TENANT_KEY_UNAVAILABLE' });
    expect(JSON.stringify(body)).not.toContain('hidden');
    expect(mark).not.toHaveBeenCalled();
  });

  it('returns 423 for pending deletion and 503 for an unavailable key', async () => {
    put(ORG_A, ARN_A, 'pending_deletion');
    const pending = await scopeFor(ORG_A, { provider, cache: cache() })
      .then((scope) =>
        scope.decrypt(
          {
            v: 2,
            kid: `${ARN_A}#1`,
            ctx: { org_id: ORG_A, purpose: 'field' },
            iv: '',
            tag: '',
            wrappedDek: '',
            ciphertext: '',
          },
          binding,
        ),
      )
      .catch((caught: unknown) => caught);
    expect(tenantKeyErrorResponse(pending)?.status).toBe(423);

    put(ORG_A, ARN_A, 'unavailable');
    const unavailable = await scopeFor(ORG_A, { provider, cache: cache() })
      .then((scope) => scope.encrypt('x', binding))
      .catch((caught: unknown) => caught);
    expect(tenantKeyErrorResponse(unavailable)?.status).toBe(503);
  });

  it.each(['DisabledException', 'AccessDeniedException', 'KMSInvalidStateException'])(
    'marks the key unavailable when KMS raises %s',
    async (name) => {
      put(ORG_A, ARN_A);
      const writer = await scopeFor(ORG_A, { provider, cache: cache() });
      const field = await writer.encrypt('sealed', binding);
      const failing: KeyProvider = {
        async generateDataKey() {
          throw new Error('unused');
        },
        async decrypt() {
          const error = new Error(name);
          error.name = name;
          throw error;
        },
      };
      const reader = await scopeFor(ORG_A, {
        provider: failing,
        cache: new DekCache({ ttlMs: 1_000, maxUses: 1 }),
      });
      const error = await reader
        .decrypt(field, binding)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TenantKeyUnavailableError);
      expect((error as TenantKeyUnavailableError).httpStatus).toBe(503);
      expect(mark).toHaveBeenCalledWith(ORG_A, name);
      const response = tenantKeyErrorResponse(error);
      expect(response?.status).toBe(503);
      await expect(response?.json()).resolves.toMatchObject({
        code: 'TENANT_KEY_UNAVAILABLE',
      });
    },
  );

  it('round-trips platform data under the platform key', async () => {
    const scope = platformScope({ provider, cache: cache() });
    const field = await scope.encrypt('platform-note', binding);
    expect(field.ctx).toEqual({ org_id: 'platform', purpose: 'platform' });
    expect(field.kid).toContain('platform-local');
    expect(await scope.decrypt(field, binding)).toBe('platform-note');
  });
});
