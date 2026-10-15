import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, type MigrationClient } from '@/db/migrator';

/**
 * Real Postgres only. Proves a blocked migration aborts in under five seconds
 * and that CREATE INDEX CONCURRENTLY is not wrapped in a transaction.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return `${error.message} ${code}`;
}

integration('migration runner against Postgres', () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_INTEGRATION=true');

  const admin = postgres(databaseUrl, { max: 1 });

  afterAll(async () => {
    await admin.unsafe('DROP TABLE IF EXISTS migration_lock_probe');
    await admin.unsafe('DROP TABLE IF EXISTS migration_concurrent_probe');
    await admin.unsafe('DROP SCHEMA IF EXISTS drizzle_migrator_it CASCADE');
    await admin.end({ timeout: 5 });
  });

  it('aborts a lock wait in under 5 seconds', async () => {
    await admin.unsafe('DROP TABLE IF EXISTS migration_lock_probe');
    await admin.unsafe('CREATE TABLE migration_lock_probe (id integer)');

    const holder = postgres(databaseUrl, { max: 1 });
    let releaseHold = () => {};
    const released = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let markLocked = () => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holding = holder.begin(async (tx) => {
      await tx.unsafe('LOCK TABLE migration_lock_probe IN ACCESS EXCLUSIVE MODE');
      markLocked();
      await released;
    });
    await locked;

    const migrator = postgres(databaseUrl, { max: 1 });
    const started = performance.now();
    let caught: unknown;
    try {
      await runMigrations(
        migrator as unknown as MigrationClient,
        [
          {
            tag: 'lock_probe',
            hash: 'lock-probe',
            folderMillis: 1,
            statements: ['ALTER TABLE migration_lock_probe ADD COLUMN blocked integer'],
          },
        ],
        {
          lockTimeoutMs: 2_000,
          statementTimeoutMs: 8_000,
          migrationsSchema: 'drizzle_migrator_it',
          log() {},
        },
      );
    } catch (error) {
      caught = error;
    } finally {
      releaseHold();
      await holding;
      await holder.end({ timeout: 5 });
      await migrator.end({ timeout: 5 });
    }

    expect(performance.now() - started).toBeLessThan(5_000);
    expect(errorText(caught)).toMatch(/lock timeout|55P03/i);
  }, 20_000);

  it('runs CREATE INDEX CONCURRENTLY outside a transaction', async () => {
    await admin.unsafe('DROP TABLE IF EXISTS migration_concurrent_probe');
    const migrator = postgres(databaseUrl, { max: 1 });
    try {
      const migration = {
        tag: 'concurrent_probe',
        hash: 'concurrent-probe',
        folderMillis: 2,
        statements: [
          'CREATE TABLE migration_concurrent_probe (id integer)',
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_concurrent_probe_id_idx ON migration_concurrent_probe (id)',
        ],
      };
      const options = {
        lockTimeoutMs: 2_000,
        statementTimeoutMs: 30_000,
        migrationsSchema: 'drizzle_migrator_it',
        log() {},
      };
      await runMigrations(migrator as unknown as MigrationClient, [migration], options);
      await runMigrations(migrator as unknown as MigrationClient, [migration], options);
      const rows = await migrator.unsafe(
        `select indexdef from pg_indexes where indexname = 'migration_concurrent_probe_id_idx'`,
      );
      expect(rows).toHaveLength(1);
    } finally {
      await migrator.end({ timeout: 5 });
    }
  }, 20_000);
});
