import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyAuditAppPrivileges,
  applyAuditAppendOnlyGuard,
  AUDIT_APPEND_ONLY_TRIGGERS,
} from '@/db/audit-guard';

const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

const APP_ROLE = 'blakpath_app_itest';
const APP_PASSWORD = 'blakpath_app_itest_pw';

function assertIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('Refusing unsafe SQL identifier');
  }
  return value;
}

/**
 * Run one statement inside a transaction that always rolls back. A successful
 * TRUNCATE must not commit.
 */
async function expectRolledBack(
  sql: postgres.Sql,
  run: (tx: postgres.TransactionSql) => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await sql.begin(async (tx) => {
      try {
        await run(tx);
      } catch (error) {
        caught = error;
      }
      throw new Error('rollback-probe');
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('rollback-probe')) {
      caught ??= error;
    }
  }
  const message = caught instanceof Error ? caught.message : String(caught ?? '');
  expect(message).toMatch(pattern);
}

integration('audit append-only guards', () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

  const admin = postgres(databaseUrl, { max: 1 });
  let app: postgres.Sql | undefined;
  let organisationId: string | undefined;

  afterAll(async () => {
    try {
      for (const trigger of AUDIT_APPEND_ONLY_TRIGGERS) {
        const table = assertIdent(trigger.table);
        const name = assertIdent(trigger.name);
        await admin
          .unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${name}`)
          .catch(() => undefined);
      }
      if (organisationId) {
        await admin`delete from audit_events where organisation_id = ${organisationId}`;
        await admin`delete from audit_integrity_checkpoints where organisation_id = ${organisationId}`;
      }
      await admin
        .unsafe(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${APP_ROLE}`,
        )
        .catch(() => undefined);
      await admin
        .unsafe(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${APP_ROLE}`,
        )
        .catch(() => undefined);
      await admin.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => undefined);
    } finally {
      for (const trigger of AUDIT_APPEND_ONLY_TRIGGERS) {
        const table = assertIdent(trigger.table);
        const name = assertIdent(trigger.name);
        await admin
          .unsafe(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${name}`)
          .catch(() => undefined);
      }
      await app?.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
    }
  });

  it('lets the application role insert and blocks update, delete and truncate for owner and app', async () => {
    await applyAuditAppendOnlyGuard((statement) => admin.unsafe(statement));
    await admin.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => undefined);
    await admin.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`);
    await applyAuditAppPrivileges(admin, { role: APP_ROLE, required: true });
    const [database] = await admin<{ name: string }[]>`select current_database() as name`;
    const databaseName = assertIdent(database?.name ?? '');
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${databaseName} TO ${APP_ROLE}`);

    const orgId = uuidv7();
    organisationId = orgId;
    const genesisId = uuidv7();
    await admin`
      insert into audit_events (
        id, organisation_id, action, resource_type, result, hash
      ) values (
        ${genesisId}, ${orgId}, 'record.viewed', 'application', 'success', 'genesis-hash'
      )
    `;
    await expect(
      admin`
        insert into audit_events (
          id, organisation_id, action, resource_type, result, hash, prev_hash
        ) values (
          ${uuidv7()}, ${orgId}, 'record.viewed', 'application', 'success', 'fork-hash', null
        )
      `,
    ).rejects.toMatchObject({ code: '23505' });

    const appUrl = new URL(databaseUrl);
    appUrl.username = APP_ROLE;
    appUrl.password = APP_PASSWORD;
    app = postgres(appUrl.toString(), { max: 1 });
    const childId = uuidv7();
    await app`
      insert into audit_events (
        id, organisation_id, action, resource_type, result, hash, prev_hash
      ) values (
        ${childId},
        ${orgId},
        'record.viewed',
        'application',
        'success',
        'child-hash',
        'genesis-hash'
      )
    `;

    await expectRolledBack(
      app,
      (tx) => tx`update audit_events set reason = 'tampered' where id = ${childId}`,
      /permission denied/i,
    );
    await expectRolledBack(
      app,
      (tx) => tx`delete from audit_events where id = ${childId}`,
      /permission denied/i,
    );
    await expectRolledBack(
      app,
      (tx) => tx.unsafe('TRUNCATE TABLE audit_events'),
      /permission denied/i,
    );

    await expectRolledBack(
      admin,
      (tx) => tx`update audit_events set reason = 'tampered' where id = ${genesisId}`,
      /append-only table audit_events rejects UPDATE/,
    );
    await expectRolledBack(
      admin,
      (tx) => tx`delete from audit_events where id = ${genesisId}`,
      /append-only table audit_events rejects DELETE/,
    );
    await expectRolledBack(
      admin,
      (tx) => tx.unsafe('TRUNCATE TABLE audit_events'),
      /append-only table audit_events rejects TRUNCATE/,
    );

    const [remaining] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events where organisation_id = ${orgId}
    `;
    expect(remaining?.count).toBe(2);
  });
});
