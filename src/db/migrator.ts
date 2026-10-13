import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * BlakPath migration runner.
 *
 * Drizzle's pg migrator applies every pending file inside one transaction, so
 * `CREATE INDEX CONCURRENTLY` is impossible and a lock wait has no timeout.
 * This runner keeps Drizzle's journal, hash and `__drizzle_migrations` table,
 * but commits each migration on its own and runs concurrent or validation
 * statements outside a transaction.
 *
 * Release N-1 must keep running on schema N. New files are linted for that
 * expand/contract rule. Files shipped before the rule are grandfathered so
 * already-applied SQL is not rewritten.
 */

export const DEFAULT_LOCK_TIMEOUT_MS = 4_000;
export const MAX_LOCK_TIMEOUT_MS = 4_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 600_000;
export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';
const PROGRESS_TABLE = '__drizzle_migration_progress';
const ADVISORY_LOCK_KEY = 'blakpath-migrate';

const LOCAL_MIGRATE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Migrations 0000–0018 shipped before the expand/contract linter. 0015 and
 * 0016 add foreign keys to existing tables without `NOT VALID`. They stay as
 * applied history; a new file cannot copy that shape.
 */
export const GRANDFATHERED_MIGRATION_TAGS: ReadonlySet<string> = new Set([
  '0000_square_speed',
  '0001_sad_the_phantom',
  '0002_smiling_wallow',
  '0003_ordinary_betty_brant',
  '0004_lovely_vargas',
  '0005_romantic_ultron',
  '0006_aromatic_squadron_sinister',
  '0007_sparkling_maximus',
  '0008_sad_multiple_man',
  '0009_white_rhodey',
  '0010_amazing_micromax',
  '0011_aspiring_joystick',
  '0012_furry_captain_marvel',
  '0013_married_shotgun',
  '0014_council-teams-calendar',
  '0015_sso-consent-email-client',
  '0016_invitation-teams',
  '0017_calendar-exdate',
  '0018_coa-signatures',
]);

export interface MigrationLintIssue {
  tag: string;
  message: string;
}

export interface LoadedMigration {
  tag: string;
  hash: string;
  folderMillis: number;
  statements: string[];
}

export interface MigrationTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface MigrationRow {
  [column: string]: unknown;
}

export interface MigrationQueryable {
  unsafe(
    query: string,
    parameters?: (string | number)[],
  ): Promise<ReadonlyArray<MigrationRow>>;
}

export interface MigrationClient extends MigrationQueryable {
  begin<T>(callback: (tx: MigrationQueryable) => Promise<T>): Promise<T>;
}

export interface MigrationRunOptions extends MigrationTimeouts {
  migrationsSchema?: string;
  migrationsTable?: string;
  log?: (message: string) => void;
}

interface JournalFile {
  entries: Array<{ tag: string; when: number }>;
}

type Env = Readonly<Record<string, string | undefined>>;

export function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function splitMigrationStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Concurrent index builds and constraint validation cannot sit in the migration transaction. */
export function statementRunsOutsideTransaction(statement: string): boolean {
  if (/^\s*--[ \t]*@no-transaction\b/m.test(statement)) return true;
  const code = stripSqlComments(statement);
  return /\bCONCURRENTLY\b/i.test(code) || /\bVALIDATE\s+CONSTRAINT\b/i.test(code);
}

export function resolveMigrationTimeouts(env: Env): MigrationTimeouts {
  const lockTimeoutMs = parseTimeout(
    env.MIGRATION_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_TIMEOUT_MS,
    'MIGRATION_LOCK_TIMEOUT_MS',
  );
  const statementTimeoutMs = parseTimeout(
    env.MIGRATION_STATEMENT_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    'MIGRATION_STATEMENT_TIMEOUT_MS',
  );
  if (lockTimeoutMs < 1 || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw new Error(
      `MIGRATION_LOCK_TIMEOUT_MS must be an integer from 1 to ${MAX_LOCK_TIMEOUT_MS}`,
    );
  }
  if (statementTimeoutMs <= lockTimeoutMs) {
    throw new Error(
      'MIGRATION_STATEMENT_TIMEOUT_MS must be greater than the lock timeout',
    );
  }
  return { lockTimeoutMs, statementTimeoutMs };
}

