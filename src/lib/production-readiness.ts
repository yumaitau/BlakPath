/** Pure production configuration checks used by the executable release gate. */

export interface ReadinessIssue {
  key: string;
  message: string;
}

type ProductionEnvironment = Readonly<Record<string, string | undefined>>;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1)$/i;
const PLACEHOLDER = /(replace[-_ ]?me|changeme|example|test-secret|dev-secret)/i;

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function addRequiredUrl(
  issues: ReadinessIssue[],
  environment: ProductionEnvironment,
  key: string,
  protocol: string,
): URL | null {
  const parsed = parseUrl(environment[key]);
  if (!parsed || parsed.protocol !== protocol || LOCAL_HOST.test(parsed.hostname)) {
    issues.push({
      key,
      message: `must use ${protocol}// with a non-local production host`,
    });
    return null;
  }
  return parsed;
}

/** Return key-only, non-secret reasons a production deployment must be blocked. */
export function validateProductionReadiness(
  environment: ProductionEnvironment,
): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];

  if (environment.NODE_ENV !== 'production') {
    issues.push({ key: 'NODE_ENV', message: 'must be production' });
  }
  for (const key of ['APP_REGION', 'S3_REGION'] as const) {
    if (environment[key] !== 'ap-southeast-2') {
      issues.push({ key, message: 'must be ap-southeast-2' });
    }
  }

  const appUrl = addRequiredUrl(issues, environment, 'APP_URL', 'https:');
  const authUrl = addRequiredUrl(issues, environment, 'BETTER_AUTH_URL', 'https:');
  if (appUrl && authUrl && appUrl.origin !== authUrl.origin) {
    issues.push({ key: 'BETTER_AUTH_URL', message: 'must match the APP_URL origin' });
  }

  const database = addRequiredUrl(issues, environment, 'DATABASE_URL', 'postgres:');
  // `require` is not enough: postgres.js maps it to rejectUnauthorized:false,
  // so a substitute certificate would be accepted. `verify-ca` skips the hostname.
  if (database && database.searchParams.get('sslmode')?.toLowerCase() !== 'verify-full') {
    issues.push({
      key: 'DATABASE_URL',
      message:
        'must use sslmode=verify-full (certificate and hostname). sslmode=require does not verify the server',
    });
  }
  addRequiredUrl(issues, environment, 'REDIS_URL', 'rediss:');

  if (environment.S3_ENDPOINT) {
    issues.push({ key: 'S3_ENDPOINT', message: 'must be unset when using managed S3' });
  }
  if (environment.S3_ACCESS_KEY_ID || environment.S3_SECRET_ACCESS_KEY) {
    issues.push({
      key: 'S3_ACCESS_KEY_ID',
      message: 'static S3 credentials must be unset; use a workload role',
    });
  }
  if (
    !/^arn:aws:kms:ap-southeast-2:\d{12}:key\/[0-9a-f-]+$/i.test(
      environment.S3_KMS_KEY_ID ?? '',
    )
  ) {
    issues.push({
      key: 'S3_KMS_KEY_ID',
      message: 'must reference a customer-managed ap-southeast-2 KMS key',
    });
  }

  addRequiredUrl(issues, environment, 'OTEL_EXPORTER_OTLP_ENDPOINT', 'https:');
  for (const key of ['CLAMAV_HOST', 'SMTP_HOST'] as const) {
    const value = environment[key];
    if (!value || LOCAL_HOST.test(value)) {
      issues.push({ key, message: 'must use a non-local production service' });
    }
  }

  const authSecret = environment.BETTER_AUTH_SECRET;
  if (!authSecret || authSecret.length < 32 || PLACEHOLDER.test(authSecret)) {
    issues.push({
      key: 'BETTER_AUTH_SECRET',
      message: 'must be a non-placeholder secret of at least 32 characters',
    });
  }
  const encryptionKey = environment.ENCRYPTION_MASTER_KEY;
  let decodedLength = 0;
  try {
    decodedLength = encryptionKey ? Buffer.from(encryptionKey, 'base64').length : 0;
  } catch {
    decodedLength = 0;
  }
  if (!encryptionKey || decodedLength !== 32 || PLACEHOLDER.test(encryptionKey)) {
    issues.push({
      key: 'ENCRYPTION_MASTER_KEY',
      message: 'must be a non-placeholder base64-encoded 32-byte key',
    });
  }

  return issues;
}
