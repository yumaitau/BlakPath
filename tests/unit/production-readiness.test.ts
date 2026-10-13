import { describe, expect, it } from 'vitest';
import { validateProductionReadiness } from '@/lib/production-readiness';

const valid = {
  NODE_ENV: 'production',
  APP_REGION: 'ap-southeast-2',
  S3_REGION: 'ap-southeast-2',
  APP_URL: 'https://blakpath.example.org',
  BETTER_AUTH_URL: 'https://blakpath.example.org',
  DATABASE_URL: 'postgres://app:secret@db.internal/blakpath?sslmode=verify-full',
  REDIS_URL: 'rediss://redis.internal:6379',
  S3_KMS_KEY_ID:
    'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.internal',
  CLAMAV_HOST: 'clamav.internal',
  SMTP_HOST: 'smtp.internal',
  BETTER_AUTH_SECRET: 'a-secure-runtime-value-that-is-long-enough',
  ENCRYPTION_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
} as const;

describe('production readiness configuration', () => {
  it('accepts managed, encrypted Australian-region dependencies', () => {
    expect(validateProductionReadiness(valid)).toEqual([]);
  });

  it('accepts the in-cluster collector and rejects plain HTTP elsewhere', () => {
    expect(
      validateProductionReadiness({
        ...valid,
        OTEL_EXPORTER_OTLP_ENDPOINT:
          'http://blakpath-otel-collector.blakpath.svc.cluster.local:4318',
      }),
    ).toEqual([]);

    const issues = validateProductionReadiness({
      ...valid,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.internal:4318',
    });
    expect(issues.map(({ key }) => key)).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
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
      SMTP_HOST: 'localhost',
    });

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
        'SMTP_HOST',
      ]),
    );
  });
});