/**
 * Migrations use the owner role. Local development and CI may fall back to
 * `DATABASE_URL` when the host is loopback or the Compose service `postgres`.
 * Production never falls back, and the two URLs must not share a role.
 */
export function resolveMigratorUrl(env: Env): string {
  const migrator = env.DATABASE_MIGRATOR_URL;
  const app = env.DATABASE_URL;
  if (migrator) {
    if (
      app &&
      databaseUsername(migrator) === databaseUsername(app) &&
      !localMigrateFallbackAllowed(env, migrator)
    ) {
      throw new Error(
        'DATABASE_MIGRATOR_URL must use a different role than DATABASE_URL',
      );
    }
    return migrator;
  }
  if (app && localMigrateFallbackAllowed(env, app)) return app;
  throw new Error(
    'DATABASE_MIGRATOR_URL is required. Migrations must not use the application role.',
  );
}

export function lintMigrationSql(tag: string, sql: string): MigrationLintIssue[] {
  if (GRANDFATHERED_MIGRATION_TAGS.has(tag)) return [];
  const issues: MigrationLintIssue[] = [];
  const code = stripSqlComments(sql);
  const created = tablesCreated(sql);

  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(code)) issues.push({ tag, message: rule.message });
  }

  for (const statement of splitMigrationStatements(sql)) {
    const body = stripSqlComments(statement);
    if (
      /\bADD\s+COLUMN\b/i.test(body) &&
      /\bNOT\s+NULL\b/i.test(body) &&
      !/\bDEFAULT\b/i.test(body)
    ) {
      issues.push({
        tag,
        message:
          'ADD COLUMN NOT NULL needs a DEFAULT so the previous release can still insert',
      });
    }

    if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(body)) {
      if (!/\bIF\s+NOT\s+EXISTS\b/i.test(body)) {
        issues.push({
          tag,
          message: 'CREATE INDEX CONCURRENTLY must use IF NOT EXISTS so a retry is safe',
        });
      }
    } else if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(body)) {
      const table = referencedTable(body, /\bON\s+(?:ONLY\s+)?/i);
      if (table && !created.has(table)) {
        issues.push({
          tag,
          message: `CREATE INDEX on existing table ${table} must be CONCURRENTLY`,
        });
      }
    }

    if (!/\bALTER\s+TABLE\b/i.test(body) || !/\bADD\s+CONSTRAINT\b/i.test(body)) continue;
    if (!/\bREFERENCES\b/i.test(body)) continue;
    const table = referencedTable(body, /\bALTER\s+TABLE\s+(?:ONLY\s+)?/i);
    if (!table || created.has(table)) continue;
    const constraint = constraintName(body);
    if (!/\bNOT\s+VALID\b/i.test(body)) {
      issues.push({
        tag,
        message: `foreign key ${constraint ?? table} on existing table ${table} must be NOT VALID`,
      });
    }
    if (
      constraint &&
      !new RegExp(
        `\\bVALIDATE\\s+CONSTRAINT\\s+"?${escapeRegExp(constraint)}"?\\b`,
        'i',
      ).test(code)
    ) {
      issues.push({
        tag,
        message: `foreign key ${constraint} needs VALIDATE CONSTRAINT in the same migration`,
      });
    }
  }

  return issues;
}

export function lintMigrationDirectory(folder: string): MigrationLintIssue[] {
  return readMigrationFolder(folder).issues;
}

