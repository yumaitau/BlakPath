import { z } from 'zod';

/**
 * Centralised, validated environment configuration.
 *
 * Fail fast: the process must not boot with a partial or malformed
 * configuration. Secrets are never logged. Import `env` everywhere instead
 * of reading `process.env` directly so that every value is typed and checked.
 */
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

    // Database
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    // Redis (queues, rate limiting, ephemeral state)
    REDIS_URL: z.string().url(),

    // Better Auth
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be >= 32 chars'),
    BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),

    // Application-level envelope encryption. Master key is a base64-encoded
    // 32-byte key. In production this is sourced from KMS, never the DB.
    ENCRYPTION_MASTER_KEY: z
      .string()
      .min(44, 'ENCRYPTION_MASTER_KEY must be a base64-encoded 32-byte key'),
    ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),

    // S3-compatible object storage
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('ap-southeast-2'),
    // Local S3-compatible stores use an explicit key pair. In AWS production,
    // leave both unset so the SDK uses short-lived task/IRSA credentials.
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_KMS_KEY_ID: z.string().min(1).optional(),
    S3_BUCKET_EVIDENCE: z.string().default('blakpath-evidence'),
    S3_BUCKET_QUARANTINE: z.string().default('blakpath-quarantine'),
    S3_FORCE_PATH_STYLE: booleanish('true'),

    // ClamAV
    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

    // Email (SMTP; Mailpit locally)
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().default('BlakPath <no-reply@blakpath.local>'),
    // PaperBoy transactional email (https://paperboy.yumait.au).
    // Placeholder wiring: the sender posts JSON to
    // `{PAPERBOY_URL}/api/v1/emails` with `Authorization: Bearer
    // <PAPERBOY_API_KEY>`. Unset locally; required in production where
    // PaperBoy replaces direct SES SMTP.
    PAPERBOY_URL: z.string().url().optional(),
    PAPERBOY_API_KEY: z.string().min(1).optional(),
    // Shared secret gating the SES SNS event webhook (bounce/complaint).
    // Unset locally; required in production where SES events are wired.
    EMAIL_WEBHOOK_SECRET: z.string().min(16).optional(),
    // Bearer credential for SCIM directory provisioning. Unset = SCIM off.
    SCIM_BEARER_TOKEN: z.string().min(32).optional(),
    // One-time live-bootstrap token. Unset = bootstrap route disabled.
    PILOT_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
    // CoA cryptographic signing. Production uses a KMS asymmetric key
    // (SIGN_VERIFY) under the workload role. Local development and CI may use
    // a PEM private key instead — refused in production.
    COA_SIGNING_KEY_ID: z.string().min(1).optional(),
    COA_SIGNING_ALGORITHM: z.string().max(50).optional(),
    COA_SIGNING_LOCAL_KEY_PEM: z.string().min(1).optional(),
    // Entra ID OIDC client for federated sign-in. Unset = SSO unavailable.
    SSO_ENTRA_ISSUER: z.string().url().optional(),
    SSO_ENTRA_CLIENT_ID: z.string().min(1).optional(),
    SSO_ENTRA_CLIENT_SECRET: z.string().min(1).optional(),

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
    SCHEDULER_SYNC_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),

    // Feature toggles
    AI_FEATURES_ENABLED: booleanish('false'),
  })
  .superRefine((value, context) => {
    if (Boolean(value.S3_ACCESS_KEY_ID) !== Boolean(value.S3_SECRET_ACCESS_KEY)) {
      context.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together',
      });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

function loadEnv(): ServerEnv {
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Do not print values — only the keys that failed validation.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
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
