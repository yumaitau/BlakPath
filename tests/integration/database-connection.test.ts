import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { postgresClientOptions, SESSION_TIMEOUTS } from '@/db/postgres-options';

/**
 * Runs only where a real disposable Postgres database is deliberately enabled.
 * Proves startup parameters arrive as non-zero session timeouts.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

integration('app postgres sessions', () => {
  const clients: Array<ReturnType<typeof postgres>> = [];

  afterAll(async () => {
    await Promise.all(clients.map((sql) => sql.end({ timeout: 5 })));
  });

  it('shows a non-zero statement_timeout, lock_timeout and idle_in_transaction_session_timeout', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');

    const sql = postgres(
      databaseUrl,
      postgresClientOptions({ role: 'web', poolMax: 1, databaseUrl }),
    );
    clients.push(sql);

    const [statement] = await sql<
      { statement_timeout: string }[]
    >`show statement_timeout`;
    const [lock] = await sql<{ lock_timeout: string }[]>`show lock_timeout`;
    const [idle] = await sql<
      { idle_in_transaction_session_timeout: string }[]
    >`show idle_in_transaction_session_timeout`;

    expect(statement?.statement_timeout).toBe('1min');
    expect(lock?.lock_timeout).toBe('10s');
    expect(idle?.idle_in_transaction_session_timeout).toBe('30s');
    expect(SESSION_TIMEOUTS.statement_timeout).toBe(60_000);
  });
});
