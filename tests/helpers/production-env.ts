import { vi } from 'vitest';

/**
 * A runtime environment that passes the production release gate. Production
 * boot runs that gate, so a test that needs `NODE_ENV=production` starts from
 * here and changes only the value under test. Fake values only.
 */
export const TEST_KMS_KEY =
  'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc';

export const PRODUCTION_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  APP_REGION: 'ap-southeast-2',
  S3_REGION: 'ap-southeast-2',
  APP_URL: 'https://blakpath.example.org',
  BETTER_AUTH_URL: 'https://blakpath.example.org',
  DATABASE_URL: 'postgres://blakpath_app:secret@db.internal/blakpath?sslmode=verify-full',
  REDIS_URL: 'rediss://redis.internal:6379',
  S3_KMS_KEY_ID: TEST_KMS_KEY,
  S3_BUCKET_AUDIT_ANCHORS: 'blakpath-prod-audit-anchors',
  AUDIT_ANCHOR_OBJECT_LOCK: 'true',
  AUDIT_ANCHOR_SIGNING_KEY_ID: TEST_KMS_KEY,
  CLAMAV_HOST: 'clamav.internal',
  EMAIL_TRANSPORT: 'ses',
  SES_CONFIGURATION_SET: 'blakpath-production',
  SMTP_FROM: 'BlakPath <no-reply@blakpath.yumait.au>',
  EMAIL_WEBHOOK_SECRET: 'webhook-secret-value-ok',
  EMAIL_SNS_TOPIC_ARN: 'arn:aws:sns:ap-southeast-2:123456789012:blakpath-email-events',
  COA_SIGNING_KEY_ID: TEST_KMS_KEY,
  BETTER_AUTH_SECRET: 'a-secure-runtime-value-that-is-long-enough',
  ORIGIN_VERIFY_SECRET: 'a-different-runtime-value-that-is-long-enough',
  PLATFORM_KMS_KEY_ARN: TEST_KMS_KEY,
  OPERATOR_ONCALL_EMAIL: 'oncall@blakpath.internal',
};

/** Development/CI-only keys the gate refuses. Cleared by `stubProductionEnv`. */
const REFUSED_IN_PRODUCTION = [
  'S3_ENDPOINT',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'ENCRYPTION_LOCAL_KEY',
  'KMS_ENDPOINT',
  'COA_SIGNING_LOCAL_KEY_PEM',
  'PILOT_BOOTSTRAP_TOKEN',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'PAPERBOY_URL',
  'PAPERBOY_API_KEY',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
] as const;

/** Stub a gate-passing production environment, then apply `overrides`. */
export function stubProductionEnv(overrides: Record<string, string | undefined> = {}) {
  for (const key of REFUSED_IN_PRODUCTION) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ ...PRODUCTION_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
}
