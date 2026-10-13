import { APP_ROLE, PLATFORM_ROLE } from './rls';

/**
 * Create the two roles tenant isolation depends on.
 *
 * `blakpath_app` is subject to row-level security. `blakpath_platform` is
 * BYPASSRLS and is only for vetted pre-tenant paths. Neither can log in.
 *
 * CREATE ROLE cannot run inside a transaction, and drizzle wraps every
 * migration in one, so this runs on the postgres.js client before migrate.
 * The caller must be a superuser or have CREATEROLE. Grants that let the
 * migrator SET ROLE live in `0020_rls-force-and-roles.sql`.
 */
type RoleClient = {
  unsafe(query: string): Promise<unknown>;
};

const ROLE_SQL: Record<string, { create: string; alter: string }> = {
  [APP_ROLE]: {
    create: `CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`,
    alter: `ALTER ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`,
  },
  [PLATFORM_ROLE]: {
    create: `CREATE ROLE ${PLATFORM_ROLE} NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`,
    alter: `ALTER ROLE ${PLATFORM_ROLE} NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`,
  },
};

export async function ensureRlsRoles(sql: RoleClient): Promise<void> {
  const rows = (await sql.unsafe(
    `select rolname from pg_roles where rolname in ('${APP_ROLE}', '${PLATFORM_ROLE}')`,
  )) as Array<{ rolname: string }>;
  const present = new Set(rows.map((row) => row.rolname));
  for (const role of [APP_ROLE, PLATFORM_ROLE]) {
    const statement = ROLE_SQL[role];
    if (!statement) continue;
    if (!present.has(role)) await sql.unsafe(statement.create);
    await sql.unsafe(statement.alter);
  }
}
