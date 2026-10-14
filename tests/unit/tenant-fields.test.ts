import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DekCache } from '@/lib/encryption/dek-cache';
import { TenantKeyUnavailableError } from '@/lib/encryption/errors';
import { encryptFieldV1 } from '@/lib/encryption/envelope';
import {
  countPlaintextResidue,
  isPlaintextResidue,
  isTenantCiphertext,
  openText,
  resaveText,
  sealText,
} from '@/lib/encryption/field-codec';
import { LocalKeyProvider } from '@/lib/encryption/local-provider';
import { scopeFor } from '@/lib/encryption/scope';
import { __resetEnvCache } from '@/lib/env';

const ORG = '11111111-1111-4111-8111-111111111111';
const ARN =
  'arn:aws:kms:ap-southeast-2:111111111111:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface KeyRow {
  id: string;
  organisationId: string;
  custodyMode: 'blakpath_managed';
  kmsKeyArn: string;
  keyVersion: number;
  status: 'active' | 'disabled' | 'pending_deletion' | 'unavailable';
  escrow: boolean;
  blindIndexWrappedDek: string | null;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
}

const { rows } = vi.hoisted(() => ({ rows: new Map<string, KeyRow>() }));

vi.mock('@/domains/organisation-keys', () => ({
  getOrganisationKey: vi.fn(
    async (organisationId: string) => rows.get(organisationId) ?? null,
  ),
  markOrganisationKeyUnavailable: vi.fn(),
}));

const binding = { table: 'application_notes', column: 'body', rowId: 'row-1' };
const provider = new LocalKeyProvider(randomBytes(32));

beforeAll(() => {
  process.env.ENCRYPTION_MASTER_KEY = randomBytes(32).toString('base64');
  __resetEnvCache();
});

beforeEach(() => {
  rows.clear();
  rows.set(ORG, {
    id: 'key-1',
    organisationId: ORG,
    custodyMode: 'blakpath_managed',
    kmsKeyArn: ARN,
    keyVersion: 1,
    status: 'active',
    escrow: false,
    blindIndexWrappedDek: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    rotatedAt: null,
  });
});

describe('tenant field codec', () => {
  it('seals text as version-2 ciphertext and opens it', async () => {
    const scope = await scopeFor(ORG, {
      provider,
      cache: new DekCache({ ttlMs: 60_000, maxUses: 10 }),
    });
    const sealed = await sealText(scope, binding, 'Jane Smith');
    expect(sealed?.startsWith('{"v":2')).toBe(true);
    expect(isTenantCiphertext(sealed)).toBe(true);
    expect(isPlaintextResidue(sealed)).toBe(false);
    expect(await openText(scope, binding, sealed)).toBe('Jane Smith');
  });

  it('leaves version-2 ciphertext unchanged and seals legacy plaintext once', async () => {
    const scope = await scopeFor(ORG, {
      provider,
      cache: new DekCache({ ttlMs: 60_000, maxUses: 10 }),
    });
    const sealed = await sealText(scope, binding, 'Jane Smith');
    const again = await resaveText(scope, binding, sealed);
    expect(again.changed).toBe(false);
    expect(again.value).toBe(sealed);

    const legacy = await resaveText(scope, binding, 'Jane Smith');
    expect(legacy.changed).toBe(true);
    expect(isTenantCiphertext(legacy.value)).toBe(true);
    expect(await openText(scope, binding, legacy.value)).toBe('Jane Smith');
    expect(countPlaintextResidue([legacy.value, null, sealed])).toBe(0);
    expect(countPlaintextResidue(['Jane Smith'])).toBe(1);
  });

  it('rewraps version-1 ciphertext into version 2', async () => {
    const scope = await scopeFor(ORG, {
      provider,
      cache: new DekCache({ ttlMs: 60_000, maxUses: 10 }),
    });
    const stored = JSON.stringify(encryptFieldV1('committee note'));
    expect(stored.startsWith('{"v":1')).toBe(true);
    expect(isPlaintextResidue(stored)).toBe(true);
    const saved = await resaveText(scope, binding, stored);
    expect(saved.changed).toBe(true);
    expect(isTenantCiphertext(saved.value)).toBe(true);
    expect(await openText(scope, binding, saved.value)).toBe('committee note');
  });

  it('fails closed when the tenant key is disabled', async () => {
    rows.set(ORG, { ...rows.get(ORG)!, status: 'disabled' });
    await expect(
      scopeFor(ORG, { provider, cache: new DekCache({ ttlMs: 1000, maxUses: 2 }) }).then(
        (scope) => sealText(scope, binding, 'Jane'),
      ),
    ).rejects.toBeInstanceOf(TenantKeyUnavailableError);
  });
});
