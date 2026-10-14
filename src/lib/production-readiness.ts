import { migrationRoleIssue } from '@/db/migration-url';

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

/** Extract the domain of `Name <user@domain>` or a bare `user@domain`. */
function senderDomain(value: string | undefined): string | null {
  if (!value) return null;
  const address = /<([^<>\s]+)>\s*$/.exec(value)?.[1] ?? value.trim();
  const match = /^[^@\s]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/i.exec(address);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Exactly one production sender: the SES v2 API under the workload role,
 * tagged with a configuration set whose events reach /api/email/events.
 * See docs/adr/0090-production-email-sender.md.
 */
function validateEmailSender(environment: ProductionEnvironment): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if (environment.EMAIL_TRANSPORT !== 'ses') {
    issues.push({
      key: 'EMAIL_TRANSPORT',
      message: 'must be ses (SES API under the workload role)',
    });
  }
  for (const key of ['SMTP_USER', 'SMTP_PASSWORD'] as const) {
    if (environment[key]) {
      issues.push({
        key,
        message: 'static SMTP credentials must be unset; use the SES API workload role',
      });
    }
  }
  for (const key of ['PAPERBOY_URL', 'PAPERBOY_API_KEY'] as const) {
    if (environment[key]) {
      issues.push({ key, message: 'must be unset; SES is the only production sender' });
    }
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(environment.SES_CONFIGURATION_SET ?? '')) {
    issues.push({
      key: 'SES_CONFIGURATION_SET',
      message:
        'must name the SES configuration set that publishes bounce/complaint events',
    });
  }
  const domain = senderDomain(environment.SMTP_FROM);
  if (
    !domain ||
    /(^|\.)(local|localhost|example|invalid|test)$/.test(domain) ||
    /(^|\.)example\.(com|org|net)$/.test(domain)
  ) {
    issues.push({
      key: 'SMTP_FROM',
      message: 'must be an address on the verified production sending domain',
    });
  }
  return issues;
}

/** Return key-only, non-secret reasons a production deployment must be blocked. */
export function validateProductionReadiness(
  environment: ProductionEnvironment,
): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];

  if (environment.NODE_ENV !== 'production') {
    issues.push({ key: 'NODE_ENV', message: 'must be production' });
  }
  if ((environment.PILOT_BOOTSTRAP_TOKEN ?? '').trim() !== '') {
    issues.push({
      key: 'PILOT_BOOTSTRAP_TOKEN',
      message: 'must be unset in production',
    });
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
  const appRole = environment.AUDIT_DB_APP_ROLE || 'blakpath_app';
  if (database && decodeURIComponent(database.username) !== appRole) {
    issues.push({
      key: 'DATABASE_URL',
      message: 'must connect as the application role, not the migration owner',
    });
  }
  const migration = addRequiredUrl(
    issues,
    environment,
    'DATABASE_MIGRATION_URL',
    'postgres:',
  );
  if (
    migration &&
    !['require', 'verify-ca', 'verify-full'].includes(
      migration.searchParams.get('sslmode') ?? '',
    )
  ) {
    issues.push({
      key: 'DATABASE_MIGRATION_URL',
      message: 'must enforce TLS with sslmode',
    });
  }
  const roleIssue = migrationRoleIssue(environment);
  if (roleIssue && environment.DATABASE_MIGRATION_URL) {
    issues.push({ key: 'DATABASE_MIGRATION_URL', message: roleIssue });
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
  const kmsKeyArn = /^arn:aws:kms:ap-southeast-2:\d{12}:key\/[0-9a-f-]+$/i;
  if (!kmsKeyArn.test(environment.S3_KMS_KEY_ID ?? '')) {
    issues.push({
      key: 'S3_KMS_KEY_ID',
      message: 'must reference a customer-managed ap-southeast-2 KMS key',
    });
  }
  if (!environment.S3_BUCKET_AUDIT_ANCHORS) {
    issues.push({
      key: 'S3_BUCKET_AUDIT_ANCHORS',
      message: 'must name the object-lock audit anchor bucket',
    });
  }
  if (environment.AUDIT_ANCHOR_OBJECT_LOCK !== 'true') {
    issues.push({
      key: 'AUDIT_ANCHOR_OBJECT_LOCK',
      message: 'must be true so anchor puts use compliance retention',
    });
  }
  if (
    !/^arn:aws:kms:ap-southeast-2:\d{12}:key\/[0-9a-f-]+$/i.test(
      environment.AUDIT_ANCHOR_SIGNING_KEY_ID ?? '',
    )
  ) {
    issues.push({
      key: 'AUDIT_ANCHOR_SIGNING_KEY_ID',
      message: 'must reference a customer-managed ap-southeast-2 KMS signing key',
    });
  }

  addRequiredUrl(issues, environment, 'OTEL_EXPORTER_OTLP_ENDPOINT', 'https:');
  const clamavHost = environment.CLAMAV_HOST;
  if (!clamavHost || LOCAL_HOST.test(clamavHost)) {
    issues.push({
      key: 'CLAMAV_HOST',
      message: 'must use a non-local production service',
    });
  }

  issues.push(...validateEmailSender(environment));

  const originSecret = environment.ORIGIN_VERIFY_SECRET;
  if (!originSecret || originSecret.length < 32 || PLACEHOLDER.test(originSecret)) {
    issues.push({
      key: 'ORIGIN_VERIFY_SECRET',
      message: 'must be a non-placeholder secret of at least 32 characters',
    });
  }
  const authSecret = environment.BETTER_AUTH_SECRET;
  if (!authSecret || authSecret.length < 32 || PLACEHOLDER.test(authSecret)) {
    issues.push({
      key: 'BETTER_AUTH_SECRET',
      message: 'must be a non-placeholder secret of at least 32 characters',
    });
  }
  if (environment.ENCRYPTION_LOCAL_KEY) {
    issues.push({
      key: 'ENCRYPTION_LOCAL_KEY',
      message: 'local encryption provider is refused in production',
    });
  }
  if (environment.KMS_ENDPOINT) {
    issues.push({
      key: 'KMS_ENDPOINT',
      message: 'local KMS endpoint is refused in production',
    });
  }
  if (!kmsKeyArn.test(environment.PLATFORM_KMS_KEY_ARN ?? '')) {
    issues.push({
      key: 'PLATFORM_KMS_KEY_ARN',
      message: 'must reference a customer-managed ap-southeast-2 KMS key',
    });
  }
  const onCall = environment.OPERATOR_ONCALL_EMAIL;
  if (!onCall || !onCall.includes('@') || PLACEHOLDER.test(onCall)) {
    issues.push({
      key: 'OPERATOR_ONCALL_EMAIL',
      message: 'must be a real on-call email address',
    });
  }

  const webhookSecret = environment.EMAIL_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret.length < 16 || PLACEHOLDER.test(webhookSecret)) {
    issues.push({
      key: 'EMAIL_WEBHOOK_SECRET',
      message: 'must be a non-placeholder secret of at least 16 characters',
    });
  }
  if (
    !/^arn:aws:sns:ap-southeast-2:\d{12}:[A-Za-z0-9_-]+$/.test(
      environment.EMAIL_SNS_TOPIC_ARN ?? '',
    )
  ) {
    issues.push({
      key: 'EMAIL_SNS_TOPIC_ARN',
      message: 'must be an ap-southeast-2 SNS topic ARN',
    });
  }

  return issues;
}
