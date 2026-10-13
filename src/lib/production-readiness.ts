/**
 * Pure production configuration checks used by the release gate and by server
 * boot when `NODE_ENV=production`.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is optional. Tracing stays off when it is unset
 * (`src/lib/observability/otel.ts`). A value, when present, must be HTTPS on a
 * non-local host.
 *
 * `PRODUCTION_READINESS_KEYS` is every key this function can reject. Tests
 * assert each one.
 */

export interface ReadinessIssue {
  key: string;
  message: string;
}

type ProductionEnvironment = Readonly<Record<string, string | undefined>>;

export const PRODUCTION_READINESS_KEYS = [
  'NODE_ENV',
  'APP_REGION',
  'S3_REGION',
  'APP_URL',
  'BETTER_AUTH_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_KMS_KEY_ID',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'CLAMAV_HOST',
  'SMTP_HOST',
  'SMTP_FROM',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'PAPERBOY_URL',
  'PAPERBOY_API_KEY',
  'EMAIL_WEBHOOK_SECRET',
  'COA_SIGNING_KEY_ID',
  'COA_SIGNING_LOCAL_KEY_PEM',
  'PILOT_BOOTSTRAP_TOKEN',
  'BETTER_AUTH_SECRET',
  'ENCRYPTION_MASTER_KEY',
] as const;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1)$/i;
const PLACEHOLDER = /(replace[-_ ]?me|changeme|example|test-secret|dev-secret)/i;
const KMS_KEY = /^arn:aws:kms:ap-southeast-2:\d{12}:key\/[0-9a-f-]+$/i;

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

function requireKmsKey(
  issues: ReadinessIssue[],
  environment: ProductionEnvironment,
  key: string,
): void {
  if (!KMS_KEY.test(environment[key] ?? '')) {
    issues.push({
      key,
      message: 'must reference a customer-managed ap-southeast-2 KMS key',
    });
  }
}

function requireSecret(
  issues: ReadinessIssue[],
  environment: ProductionEnvironment,
  key: string,
  minLength: number,
): void {
  const value = environment[key];
  if (!value || value.length < minLength || PLACEHOLDER.test(value)) {
    issues.push({
      key,
      message: `must be a non-placeholder secret of at least ${minLength} characters`,
    });
  }
}

function productionSender(value: string | undefined): boolean {
  if (!value) return false;
  const wrapped = /<([^>]+)>$/.exec(value.trim());
  const address = (wrapped?.[1] ?? value).trim();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;
  const host = address.slice(at + 1);
  if (LOCAL_HOST.test(host) || host.endsWith('.local') || host.includes(' '))
    return false;
  return host.includes('.');
}

function checkMailSender(
  issues: ReadinessIssue[],
  environment: ProductionEnvironment,
): void {
  if (!productionSender(environment.SMTP_FROM)) {
    issues.push({
      key: 'SMTP_FROM',
      message: 'must be a non-local production sender address',
    });
  }
  if (environment.SMTP_USER) {
    issues.push({
      key: 'SMTP_USER',
      message: 'static SMTP credentials must be unset in production',
    });
  }
  if (environment.SMTP_PASSWORD) {
    issues.push({
      key: 'SMTP_PASSWORD',
      message: 'static SMTP credentials must be unset in production',
    });
  }

  const paperboyUrl = environment.PAPERBOY_URL;
  const paperboyKey = environment.PAPERBOY_API_KEY;
  if (!paperboyUrl && !paperboyKey) return;

  if (!paperboyUrl) {
    issues.push({
      key: 'PAPERBOY_URL',
      message: 'must be set when PAPERBOY_API_KEY is set',
    });
  } else {
    addRequiredUrl(issues, environment, 'PAPERBOY_URL', 'https:');
  }
  requireSecret(issues, environment, 'PAPERBOY_API_KEY', 16);
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
  if (
    database &&
    !['require', 'verify-ca', 'verify-full'].includes(
      database.searchParams.get('sslmode') ?? '',
    )
  ) {
    issues.push({ key: 'DATABASE_URL', message: 'must enforce TLS with sslmode' });
  }
  addRequiredUrl(issues, environment, 'REDIS_URL', 'rediss:');

  if (environment.S3_ENDPOINT) {
    issues.push({ key: 'S3_ENDPOINT', message: 'must be unset when using managed S3' });
  }
  if (environment.S3_ACCESS_KEY_ID) {
    issues.push({
      key: 'S3_ACCESS_KEY_ID',
      message: 'static S3 credentials must be unset; use a workload role',
    });
  }
  if (environment.S3_SECRET_ACCESS_KEY) {
    issues.push({
      key: 'S3_SECRET_ACCESS_KEY',
      message: 'static S3 credentials must be unset; use a workload role',
    });
  }
  requireKmsKey(issues, environment, 'S3_KMS_KEY_ID');
  requireKmsKey(issues, environment, 'COA_SIGNING_KEY_ID');

  if (environment.OTEL_EXPORTER_OTLP_ENDPOINT) {
    addRequiredUrl(issues, environment, 'OTEL_EXPORTER_OTLP_ENDPOINT', 'https:');
  }
  for (const key of ['CLAMAV_HOST', 'SMTP_HOST'] as const) {
    const value = environment[key];
    if (!value || LOCAL_HOST.test(value)) {
      issues.push({ key, message: 'must use a non-local production service' });
    }
  }

  checkMailSender(issues, environment);
  requireSecret(issues, environment, 'EMAIL_WEBHOOK_SECRET', 16);
  requireSecret(issues, environment, 'BETTER_AUTH_SECRET', 32);

  for (const key of ['COA_SIGNING_LOCAL_KEY_PEM', 'PILOT_BOOTSTRAP_TOKEN'] as const) {
    if (environment[key]) {
      issues.push({ key, message: 'must be unset in production' });
    }
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
