import pino, { type Logger } from 'pino';
import { env, isProduction } from '@/lib/env';
import { serializeLoggedError } from '@/lib/observability/error-log';

/**
 * OPERATIONAL logging only.
 *
 * This logger is for infrastructure/diagnostic events (timings, errors, queue
 * activity, health). It is deliberately NOT the business audit trail. Every
 * sensitive user action must be recorded via the durable, tamper-evident audit
 * log (see `src/db/schema/audit.ts` and its writer) — never via `logger`.
 * Operational logs may be shipped to third parties and shorter-lived; audit
 * records are first-class tenant data with strict retention.
 *
 * Redaction is defence-in-depth: even if a caller carelessly logs an object,
 * the paths below are censored before serialisation. Applicant identifiers and
 * evidence content must never reach logs.
 */

/**
 * Keys censored from every log record. Covers auth material, secrets, driver
 * payloads and personal / sensitive applicant data.
 *
 * fast-redact treats `*` as one object level, so each key is listed on its
 * own and under every parent depth up to {@link REDACT_DEPTH}.
 */
const SENSITIVE_KEYS = [
  // Auth & secrets
  'authorization',
  'cookie',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'totp',
  'recoveryCodes',
  'secret',
  '*.secret',
  'headers.x-blakpath-origin-verify',
  '*.x-blakpath-origin-verify',
  'ORIGIN_VERIFY_SECRET',
  '*.ORIGIN_VERIFY_SECRET',
  'wrappedDek',
  'ciphertext',
  // Driver payloads (query text and bound values)
  'params',
  'query',
  'detail',
  // Evidence & message content
  'content',
  'body',
  'messageBody',
  'evidence',
  'fileContent',
  // Personal identifiers (applicant PII must not appear in operational logs)
  'email',
  'phone',
  'dateOfBirth',
  'firstName',
  'lastName',
  'fullName',
  'address',
  'ipAddress',
] as const;

const REDACT_DEPTH = 6;

function redactPaths(keys: readonly string[], depth: number): string[] {
  const paths: string[] = [];
  for (const key of keys) {
    paths.push(key);
    for (let level = 1; level <= depth; level += 1) {
      paths.push(`${'*.'.repeat(level)}${key}`);
    }
  }
  return paths;
}

const REDACT_PATHS = redactPaths(SENSITIVE_KEYS, REDACT_DEPTH);

const REDACTED = '[redacted]';

/** Shared with tests so a log line is censored the same way as production. */
export const logRedaction = { paths: REDACT_PATHS, censor: REDACTED };

export const logSerializers = {
  err: serializeLoggedError,
  error: serializeLoggedError,
};

const base = {
  service: env.OTEL_SERVICE_NAME,
  region: env.APP_REGION,
  env: env.NODE_ENV,
};

/**
 * Root operational logger. JSON in production for machine ingestion; a human
 * readable stream in development. Never enable pretty-printing in production.
 */
export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base,
  redact: logRedaction,
  serializers: logSerializers,
  // ISO timestamps for cross-system correlation.
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  ...(isProduction()
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
});

/**
 * Derive a child logger bound to the current operation's identifiers so every
 * subsequent operational line can be joined to a trace. Identifiers are opaque
 * and contain no personal data.
 */
export function withRequestContext(
  correlationId: string,
  requestId: string,
  extra?: Record<string, unknown>,
): Logger {
  return logger.child({ correlationId, requestId, ...extra });
}

/**
 * Child logger scoped to a tenant. Only the opaque organisation id is attached
 * — never an organisation name or any applicant field.
 */
export function withOrganisation(organisationId: string): Logger {
  return logger.child({ organisationId });
}

export type { Logger };
