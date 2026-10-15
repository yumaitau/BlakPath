import { isIP } from 'node:net';
import { z } from 'zod';
import { WEB_POOL_MAX, WORKER_POOL_MAX } from '@/db/connection-budget';
import { validateProductionReadiness } from '@/lib/production-readiness';

/**
 * Centralised, validated environment configuration.
 *
 * Fail fast: the process must not boot with a partial or malformed
 * configuration. Secrets are never logged. Import `env` everywhere instead
 * of reading `process.env` directly so that every value is typed and checked.
 */

/** Next sets this while `next build` imports modules. Runtime boots do not. */
const NEXT_PRODUCTION_BUILD = 'phase-production-build';

/**
 * Release-gate keys a runtime process cannot satisfy. Web and worker never
 * mount the migrator secret, so DATABASE_MIGRATION_URL is checked only by the
 * release-check Job and the migrate Job.
 */
const NOT_CHECKED_AT_BOOT = new Set(['DATABASE_MIGRATION_URL']);

/**
 * Parse a string flag into a boolean. Zod v4 requires the `.default()` to sit
 * before `.transform()` so the default is a valid *input* to the enum.
 */
const booleanish = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue)
    .transform((v) => v === 'true' || v === '1');

const serverSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    APP_REGION: z.string().default('ap-southeast-2'),

    // Database. Runtime uses DATABASE_URL (application role). Migrations in
    // production use DATABASE_MIGRATION_URL (owning role) and refuse to share
    // the application role. Local development may omit the migration URL.
    // Workers set BLAKPATH_PROCESS=worker and use the worker pool, sized
    // separately so queue concurrency is not squeezed into the web pool.
    // See src/db/connection-budget.ts.
    DATABASE_URL: z.string().url(),
    DATABASE_MIGRATION_URL: z.string().url().optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(WEB_POOL_MAX),
    DATABASE_WORKER_POOL_MAX: z.coerce.number().int().positive().default(WORKER_POOL_MAX),
    BLAKPATH_PROCESS: z.enum(['web', 'worker']).default('web'),
    AUDIT_DB_APP_ROLE: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
      .default('blakpath_app'),

    // Redis (queues, rate limiting, ephemeral state)
    REDIS_URL: z.string().url(),

    // Better Auth
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be >= 32 chars'),
    BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
    // Staff UI inactivity sign-out. A warning appears two minutes before the
    // session is ended; activity in any open tab resets the timer.
    STAFF_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(720).default(30),
    // Shared with the Cloudflare zone. Present on origin requests as
    // `x-blakpath-origin-verify`. Unset locally. Required before production
    // traffic is accepted (see the release check).
    ORIGIN_VERIFY_SECRET: z.string().min(32).optional(),

    // Envelope encryption. Tenant keys live in `organisation_keys` and KMS.
    // The platform CMK wraps non-tenant data. The local root and the KMS
    // endpoint are development/CI only and are refused in production.
    // ENCRYPTION_MASTER_KEY remains only so version-1 ciphertext can be read.
    // Nothing writes version 1. Once the encryption backfill has completed for
    // every organisation, no stored value needs it and it can be unset.
    // See docs/adr/0001-customer-held-keys.md.
    PLATFORM_KMS_KEY_ARN: z.string().min(20).optional(),
    KMS_ENDPOINT: z.string().url().optional(),
    ENCRYPTION_LOCAL_KEY: z
      .string()
      .min(44, 'ENCRYPTION_LOCAL_KEY must be a base64-encoded 32-byte key')
      .optional(),
    ENCRYPTION_MASTER_KEY: z
      .string()
      .min(44, 'ENCRYPTION_MASTER_KEY must be a base64-encoded 32-byte key')
      .optional(),

    // S3-compatible object storage
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('ap-southeast-2'),
    // Local S3-compatible stores use an explicit key pair. In AWS production,
    // leave both unset so the SDK uses short-lived EKS Pod Identity credentials.
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_KMS_KEY_ID: z.string().min(1).optional(),
    S3_BUCKET_EVIDENCE: z.string().default('blakpath-evidence'),
    S3_BUCKET_QUARANTINE: z.string().default('blakpath-quarantine'),
    // Daily audit chain-head anchors. Production bucket has Object Lock
    // compliance enabled; local MinIO may store them without a lock.
    S3_BUCKET_AUDIT_ANCHORS: z.string().default('blakpath-audit-anchors'),
    AUDIT_ANCHOR_OBJECT_LOCK: booleanish('false'),
    AUDIT_ANCHOR_RETENTION_DAYS: z.coerce.number().int().min(1).default(2555),
    // KMS asymmetric key (SIGN_VERIFY) for anchor signatures. Required in
    // production by the release gate. Local HMAC falls back to
    // AUDIT_ANCHOR_HMAC_KEY or the envelope master key.
    AUDIT_ANCHOR_SIGNING_KEY_ID: z.string().min(1).optional(),
    AUDIT_ANCHOR_HMAC_KEY: z.string().min(32).optional(),
    S3_FORCE_PATH_STYLE: booleanish('true'),

    // ClamAV
    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

    // Email. Exactly one production sender: the SES v2 API under the workload
    // role (`EMAIL_TRANSPORT=ses`), tagged with a configuration set whose
    // bounce/complaint events reach POST /api/email/events via SNS. `smtp`
    // is the local/CI catch-all (Mailpit) and is unauthenticated by design:
    // there is no static mail credential path. See docs/adr/0090.
    EMAIL_TRANSPORT: z.enum(['smtp', 'ses']).default('smtp'),
    SES_CONFIGURATION_SET: z.string().min(1).max(64).optional(),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_FROM: z.string().default('BlakPath <no-reply@blakpath.local>'),
    // Sender quota in messages per second (SES production default is 14).
    // The worker paces the Email and Notification queues beneath it.
    EMAIL_SEND_RATE_PER_SECOND: z.coerce.number().int().positive().default(10),
    // Shared secret for POST /api/email/events. Header
    // `x-email-webhook-secret` only. Unset locally; required in production.
    EMAIL_WEBHOOK_SECRET: z.string().min(16).optional(),
    // SNS topic that SES bounce/complaint events must come from. The events
    // route rejects any other TopicArn. Unset locally; required in production.
    EMAIL_SNS_TOPIC_ARN: z
      .string()
      .regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/)
      .optional(),
    // Retired. Must be unset. A value fails production boot and the release gate.
    PILOT_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
    // Local seed opt-in. Developer accounts also require a loopback database host.
    // Ignored when NODE_ENV=production.
    ALLOW_DEV_SEED: z.string().optional(),
    // CoA cryptographic signing. Production uses a KMS asymmetric key
    // (SIGN_VERIFY) under the workload role. Local development and CI may use
    // a PEM private key instead — refused in production.
    COA_SIGNING_KEY_ID: z.string().min(1).optional(),
    COA_SIGNING_ALGORITHM: z.string().max(50).optional(),
    COA_SIGNING_LOCAL_KEY_PEM: z.string().min(1).optional(),
    // Entra ID OIDC client for federated sign-in. Unset = SSO unavailable.
    // The issuer is per tenant (organisation_sso_providers.issuer), not env.
    SSO_ENTRA_CLIENT_ID: z.string().min(1).optional(),
    SSO_ENTRA_CLIENT_SECRET: z.string().min(1).optional(),
    // Dedicated key sealing SSO flow transactions (state, nonce, PKCE
    // verifier). Never reuse BETTER_AUTH_SECRET. Unset = SSO unavailable.
    SSO_STATE_SECRET: z
      .string()
      .min(32, 'SSO_STATE_SECRET must be >= 32 chars')
      .optional(),

    // Observability
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().default('blakpath'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),

    // Background scheduler. These are deliberately intervals (rather than a
    // server-local cron) so BullMQ persists the next run in Redis and a worker
    // restart cannot silently skip a tenant's maintenance work.
    AUDIT_VERIFY_INTERVAL_MS: z.coerce.number().int().min(60_000).default(86_400_000),
    RETENTION_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(86_400_000),
    REMINDER_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(900_000),
    WEBHOOK_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(900_000),
    SCHEDULER_SYNC_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
    // Evidence scan recovery. The scan job itself retries through a 10 minute
    // ClamAV gap; the sweep re-queues anything still quarantined after that
    // and expires uploads that never completed.
    EVIDENCE_SCAN_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
    EVIDENCE_QUARANTINE_REQUEUE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(600_000),
    EVIDENCE_PENDING_EXPIRE_MS: z.coerce.number().int().min(60_000).default(86_400_000),
    EVIDENCE_QUARANTINE_ALARM_AGE_SECONDS: z.coerce.number().int().min(60).default(1_800),
    // How often each active tenant's CMK is described and canary-decrypted.
    KEY_HEALTH_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
    // Operator address for key-health state changes. Not a secret.
    OPERATOR_ONCALL_EMAIL: z.email().optional(),

    // Feature toggles
    AI_FEATURES_ENABLED: booleanish('false'),
    // Per-key ceiling for the external tool endpoint. Fixed window of one minute.
    MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),

    // Extra CIDRs refused for webhook delivery, comma-separated, in addition
    // to private, loopback, link-local, CGNAT and unique-local ranges.
    WEBHOOK_DENY_CIDRS: z
      .string()
      .optional()
      .refine((value) => {
        if (!value || !value.trim()) return true;
        return value.split(',').every((part) => {
          const item = part.trim();
          if (!item) return true;
          const slash = item.lastIndexOf('/');
          if (slash <= 0) return false;
          const address = item.slice(0, slash);
          const prefix = Number(item.slice(slash + 1));
          const family = isIP(address);
          const max = family === 4 ? 32 : family === 6 ? 128 : -1;
          return max > 0 && Number.isInteger(prefix) && prefix >= 0 && prefix <= max;
        });
      }, 'WEBHOOK_DENY_CIDRS must be comma-separated CIDRs'),
  })
  .superRefine((value, context) => {
    if (Boolean(value.S3_ACCESS_KEY_ID) !== Boolean(value.S3_SECRET_ACCESS_KEY)) {
      context.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together',
      });
    }
    if (value.NODE_ENV === 'production' && value.PILOT_BOOTSTRAP_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['PILOT_BOOTSTRAP_TOKEN'],
        message: 'must be unset in production',
      });
    }
    if (value.NODE_ENV === 'production' && value.ENCRYPTION_LOCAL_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_LOCAL_KEY'],
        message: 'ENCRYPTION_LOCAL_KEY is refused in production — configure KMS.',
      });
    }
    if (value.NODE_ENV === 'production' && value.KMS_ENDPOINT) {
      context.addIssue({
        code: 'custom',
        path: ['KMS_ENDPOINT'],
        message: 'KMS_ENDPOINT is refused in production — configure KMS.',
      });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

/** Parse an environment mapping. Throws the same boot error as `env`. */
export function parseEnv(
  source: Readonly<Record<string, string | undefined>>,
): ServerEnv {
  const parsed = serverSchema.safeParse(source);
  const issues: { path: string; message: string }[] = parsed.success
    ? []
    : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  // Production boot runs the release gate on the raw input, so a process that
  // skipped the pre-deploy Job still refuses a bad configuration. The image
  // build imports this module without runtime secrets and is exempt.
  if (
    source.NODE_ENV === 'production' &&
    process.env.NEXT_PHASE !== NEXT_PRODUCTION_BUILD
  ) {
    for (const issue of validateProductionReadiness(source)) {
      if (NOT_CHECKED_AT_BOOT.has(issue.key)) continue;
      if (issues.some((existing) => existing.path === issue.key)) continue;
      issues.push({ path: issue.key, message: issue.message });
    }
  }
  if (!parsed.success || issues.length > 0) {
    // Do not print values — only the keys that failed validation.
    const lines = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return parsed.data;
}

function loadEnv(): ServerEnv {
  return parseEnv(process.env);
}

/**
 * Lazily-evaluated so that tooling (e.g. drizzle-kit) that only needs
 * DATABASE_URL does not trip over unrelated missing variables.
 */
let cached: ServerEnv | null = null;
export const env: ServerEnv = new Proxy({} as ServerEnv, {
  get(_t, prop: string) {
    cached ??= loadEnv();
    return cached[prop as keyof ServerEnv];
  },
});

/**
 * Test-only hook: drop the cached env so stubbed process.env values take
 * effect. Never call outside tests — production reads config once at boot.
 */
export function __resetEnvCache(): void {
  cached = null;
}

export const isProduction = () => env.NODE_ENV === 'production';
