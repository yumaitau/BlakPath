import type postgres from 'postgres';

/**
 * Database backstop for the audit trail.
 *
 * Triggers fire for the table owner as well as every other role, including
 * when `session_replication_role` is `replica` (`ENABLE ALWAYS`). A superuser
 * can still disable a trigger; the application role must not be the owner.
 * Privileges are applied on every migrate because the application role may be
 * created after the first migration.
 */

const GUARDED_TABLES = ['audit_events', 'audit_integrity_checkpoints'] as const;

const GUARD_EVENTS = [
  { op: 'update', when: 'BEFORE UPDATE', granularity: 'FOR EACH ROW' },
  { op: 'delete', when: 'BEFORE DELETE', granularity: 'FOR EACH ROW' },
  { op: 'truncate', when: 'BEFORE TRUNCATE', granularity: 'FOR EACH STATEMENT' },
] as const;

/** Runtime role. Migrations must not connect as this role in production. */
export const DEFAULT_AUDIT_APP_ROLE = 'blakpath_app';

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function assertAuditRoleName(role: string): string {
  if (!ROLE_NAME.test(role)) {
    throw new Error('Refusing unsafe database role name');
  }
  return role;
}

export function auditAppendOnlyTriggerName(table: string, op: string): string {
  return `${table}_append_only_${op}`;
}

export const AUDIT_APPEND_ONLY_TRIGGERS: readonly { table: string; name: string }[] =
  GUARDED_TABLES.flatMap((table) =>
    GUARD_EVENTS.map((event) => ({
      table,
      name: auditAppendOnlyTriggerName(table, event.op),
    })),
  );

const AUDIT_APPEND_ONLY_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION audit_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $audit_guard$
BEGIN
  RAISE EXCEPTION 'append-only table % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$audit_guard$;`;

function auditAppendOnlyStatements(): readonly string[] {
  const statements: string[] = [AUDIT_APPEND_ONLY_FUNCTION_SQL];
  for (const table of GUARDED_TABLES) {
    for (const event of GUARD_EVENTS) {
      const name = auditAppendOnlyTriggerName(table, event.op);
      statements.push(
        `CREATE OR REPLACE TRIGGER ${name}\n  ${event.when} ON ${table}\n  ${event.granularity}\n  EXECUTE FUNCTION audit_append_only_guard();`,
      );
      statements.push(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${name};`);
    }
  }
  return statements;
}

/** Idempotent trigger install. Each entry is one SQL statement. */
export const AUDIT_APPEND_ONLY_STATEMENTS: readonly string[] =
  auditAppendOnlyStatements();

export const AUDIT_PUBLIC_REVOKE_STATEMENTS: readonly string[] = [
  'REVOKE ALL PRIVILEGES ON TABLE audit_events FROM PUBLIC',
  'REVOKE ALL PRIVILEGES ON TABLE audit_integrity_checkpoints FROM PUBLIC',
];

/** Grants for the application role: normal DML, audit tables insert/select only. */
export function auditAppGrantStatements(role: string): string[] {
  const safe = assertAuditRoleName(role);
  return [
    `GRANT USAGE ON SCHEMA public TO ${safe}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${safe}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${safe}`,
    `REVOKE ALL PRIVILEGES ON TABLE audit_events FROM ${safe}`,
    `REVOKE ALL PRIVILEGES ON TABLE audit_integrity_checkpoints FROM ${safe}`,
    `GRANT SELECT, INSERT ON TABLE audit_events TO ${safe}`,
    `GRANT SELECT, INSERT ON TABLE audit_integrity_checkpoints TO ${safe}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${safe}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${safe}`,
  ];
}

export async function applyAuditAppendOnlyGuard(
  execute: (statement: string) => Promise<unknown>,
): Promise<void> {
  for (const statement of AUDIT_APPEND_ONLY_STATEMENTS) {
    await execute(statement);
  }
}

export async function applyAuditAppPrivileges(
  sql: postgres.Sql,
  options: { role: string; required: boolean; createIfMissing?: boolean },
): Promise<'applied' | 'skipped'> {
  const role = assertAuditRoleName(options.role);
  for (const statement of AUDIT_PUBLIC_REVOKE_STATEMENTS) {
    await sql.unsafe(statement);
  }
  const found = await sql<{ exists: boolean }[]>`
    select exists(select 1 from pg_roles where rolname = ${role}) as exists
  `;
  if (!found[0]?.exists && options.createIfMissing && !options.required) {
    // Local and CI connect as a superuser. Bound transactions SET LOCAL ROLE
    // to the app role so RLS applies (src/db/rls.ts); it never logs in here.
    await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
    console.log(`[migrate] created role ${role} (NOLOGIN) for local RLS`);
  } else if (!found[0]?.exists) {
    if (options.required) {
      throw new Error(
        `Database role ${role} does not exist; create it before migrating production`,
      );
    }
    console.warn(`[migrate] role ${role} not found; skipped audit grants`);
    return 'skipped';
  }
  for (const statement of auditAppGrantStatements(role)) {
    await sql.unsafe(statement);
  }
  return 'applied';
}
