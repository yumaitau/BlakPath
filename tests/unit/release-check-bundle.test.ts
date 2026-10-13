import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

const kmsKey =
  'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc';
const authSecret = 'a-secure-runtime-value-that-is-long-enough';

const valid: NodeJS.ProcessEnv = {
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
  PATH: process.env.PATH ?? '',
};

function runCheck(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['dist/release-check/release-check.cjs'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
}

describe('release-check bundle', () => {
  beforeAll(() => {
    const built = spawnSync(process.execPath, ['scripts/build-release-check.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(built.status, built.stderr).toBe(0);
  });

  it('exits 0 for a production configuration', () => {
    const result = runCheck(valid);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain(authSecret);
  });

  it('exits 1 when COA_SIGNING_KEY_ID is missing and does not print secrets', () => {
    const { COA_SIGNING_KEY_ID: _dropped, ...missing } = valid;
    const result = runCheck(missing);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('COA_SIGNING_KEY_ID');
    expect(result.stderr).not.toContain(authSecret);
    expect(result.stdout).not.toContain(authSecret);
  });
});
