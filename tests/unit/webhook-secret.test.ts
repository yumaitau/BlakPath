import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { __resetEnvCache } from '@/lib/env';
import { toWebhookEndpointView } from '@/domains/webhooks/view';

beforeAll(() => {
  process.env.ENCRYPTION_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.ENCRYPTION_KEY_VERSION = '1';
  __resetEnvCache();
});

async function loadSecret() {
  return import('@/domains/webhooks/secret');
}

describe('webhook signing secret at rest', () => {
  const plaintext = 'webhook-secret-plaintext-SHOULD-NOT-LEAK';

  it('stores ciphertext and round-trips it', async () => {
    const { openWebhookSecret, sealWebhookSecret } = await loadSecret();
    const stored = sealWebhookSecret(plaintext);
    expect(stored.startsWith('{"v":')).toBe(true);
    expect(stored).not.toContain(plaintext);
    expect(openWebhookSecret(stored)).toBe(plaintext);
  });

  it('refuses a legacy plaintext value', async () => {
    const { openWebhookSecret } = await loadSecret();
    expect(() => openWebhookSecret(plaintext)).toThrow(/ciphertext/);
  });

  it('refuses a tampered ciphertext', async () => {
    const { openWebhookSecret, sealWebhookSecret } = await loadSecret();
    const stored = sealWebhookSecret(plaintext);
    const parsed = JSON.parse(stored) as { ciphertext: string };
    const bytes = Buffer.from(parsed.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    parsed.ciphertext = bytes.toString('base64');
    expect(() => openWebhookSecret(JSON.stringify(parsed))).toThrow();
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
