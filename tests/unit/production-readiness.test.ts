import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_READINESS_KEYS,
  validateProductionReadiness,
} from '@/lib/production-readiness';

const kmsKey =
  'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc';

const valid: Record<string, string> = {
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
  BETTER_AUTH_SECRET: 'a-secure-runtime-value-that-is-long-enough',
  ENCRYPTION_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

const cases: ReadonlyArray<{
  key: (typeof PRODUCTION_READINESS_KEYS)[number];
  patch: Record<string, string | undefined>;
  message: string;
}> = [
  { key: 'NODE_ENV', patch: { NODE_ENV: 'development' }, message: 'must be production' },
  {
    key: 'APP_REGION',
    patch: { APP_REGION: 'us-east-1' },
    message: 'must be ap-southeast-2',
  },
  {
    key: 'S3_REGION',
    patch: { S3_REGION: 'us-east-1' },
    message: 'must be ap-southeast-2',
  },
  {
    key: 'APP_URL',
    patch: { APP_URL: 'http://localhost:3000' },
    message: 'must use https:// with a non-local production host',
  },
  {
    key: 'BETTER_AUTH_URL',
    patch: { BETTER_AUTH_URL: 'https://other.example.org' },
    message: 'must match the APP_URL origin',
  },
  {
    key: 'DATABASE_URL',
    patch: { DATABASE_URL: 'postgres://app:secret@db.internal/blakpath' },
    message: 'must enforce TLS with sslmode',
  },
  {
    key: 'REDIS_URL',
    patch: { REDIS_URL: 'redis://localhost:6379' },
    message: 'must use rediss:// with a non-local production host',
  },
  {
    key: 'S3_ENDPOINT',
    patch: { S3_ENDPOINT: 'http://minio:9000' },
    message: 'must be unset when using managed S3',
  },
  {
    key: 'S3_ACCESS_KEY_ID',
    patch: { S3_ACCESS_KEY_ID: 'standing-key' },
    message: 'static S3 credentials must be unset; use a workload role',
  },
  {
    key: 'S3_SECRET_ACCESS_KEY',
    patch: { S3_SECRET_ACCESS_KEY: 'standing-secret' },
    message: 'static S3 credentials must be unset; use a workload role',
  },
  {
    key: 'S3_KMS_KEY_ID',
    patch: { S3_KMS_KEY_ID: undefined },
    message: 'must reference a customer-managed ap-southeast-2 KMS key',
  },
  {
    key: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    patch: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
    message: 'must use https:// with a non-local production host',
  },
  {
    key: 'CLAMAV_HOST',
    patch: { CLAMAV_HOST: 'localhost' },
    message: 'must use a non-local production service',
  },
  {
    key: 'SMTP_HOST',
    patch: { SMTP_HOST: 'localhost' },
    message: 'must use a non-local production service',
  },
  {
    key: 'SMTP_FROM',
    patch: { SMTP_FROM: 'BlakPath <no-reply@blakpath.local>' },
    message: 'must be a non-local production sender address',
  },
  {
    key: 'SMTP_USER',
    patch: { SMTP_USER: 'ses-smtp-user' },
    message: 'static SMTP credentials must be unset in production',
  },
  {
    key: 'SMTP_PASSWORD',
    patch: { SMTP_PASSWORD: 'ses-smtp-password' },
    message: 'static SMTP credentials must be unset in production',
  },
  {
    key: 'PAPERBOY_URL',
    patch: {
      PAPERBOY_URL: 'http://localhost:9',
      PAPERBOY_API_KEY: 'paperboy-api-key-value',
    },
    message: 'must use https:// with a non-local production host',
  },
  {
    key: 'PAPERBOY_API_KEY',
    patch: {
      PAPERBOY_URL: 'https://paperboy.yumait.au',
      PAPERBOY_API_KEY: 'replace-me',
    },
    message: 'must be a non-placeholder secret of at least 16 characters',
  },
  {
    key: 'EMAIL_WEBHOOK_SECRET',
    patch: { EMAIL_WEBHOOK_SECRET: undefined },
    message: 'must be a non-placeholder secret of at least 16 characters',
  },
  {
    key: 'COA_SIGNING_KEY_ID',
    patch: { COA_SIGNING_KEY_ID: undefined },
    message: 'must reference a customer-managed ap-southeast-2 KMS key',
  },
  {
    key: 'COA_SIGNING_LOCAL_KEY_PEM',
    patch: { COA_SIGNING_LOCAL_KEY_PEM: '-----BEGIN PRIVATE KEY-----' },
    message: 'must be unset in production',
  },
  {
    key: 'PILOT_BOOTSTRAP_TOKEN',
    patch: { PILOT_BOOTSTRAP_TOKEN: 'pilot-token-that-is-long-enough' },
    message: 'must be unset in production',
  },
  {
    key: 'BETTER_AUTH_SECRET',
    patch: { BETTER_AUTH_SECRET: 'test-secret' },
    message: 'must be a non-placeholder secret of at least 32 characters',
  },
  {
    key: 'ENCRYPTION_MASTER_KEY',
    patch: { ENCRYPTION_MASTER_KEY: 'dev-secret' },
    message: 'must be a non-placeholder base64-encoded 32-byte key',
  },
];

describe('production readiness configuration', () => {
  it('accepts managed Australian-region dependencies without static credentials', () => {
    expect(validateProductionReadiness(valid)).toEqual([]);
  });

  it('accepts a configured HTTPS collector and an unset collector', () => {
    expect(
      validateProductionReadiness({
        ...valid,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.internal',
      }),
    ).toEqual([]);
    expect(validateProductionReadiness(valid)).toEqual([]);
  });

  it('accepts PaperBoy when the URL and API key are both set', () => {
    expect(
      validateProductionReadiness({
        ...valid,
        PAPERBOY_URL: 'https://paperboy.yumait.au',
        PAPERBOY_API_KEY: 'paperboy-api-key-value',
      }),
    ).toEqual([]);
  });

  it('covers every production key', () => {
    expect(cases.map((entry) => entry.key).sort()).toEqual(
      [...PRODUCTION_READINESS_KEYS].sort(),
    );
  });

  it.each(cases)('rejects $key', ({ key, patch, message }) => {
    const issues = validateProductionReadiness({ ...valid, ...patch });
    expect(issues.find((issue) => issue.key === key)?.message).toBe(message);
  });

  it('reports every key at once for a dev-shaped environment', () => {
    const issues = validateProductionReadiness({
      NODE_ENV: 'test',
      APP_REGION: 'us-east-1',
      S3_REGION: 'eu-west-1',
      APP_URL: 'http://localhost:3000',
      BETTER_AUTH_URL: 'http://127.0.0.1:3000',
      DATABASE_URL: 'postgres://app:secret@localhost:5432/blakpath',
      REDIS_URL: 'redis://localhost:6379',
      S3_ENDPOINT: 'http://minio.internal:9000',
      S3_ACCESS_KEY_ID: 'standing-key',
      S3_SECRET_ACCESS_KEY: 'standing-secret',
      S3_KMS_KEY_ID: 'alias/aws/s3',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      CLAMAV_HOST: 'localhost',
      SMTP_HOST: '127.0.0.1',
      SMTP_FROM: 'BlakPath <no-reply@blakpath.local>',
      SMTP_USER: 'ses-user',
      SMTP_PASSWORD: 'ses-password',
      PAPERBOY_URL: 'http://paperboy.local',
      PAPERBOY_API_KEY: 'replace-me',
      EMAIL_WEBHOOK_SECRET: 'changeme',
      COA_SIGNING_KEY_ID: 'local-dev-key',
      COA_SIGNING_LOCAL_KEY_PEM: '-----BEGIN PRIVATE KEY-----',
      PILOT_BOOTSTRAP_TOKEN: 'pilot-token-that-is-long-enough',
      BETTER_AUTH_SECRET: 'test-secret',
      ENCRYPTION_MASTER_KEY: 'dev-secret',
    });

    expect(new Set(issues.map((issue) => issue.key))).toEqual(
      new Set(PRODUCTION_READINESS_KEYS),
    );
  });
});
