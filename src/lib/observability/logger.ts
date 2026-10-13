import pino, { type Logger } from 'pino';
import { inventoryRedactPaths } from '@/lib/encryption/inventory';
import { env, isProduction } from '@/lib/env';

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
 * Paths censored from every log record. Covers auth material, secrets, and
 * personal / sensitive applicant data. Wildcards match at any nesting depth.
 */
export const OPERATIONAL_REDACT_PATHS: string[] = [
  // Auth & secrets
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  'cookie',
  '*.cookie',
  'password',
  '*.password',
  'token',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  'totp',
  '*.totp',
  'recoveryCodes',
  '*.recoveryCodes',
  'secret',
  '*.secret',
  'wrappedDek',
  '*.wrappedDek',
  'ciphertext',
  '*.ciphertext',
  // Evidence & message content
  'content',
  '*.content',
  'body',
  '*.body',
  'messageBody',
  '*.messageBody',
  'evidence',
  '*.evidence',
  'fileContent',
  '*.fileContent',
  // Personal identifiers (applicant PII must not appear in operational logs)
  'email',
  '*.email',
  'phone',
  '*.phone',
  'dateOfBirth',
  '*.dateOfBirth',
  'firstName',
  '*.firstName',
  'lastName',
  '*.lastName',
  'fullName',
  '*.fullName',
  'address',
  '*.address',
  'ipAddress',
  '*.ipAddress',
  ...inventoryRedactPaths(),
];

const REDACTED = '[redacted]';

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
  redact: { paths: OPERATIONAL_REDACT_PATHS, censor: REDACTED },
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
