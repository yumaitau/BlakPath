import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '@/lib/env';

const kmsKey =
  'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc';
const authSecret = 'a-secure-runtime-value-that-is-long-enough';

const production: Record<string, string> = {
  NODE_ENV: 'production',
  APP_REGION: 'ap-southeast-2',
  S3_REGION: 'ap-southeast-2',
  APP_URL: 'https://blakpath.example.org',
  BETTER_AUTH_URL: 'https://blakpath.example.org',
  DATABASE_URL: 'postgres://app:secret@db.internal/blakpath?sslmode=verify-full',
  REDIS_URL: 'rediss://redis.internal:6379',
  S3_KMS_KEY_ID: kmsKey,
  CLAMAV_HOST: 'clamav.internal',
  SMTP_HOST: 'email-smtp.ap-southeast-2.amazonaws.com',
  SMTP_FROM: 'BlakPath <no-reply@blakpath.example.org>',
  EMAIL_WEBHOOK_SECRET: 'webhook-secret-value-ok',
  COA_SIGNING_KEY_ID: kmsKey,
  BETTER_AUTH_SECRET: authSecret,
  ENCRYPTION_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

describe('production env boot', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('boots a complete production configuration', () => {
    expect(parseEnv(production).COA_SIGNING_KEY_ID).toBe(kmsKey);
  });

  it('refuses to boot production without COA_SIGNING_KEY_ID', () => {
    const { COA_SIGNING_KEY_ID: _dropped, ...missing } = production;
    expect(() => parseEnv(missing)).toThrow(/COA_SIGNING_KEY_ID/);
    try {
      parseEnv(missing);
    } catch (error) {
      expect(String(error)).not.toContain(authSecret);
    }
  });

  it('does not apply the release gate outside production', () => {
    expect(
      parseEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://blakpath:blakpath@localhost:5432/blakpath',
        REDIS_URL: 'redis://localhost:6379',
        BETTER_AUTH_SECRET: 'development-only-secret-at-least-32-chars',
        ENCRYPTION_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }).COA_SIGNING_KEY_ID,
    ).toBeUndefined();
  });

  it('skips the release gate while Next is building the production image', () => {
    const buildEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://blakpath:blakpath@localhost:5432/blakpath',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: 'ci-build-secret-value-at-least-32-characters-long',
      ENCRYPTION_MASTER_KEY: 'dGVzdC10ZXN0LXRlc3QtdGVzdC10ZXN0LXRlc3QtMTIzNDU=',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test-secret',
    };
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    expect(parseEnv(buildEnv).NODE_ENV).toBe('production');
    vi.unstubAllEnvs();
    expect(() => parseEnv(buildEnv)).toThrow(/COA_SIGNING_KEY_ID/);
  });
});
