const LOCAL_PUSH_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * `drizzle-kit push` rewrites a live database without a migration file.
 * Local loopback is allowed. Every other host must go through `db:generate`.
 */
export function assertLocalDatabasePush(databaseUrl: string | undefined): void {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!LOCAL_PUSH_HOSTS.has(host)) {
    throw new Error(
      `db:push refused for host ${host}. Change the schema with pnpm db:generate and commit the migration.`,
    );
  }
}
