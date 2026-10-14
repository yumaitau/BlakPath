import { describe, expect, it } from 'vitest';
import { validateProductionReadiness } from '@/lib/production-readiness';

const valid = {
  NODE_ENV: 'production',
  APP_REGION: 'ap-southeast-2',
  S3_REGION: 'ap-southeast-2',
  APP_URL: 'https://blakpath.example.org',
  BETTER_AUTH_URL: 'https://blakpath.example.org',
  DATABASE_URL: 'postgres://blakpath_app:secret@db.internal/blakpath?sslmode=verify-full',
  DATABASE_MIGRATION_URL:
    'postgres://blakpath_migrator:secret@db.internal/blakpath?sslmode=verify-full',
  S3_BUCKET_AUDIT_ANCHORS: 'blakpath-prod-audit-anchors',
  AUDIT_ANCHOR_OBJECT_LOCK: 'true',
  AUDIT_ANCHOR_SIGNING_KEY_ID:
    'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc',
  REDIS_URL: 'rediss://redis.internal:6379',
  S3_KMS_KEY_ID:
    'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.internal',
  CLAMAV_HOST: 'clamav.internal',
  EMAIL_TRANSPORT: 'ses',
  SES_CONFIGURATION_SET: 'blakpath-production',
  SMTP_FROM: 'BlakPath <no-reply@blakpath.yumait.au>',
  BETTER_AUTH_SECRET: 'a-secure-runtime-value-that-is-long-enough',
  ENCRYPTION_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ORIGIN_VERIFY_SECRET: 'a-different-runtime-value-that-is-long-enough',
  EMAIL_WEBHOOK_SECRET: 'email-webhook-secret-value',
  EMAIL_SNS_TOPIC_ARN: 'arn:aws:sns:ap-southeast-2:123456789012:blakpath-email-events',
  PLATFORM_KMS_KEY_ARN:
    'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc',
  OPERATOR_ONCALL_EMAIL: 'oncall@blakpath.internal',
} as const;