export function loadMigrationFiles(folder: string): LoadedMigration[] {
  const { migrations, issues } = readMigrationFolder(folder);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.tag}: ${issue.message}`).join('\n'));
  }
  return migrations;
}

export async function runMigrations(
  sql: MigrationClient,
  migrations: readonly LoadedMigration[],
  options: MigrationRunOptions,
): Promise<void> {
  const timeouts = {
    lockTimeoutMs: options.lockTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs,
  };
  if (timeouts.lockTimeoutMs < 1 || timeouts.lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw new Error(`lock timeout must be 1..${MAX_LOCK_TIMEOUT_MS} ms`);
  }
  const schema = options.migrationsSchema ?? MIGRATIONS_SCHEMA;
  const table = options.migrationsTable ?? MIGRATIONS_TABLE;
  const log = options.log ?? ((message: string) => console.log(message));
  const names = migrationNames(schema, table);

  await setSessionTimeouts(sql, timeouts);
  const locked = await tryAdvisoryLock(sql);
  if (!locked) throw new Error('Another BlakPath migration is already running');

  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${names.migrations} (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`,
    );
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${names.progress} (
        hash text NOT NULL,
        statement_index integer NOT NULL,
        PRIMARY KEY (hash, statement_index)
      )`,
    );

    const lastAt = await latestMigrationAt(sql, names.migrations);
    for (const migration of migrations) {
      if (lastAt !== undefined && !(lastAt < migration.folderMillis)) continue;
      log(`[migrate] ${migration.tag}`);
      await applyMigration(sql, migration, names, timeouts);
    }
  } finally {
    await sql.unsafe(`SELECT pg_advisory_unlock(hashtext('${ADVISORY_LOCK_KEY}'))`);
  }
}

const DESTRUCTIVE_RULES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\bDROP\s+TABLE\b/i,
    message: 'DROP TABLE breaks the previous release; contract it in a later migration',
  },
  {
    pattern: /\bDROP\s+COLUMN\b/i,
    message: 'DROP COLUMN breaks the previous release; contract it in a later migration',
  },
  {
    pattern: /\bRENAME\s+COLUMN\b/i,
    message: 'RENAME COLUMN breaks the previous release',
  },
  {
    pattern: /\bRENAME\s+TO\b/i,
    message: 'RENAME TO breaks the previous release',
  },
  {
    pattern: /\bSET\s+NOT\s+NULL\b/i,
    message:
      'SET NOT NULL breaks previous-release inserts; backfill and enforce it in a later migration',
  },
];

function readMigrationFolder(folder: string): {
  migrations: LoadedMigration[];
  issues: MigrationLintIssue[];
} {
  const journalPath = path.join(folder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Can't find meta/_journal.json file`);
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as JournalFile;
  const migrations: LoadedMigration[] = [];
  const issues: MigrationLintIssue[] = [];
  for (const entry of journal.entries) {
    const migrationPath = path.join(folder, `${entry.tag}.sql`);
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`No file ${migrationPath} found in ${folder} folder`);
    }
    const query = fs.readFileSync(migrationPath, 'utf8');
    issues.push(...lintMigrationSql(entry.tag, query));
    migrations.push({
      tag: entry.tag,
      hash: createHash('sha256').update(query).digest('hex'),
      folderMillis: entry.when,
      statements: splitMigrationStatements(query),
    });
  }
  return { migrations, issues };
}

async function applyMigration(
  sql: MigrationClient,
  migration: LoadedMigration,
  names: { migrations: string; progress: string },
  timeouts: MigrationTimeouts,
): Promise<void> {
  const done = await completedStatements(sql, names.progress, migration.hash);
  let index = 0;
  while (index < migration.statements.length) {
    if (done.has(index)) {
      index += 1;
      continue;
    }
    const statement = migration.statements[index];
    if (statement === undefined) break;
    if (statementRunsOutsideTransaction(statement)) {
      await sql.unsafe(statement);
      await sql.begin(async (tx) => {
        await setLocalTimeouts(tx, timeouts);
        await insertProgress(tx, names.progress, migration.hash, index);
      });
      index += 1;
      continue;
    }

    const start = index;
    while (index < migration.statements.length) {
      const next = migration.statements[index];
      if (next === undefined || statementRunsOutsideTransaction(next)) break;
      index += 1;
    }
    await sql.begin(async (tx) => {
      await setLocalTimeouts(tx, timeouts);
      for (let cursor = start; cursor < index; cursor += 1) {
        if (done.has(cursor)) continue;
        const batched = migration.statements[cursor];
        if (batched === undefined) continue;
        await tx.unsafe(batched);
        await insertProgress(tx, names.progress, migration.hash, cursor);
      }
    });
  }

  await sql.begin(async (tx) => {
    await setLocalTimeouts(tx, timeouts);
    await tx.unsafe(
      `insert into ${names.migrations} ("hash", "created_at") values ($1, $2)`,
      [migration.hash, migration.folderMillis],
    );
    await tx.unsafe(`delete from ${names.progress} where "hash" = $1`, [migration.hash]);
  });
}

