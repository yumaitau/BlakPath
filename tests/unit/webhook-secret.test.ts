import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWebhookSecret, sealWebhookSecret } from '@/lib/encryption/tenant-fields';
import { DEV_TENANT_KEY_ARN } from '@/lib/encryption/provider';
import { toWebhookEndpointView } from '@/domains/webhooks/view';
import { encryptFieldV1 } from '../helpers/legacy-envelope';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const { rows } = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));

vi.mock('@/domains/organisation-keys', () => ({
  getOrganisationKey: vi.fn(
    async (organisationId: string) => rows.get(organisationId) ?? null,
  ),
  markOrganisationKeyUnavailable: vi.fn(),
}));

function keyRow(organisationId: string) {
  return {
    id: `key-${organisationId}`,
    organisationId,
    kmsKeyArn: DEV_TENANT_KEY_ARN,
    keyVersion: 1,
    previousKmsKeyArn: null,
    status: 'active',
  };
}

beforeEach(() => {
  rows.clear();
  rows.set(ORG_A, keyRow(ORG_A));
  rows.set(ORG_B, keyRow(ORG_B));
});

describe('webhook signing secret at rest', () => {
  const plaintext = 'webhook-secret-plaintext-SHOULD-NOT-LEAK';

  it('stores version-2 tenant ciphertext and round-trips it', async () => {
    const stored = await sealWebhookSecret(ORG_A, 'endpoint-1', plaintext);
    expect(stored.startsWith('{"v":2')).toBe(true);
    expect(stored).not.toContain(plaintext);
    expect(await openWebhookSecret(ORG_A, 'endpoint-1', stored)).toBe(plaintext);
  });

  it('refuses a legacy plaintext value', async () => {
    await expect(openWebhookSecret(ORG_A, 'endpoint-1', plaintext)).rejects.toThrow(
      /ciphertext/,
    );
  });

  it('refuses a tampered ciphertext', async () => {
    const stored = await sealWebhookSecret(ORG_A, 'endpoint-1', plaintext);
    const parsed = JSON.parse(stored) as { ciphertext: string };
    const bytes = Buffer.from(parsed.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    parsed.ciphertext = bytes.toString('base64');
    await expect(
      openWebhookSecret(ORG_A, 'endpoint-1', JSON.stringify(parsed)),
    ).rejects.toThrow();
  });

  it('refuses a secret copied to another endpoint or tenant', async () => {
    const stored = await sealWebhookSecret(ORG_A, 'endpoint-1', plaintext);
    await expect(openWebhookSecret(ORG_A, 'endpoint-2', stored)).rejects.toThrow();
    await expect(openWebhookSecret(ORG_B, 'endpoint-1', stored)).rejects.toThrow();
  });

  it('still opens a version-1 secret until the backfill rewrites it', async () => {
    const stored = JSON.stringify(encryptFieldV1(plaintext));
    expect(await openWebhookSecret(ORG_A, 'endpoint-1', stored)).toBe(plaintext);
  });
});

describe('webhook endpoint view', () => {
  it('drops the signing secret', () => {
    const view = toWebhookEndpointView({
      id: 'ep-1',
      organisationId: 'org-1',
      url: 'https://example.org/hook',
      events: ['decision.finalised'],
      active: true,
      createdByUserId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      secretCiphertext: '{"v":1,"ciphertext":"hidden"}',
      secret: 'webhook-secret-plaintext-SHOULD-NOT-LEAK',
    } as never);
    expect(view).not.toHaveProperty('secret');
    expect(view).not.toHaveProperty('secretCiphertext');
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('SHOULD-NOT-LEAK');
    expect(serialised).not.toContain('hidden');
  });
});