describe('production readiness configuration', () => {
  it('accepts managed, encrypted Australian-region dependencies', () => {
    expect(validateProductionReadiness(valid)).toEqual([]);
  });

  it('rejects a bootstrap token in production', () => {
    const issues = validateProductionReadiness({
      ...valid,
      PILOT_BOOTSTRAP_TOKEN: 'a-retired-value-that-must-not-be-set-here',
    });
    expect(issues).toEqual([
      {
        key: 'PILOT_BOOTSTRAP_TOKEN',
        message: 'must be unset in production',
      },
    ]);
  });

  it('rejects local services, static object credentials and missing transport security', () => {
    const issues = validateProductionReadiness({
      ...valid,
      APP_REGION: 'us-east-1',
      APP_URL: 'http://localhost:3000',
      BETTER_AUTH_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgres://app:secret@db.internal/blakpath',
      REDIS_URL: 'redis://localhost:6379',
      S3_ENDPOINT: 'http://minio:9000',
      S3_ACCESS_KEY_ID: 'standing-key',
      S3_SECRET_ACCESS_KEY: 'standing-secret',
      S3_KMS_KEY_ID: undefined,
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      CLAMAV_HOST: 'localhost',
    });

    expect(issues.map(({ key }) => key)).not.toContain('ENCRYPTION_MASTER_KEY');
    expect(
      validateProductionReadiness({
        ...valid,
        ORIGIN_VERIFY_SECRET: 'replace-me-not-a-real-origin-secret',
      }).map(({ key }) => key),
    ).toContain('ORIGIN_VERIFY_SECRET');
    expect(issues.map(({ key }) => key)).toEqual(
      expect.arrayContaining([
        'APP_REGION',
        'APP_URL',
        'BETTER_AUTH_URL',
        'DATABASE_URL',
        'REDIS_URL',
        'S3_ENDPOINT',
        'S3_ACCESS_KEY_ID',
        'S3_KMS_KEY_ID',
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        'CLAMAV_HOST',
      ]),
    );
  });

  describe('email sender', () => {
    const keys = (overrides: Record<string, string | undefined>) =>
      validateProductionReadiness({ ...valid, ...overrides }).map(({ key }) => key);

    it('fails when the SES sender config is missing', () => {
      expect(
        keys({
          EMAIL_TRANSPORT: undefined,
          SES_CONFIGURATION_SET: undefined,
          SMTP_FROM: undefined,
          EMAIL_WEBHOOK_SECRET: undefined,
        }),
      ).toEqual([
        'EMAIL_TRANSPORT',
        'SES_CONFIGURATION_SET',
        'SMTP_FROM',
        'EMAIL_WEBHOOK_SECRET',
      ]);
    });

    it('rejects the local SMTP transport in production', () => {
      expect(keys({ EMAIL_TRANSPORT: 'smtp' })).toEqual(['EMAIL_TRANSPORT']);
    });

    it('fails when static SMTP credentials are present', () => {
      expect(keys({ SMTP_USER: 'AKIASMTPUSER' })).toEqual(['SMTP_USER']);
      expect(keys({ SMTP_PASSWORD: 'smtp-password' })).toEqual(['SMTP_PASSWORD']);
    });

    it('fails when a second sender is configured', () => {
      expect(
        keys({ PAPERBOY_URL: 'https://paperboy.yumait.au', PAPERBOY_API_KEY: 'pb_live' }),
      ).toEqual(['PAPERBOY_URL', 'PAPERBOY_API_KEY']);
    });

    it.each([
      'BlakPath <no-reply@blakpath.local>',
      'no-reply@example.org',
      'BlakPath <no-reply@localhost>',
      'not-an-address',
    ])('rejects a non-production sender address %s', (from) => {
      expect(keys({ SMTP_FROM: from })).toEqual(['SMTP_FROM']);
    });

    it('accepts a bare sender address on the production domain', () => {
      expect(keys({ SMTP_FROM: 'no-reply@blakpath.yumait.au' })).toEqual([]);
    });

    it('rejects a placeholder or short webhook secret', () => {
      expect(
        keys({ EMAIL_WEBHOOK_SECRET: 'CHANGEME-webhook-shared-secret-value' }),
      ).toEqual(['EMAIL_WEBHOOK_SECRET']);
      expect(keys({ EMAIL_WEBHOOK_SECRET: 'short-secret' })).toEqual([
        'EMAIL_WEBHOOK_SECRET',
      ]);
    });
  });

  it('rejects a migration URL that reuses the application role', () => {
    const issues = validateProductionReadiness({
      ...valid,
      DATABASE_MIGRATION_URL: valid.DATABASE_URL,
    });
    expect(issues.map(({ key }) => key)).toContain('DATABASE_MIGRATION_URL');
  });

  it('rejects standing SMTP credentials', () => {
    const issues = validateProductionReadiness({
      ...valid,
      SMTP_USER: 'mail-user',
      SMTP_PASSWORD: 'mail-secret',
    });
    expect(issues.map(({ key }) => key)).toContain('SMTP_USER');
  });

  it('requires a pinned SES topic and a webhook secret', () => {
    const issues = validateProductionReadiness({
      ...valid,
      EMAIL_WEBHOOK_SECRET: 'replace-me',
      EMAIL_SNS_TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:topic',
    });
    expect(issues.map(({ key }) => key)).toEqual(
      expect.arrayContaining(['EMAIL_WEBHOOK_SECRET', 'EMAIL_SNS_TOPIC_ARN']),
    );
  });

  it('rejects the local encryption provider and a local KMS endpoint', () => {
    const issues = validateProductionReadiness({
      ...valid,
      ENCRYPTION_LOCAL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      KMS_ENDPOINT: 'http://localhost:4566',
      PLATFORM_KMS_KEY_ARN: undefined,
    });
    expect(issues.map(({ key }) => key)).toEqual(
      expect.arrayContaining([
        'ENCRYPTION_LOCAL_KEY',
        'KMS_ENDPOINT',
        'PLATFORM_KMS_KEY_ARN',
      ]),
    );
  });
});
