/**
 * Migrations connect as the owning role. The running application must use a
 * different role so table ownership does not grant it UPDATE/DELETE/TRUNCATE.
 */

export interface MigrationUrlEnv {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  DATABASE_MIGRATION_URL?: string;
}

export function postgresUsername(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.username) return null;
    return decodeURIComponent(parsed.username);
  } catch {
    return null;
  }
}

/** Why a production migration URL cannot be used, or null when it is distinct. */
export function migrationRoleIssue(env: MigrationUrlEnv): string | null {
  if (!env.DATABASE_MIGRATION_URL) {
    return 'DATABASE_MIGRATION_URL is required in production';
  }
  const migrationUser = postgresUsername(env.DATABASE_MIGRATION_URL);
  const appUser = env.DATABASE_URL ? postgresUsername(env.DATABASE_URL) : null;
  if (!migrationUser) {
    return 'DATABASE_MIGRATION_URL must include a database role';
  }
  if (appUser && migrationUser === appUser) {
    return 'DATABASE_MIGRATION_URL must use a different database role than DATABASE_URL';
  }
  return null;
}

export function resolveMigrationDatabaseUrl(env: MigrationUrlEnv): string {
  if (env.NODE_ENV === 'production') {
    const issue = migrationRoleIssue(env);
    if (issue) throw new Error(issue);
    return env.DATABASE_MIGRATION_URL as string;
  }
  const url = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL or DATABASE_MIGRATION_URL is required to run migrations',
    );
  }
  return url;
}
