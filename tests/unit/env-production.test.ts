import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '@/lib/env';
import { PRODUCTION_ENV, TEST_KMS_KEY } from '../helpers/production-env';

const kmsKey = TEST_KMS_KEY;
const authSecret = PRODUCTION_ENV.BETTER_AUTH_SECRET!;
const production: Record<string, string> = { ...PRODUCTION_ENV };

describe('production env boot', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('boots a complete production configuration', () => {
    expect(parseEnv(production).COA_SIGNING_KEY_ID).toBe(kmsKey);
  });

  it('boots without the migrator URL, which runtime pods never mount', () => {
    expect(parseEnv(production).DATABASE_MIGRATION_URL).toBeUndefined();
  });

  it('refuses to boot production with a local CoA signing key', () => {
    expect(() =>
      parseEnv({
        ...production,
        COA_SIGNING_LOCAL_KEY_PEM: '-----BEGIN PRIVATE KEY-----',
      }),
    ).toThrow(/COA_SIGNING_LOCAL_KEY_PEM/);
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
