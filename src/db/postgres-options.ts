import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Options } from 'postgres';
import { DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS } from './migrator';

/**
 * Public Amazon RDS global CA bundle, baked into the web and worker images.
 * Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 * The unit test pins the file hash so a truncated or swapped bundle fails CI.
 */
export const RDS_CA_BUNDLE_PATH = join(process.cwd(), 'certs', 'rds-global-bundle.pem');

/**
 * Session timeouts, in milliseconds, sent on the Postgres startup packet.
 *
 * They are not applied with SET. On RDS Proxy a PostgreSQL SET (and
 * set_config) pins the session for the rest of its life, which defeats
 * multiplexing. Startup parameters do not. Web and worker share one set so
 * proxy backends stay interchangeable. SHOW from an app connection is non-zero.
 * Migrations use the migrator's defaults (src/db/migrator.ts): a short lock
 * wait and a long statement cap so a single DDL statement can finish.
 */
export const SESSION_TIMEOUTS = {
  statement_timeout: 60_000,
  lock_timeout: 10_000,
  idle_in_transaction_session_timeout: 30_000,
} as const;

export const MIGRATION_TIMEOUTS = {
  statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
  lock_timeout: DEFAULT_LOCK_TIMEOUT_MS,
  idle_in_transaction_session_timeout: 120_000,
} as const;

/** Modes for which the server certificate must be checked. `require` is included on purpose. */
const VERIFIED_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

export type DatabaseClientRole = 'web' | 'worker' | 'migrate';

export interface VerifiedPostgresSsl {
  ca: string;
  rejectUnauthorized: true;
  servername?: string;
}

export function databaseSslMode(databaseUrl: string): string | null {
  const mode = new URL(databaseUrl).searchParams.get('sslmode');
  return mode ? mode.toLowerCase() : null;
}

let caBundle: string | undefined;

export function readRdsCaBundle(): string {
  if (!caBundle) {
    const pem = readFileSync(RDS_CA_BUNDLE_PATH, 'utf8');
    if (!pem.includes('BEGIN CERTIFICATE')) {
      throw new Error(`RDS CA bundle at ${RDS_CA_BUNDLE_PATH} is not a PEM file`);
    }
    caBundle = pem;
  }
  return caBundle;
}

/**
 * TLS options for postgres.js.
 *
 * Passing `ssl: 'require'` makes postgres.js skip certificate verification
 * (`postgres/src/connection.js`). An explicit options object wins over the
 * URL `sslmode`, so `require` and `verify-ca` still verify the RDS bundle and
 * the hostname. Only `verify-full` is accepted by the production gate. Local
 * URLs with no `sslmode` stay plaintext.
 */
export function postgresSsl(databaseUrl: string): false | VerifiedPostgresSsl {
  const mode = databaseSslMode(databaseUrl);
  if (!mode || mode === 'disable') return false;
  if (!VERIFIED_SSL_MODES.has(mode)) {
    throw new Error(`DATABASE_URL sslmode=${mode} is not supported; use verify-full`);
  }

  const hostname = new URL(databaseUrl).hostname;
  const ssl: VerifiedPostgresSsl = {
    ca: readRdsCaBundle(),
    rejectUnauthorized: true,
  };
  // An IP has no hostname to check. Production URLs use the RDS or proxy DNS name.
  if (!isIP(hostname)) ssl.servername = hostname;
  return ssl;
}

export function postgresClientOptions(input: {
  role: DatabaseClientRole;
  poolMax: number;
  databaseUrl: string;
}): Options<Record<string, never>> {
  const timeouts = input.role === 'migrate' ? MIGRATION_TIMEOUTS : SESSION_TIMEOUTS;
  return {
    max: input.poolMax,
    idle_timeout: 20,
    connect_timeout: 10,
    // Named prepares stay off. RDS Proxy multiplexes extended-query protocol
    // statements, but SQL PREPARE/EXECUTE still pins, and older proxies pinned
    // named protocol statements too. Unnamed queries are unchanged.
    prepare: false,
    ssl: postgresSsl(input.databaseUrl),
    connection: {
      application_name: `blakpath-${input.role}`,
      ...timeouts,
    },
  };
}