function migrationNames(
  schema: string,
  table: string,
): { migrations: string; progress: string } {
  const quotedSchema = quoteIdent(schema);
  return {
    migrations: `${quotedSchema}.${quoteIdent(table)}`,
    progress: `${quotedSchema}.${quoteIdent(PROGRESS_TABLE)}`,
  };
}

async function setSessionTimeouts(
  sql: MigrationQueryable,
  timeouts: MigrationTimeouts,
): Promise<void> {
  await sql.unsafe(`SET lock_timeout = ${timeouts.lockTimeoutMs}`);
  await sql.unsafe(`SET statement_timeout = ${timeouts.statementTimeoutMs}`);
}

async function setLocalTimeouts(
  sql: MigrationQueryable,
  timeouts: MigrationTimeouts,
): Promise<void> {
  await sql.unsafe(`SET LOCAL lock_timeout = ${timeouts.lockTimeoutMs}`);
  await sql.unsafe(`SET LOCAL statement_timeout = ${timeouts.statementTimeoutMs}`);
}

async function tryAdvisoryLock(sql: MigrationQueryable): Promise<boolean> {
  const rows = await sql.unsafe(
    `SELECT pg_try_advisory_lock(hashtext('${ADVISORY_LOCK_KEY}')) AS locked`,
  );
  const locked = rows[0]?.locked;
  return locked === true || locked === 't';
}

async function latestMigrationAt(
  sql: MigrationQueryable,
  migrationsTable: string,
): Promise<number | undefined> {
  const rows = await sql.unsafe(
    `select created_at from ${migrationsTable} order by created_at desc limit 1`,
  );
  const createdAt = rows[0]?.created_at;
  if (createdAt === undefined) return undefined;
  return Number(createdAt);
}

async function completedStatements(
  sql: MigrationQueryable,
  progressTable: string,
  hash: string,
): Promise<Set<number>> {
  const rows = await sql.unsafe(
    `select statement_index from ${progressTable} where hash = $1`,
    [hash],
  );
  const completed = new Set<number>();
  for (const row of rows) {
    const value = row.statement_index;
    if (typeof value === 'number') completed.add(value);
    else if (typeof value === 'string' && value !== '') completed.add(Number(value));
  }
  return completed;
}

async function insertProgress(
  sql: MigrationQueryable,
  progressTable: string,
  hash: string,
  statementIndex: number,
): Promise<void> {
  await sql.unsafe(
    `insert into ${progressTable} ("hash", "statement_index") values ($1, $2)`,
    [hash, statementIndex],
  );
}

function parseTimeout(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(`${label} must be an integer number of milliseconds`);
  return Number(value);
}

function localMigrateFallbackAllowed(env: Env, databaseUrl: string): boolean {
  if ((env.NODE_ENV ?? 'development') === 'production') return false;
  return LOCAL_MIGRATE_HOSTS.has(databaseHost(databaseUrl));
}

function databaseHost(databaseUrl: string): string {
  return parseDatabaseUrl(databaseUrl, 'database URL').hostname;
}

function databaseUsername(databaseUrl: string): string {
  return decodeURIComponent(parseDatabaseUrl(databaseUrl, 'database URL').username);
}

function parseDatabaseUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
}

function tablesCreated(sql: string): Set<string> {
  const names = new Set<string>();
  const pattern =
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z_][\w]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w]*))?)/gi;
  for (const match of sql.matchAll(pattern)) {
    const name = lastIdentifier(match[1]);
    if (name) names.add(name);
  }
  return names;
}

function referencedTable(statement: string, prefix: RegExp): string | undefined {
  const match = statement.match(
    new RegExp(
      `${prefix.source}((?:"[^"]+"|[A-Za-z_][\\w]*)(?:\\s*\\.\\s*(?:"[^"]+"|[A-Za-z_][\\w]*))?)`,
      'i',
    ),
  );
  return lastIdentifier(match?.[1]);
}

function lastIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value.split('.').map((part) => part.trim().replace(/^"|"$/g, ''));
  return parts[parts.length - 1]?.toLowerCase();
}

function constraintName(statement: string): string | undefined {
  const match = statement.match(/\bADD\s+CONSTRAINT\s+(?:"([^"]+)"|([A-Za-z_][\w]*))/i);
  return match?.[1] ?? match?.[2];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
