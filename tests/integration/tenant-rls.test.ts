import { randomUUID } from 'node:crypto';
import { eq, sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditAppGrantStatements } from '@/db/audit-guard';
import {
  applyRlsContext,
  PLATFORM_CONTEXT,
  RLS_FUNCTION,
  tenantContext,
  type RlsContext,
} from '@/db/rls';
import {
  PLATFORM_CHAIN_TABLES,
  SHARED_READ_TABLES,
  tenantTables,
} from '../helpers/tenant-tables';
import {
  seedTenantRows,
  snapshotOrganisation,
  type IsolationIds,
} from './tenant-rls-seed';

/**
 * Proves the migrated database, not the SQL text. Integration tests connect
 * as a superuser, which bypasses RLS even when it is forced, so these checks
 * log in as a separate non-owner, non-superuser role with the production
 * grants (`auditAppGrantStatements`) and run every query as that role.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

const LOGIN_ROLE = 'blakpath_rls_itest';
const LOGIN_PASSWORD = 'blakpath_rls_itest_pw';
/** Append-only: the app role has SELECT and INSERT only (src/db/audit-guard.ts). */
const INSERT_ONLY_TABLES = new Set<string>(PLATFORM_CHAIN_TABLES);

type Row = Record<string, unknown>;

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier ${name}`);
  return `"${name}"`;
}

integration('postgres row-level security', () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');
  const ids: IsolationIds = {
    orgA: randomUUID(),
    orgB: randomUUID(),
    userId: randomUUID(),
  };
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  let app: postgres.Sql;
  let tables: readonly string[] = [];

  /** Run `work` as the login role inside a transaction that always rolls back. */
  async function asApp<T>(
    context: RlsContext | null,
    work: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    let result: { value: T } | undefined;
    await app
      .begin(async (tx) => {
        if (context) await applyRlsContext(tx, context);
        result = { value: await work(tx) };
        throw new Error('rollback-probe');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback-probe') throw error;
      });
    if (!result) throw new Error('probe did not run');
    return result.value;
  }

  async function refused(
    context: RlsContext,
    work: (tx: postgres.TransactionSql) => Promise<unknown>,
  ): Promise<string> {
    try {
      await asApp(context, work);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return 'not refused';
  }

  beforeAll(async () => {
    tables = (await seedTenantRows(admin, ids)).tables;
    await admin.unsafe(`DROP OWNED BY ${LOGIN_ROLE}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${LOGIN_ROLE}`);
    await admin.unsafe(
      `CREATE ROLE ${LOGIN_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${LOGIN_PASSWORD}'`,
    );
    for (const statement of auditAppGrantStatements(LOGIN_ROLE)) {
      await admin.unsafe(statement);
    }
    const [database] = await admin<{ name: string }[]>`select current_database() as name`;
    await admin.unsafe(
      `GRANT CONNECT ON DATABASE ${quote(database?.name ?? '')} TO ${LOGIN_ROLE}`,
    );
    const url = new URL(databaseUrl);
    url.username = LOGIN_ROLE;
    url.password = LOGIN_PASSWORD;
    app = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  }, 120_000);

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${LOGIN_ROLE}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${LOGIN_ROLE}`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  });

  it('the login role is a non-owner, non-superuser without BYPASSRLS', async () => {
    const [role] = await app<{ superuser: boolean; bypass: boolean }[]>`
      select rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname = current_user`;
    expect(role).toEqual({ superuser: false, bypass: false });
    const owned = await app`
      select c.relname from pg_class c
      where c.relowner = (select oid from pg_roles where rolname = current_user)`;
    expect(owned).toHaveLength(0);
  });

  it('every table with an organisation_id column has forced RLS and the tenant policy', async () => {
    const rows = await admin<
      { name: string; enabled: boolean; forced: boolean; policies: Row[] | null }[]
    >`
      select c.relname as name,
             c.relrowsecurity as enabled,
             c.relforcerowsecurity as forced,
             (select json_agg(json_build_object(
                'name', p.polname,
                'cmd', p.polcmd,
                'using', pg_get_expr(p.polqual, p.polrelid),
                'check', pg_get_expr(p.polwithcheck, p.polrelid)))
              from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'organisation_id' and not a.attisdropped)
      order by c.relname`;

    const missing: string[] = [];
    for (const row of rows) {
      const isolation = (row.policies ?? []).find((p) => p.name === 'tenant_isolation');
      const ok =
        row.enabled &&
        row.forced &&
        isolation?.cmd === '*' &&
        String(isolation.using).includes(RLS_FUNCTION) &&
        String(isolation.check).includes(RLS_FUNCTION);
      if (!ok) missing.push(row.name);
      const sharedRead = (row.policies ?? []).some(
        (p) => p.name === 'tenant_shared_read',
      );
      expect(sharedRead, row.name).toBe(
        (SHARED_READ_TABLES as readonly string[]).includes(row.name),
      );
      expect(
        (row.policies ?? []).every(
          (p) => p.name === 'tenant_isolation' || p.name === 'tenant_shared_read',
        ),
        row.name,
      ).toBe(true);
    }
    expect(missing).toEqual([]);
    expect(rows.map((row) => row.name)).toEqual(
      tenantTables().map((table) => table.name),
    );
    expect([...tables].sort()).toEqual(rows.map((row) => row.name));
  });

  it('a tenant transaction reads none of another organisation, on every table', async () => {
    const withNullRows = new Set<string>();
    for (const table of SHARED_READ_TABLES) {
      const [row] = await admin.unsafe<{ n: number }[]>(
        `select count(*)::int as n from ${quote(table)} where organisation_id is null`,
      );
      if ((row?.n ?? 0) > 0) withNullRows.add(table);
    }
    const leaks = await asApp(tenantContext(ids.orgA), async (tx) => {
      const found: string[] = [];
      for (const table of tables) {
        const visible = await tx.unsafe<{ org: string | null }[]>(
          `select organisation_id::text as org from ${quote(table)}`,
        );
        if (visible.some((row) => row.org !== ids.orgA && row.org !== null)) {
          found.push(`${table}: foreign row`);
        }
        if (!visible.some((row) => row.org === ids.orgA))
          found.push(`${table}: no own row`);
        const shared = visible.some((row) => row.org === null);
        if (shared !== withNullRows.has(table)) {
          found.push(`${table}: null-org visibility ${String(shared)}`);
        }
      }
      return found;
    });
    expect(leaks).toEqual([]);
  });

  it('a tenant transaction cannot change or delete another organisation’s rows', async () => {
    const before = await snapshotOrganisation(admin, tables, ids.orgB);
    const touched = await asApp(tenantContext(ids.orgA), async (tx) => {
      const changed: string[] = [];
      for (const table of tables) {
        if (INSERT_ONLY_TABLES.has(table)) continue;
        const updated = await tx.unsafe(
          `update ${quote(table)} set organisation_id = organisation_id where organisation_id = $1`,
          [ids.orgB],
        );
        const deleted = await tx.unsafe(
          `delete from ${quote(table)} where organisation_id = $1`,
          [ids.orgB],
        );
        if (updated.count !== 0 || deleted.count !== 0) changed.push(table);
      }
      return changed;
    });
    expect(touched).toEqual([]);
    expect(await snapshotOrganisation(admin, tables, ids.orgB)).toBe(before);
  });

  it('a tenant transaction cannot move its rows into another organisation', async () => {
    for (const table of tables) {
      if (INSERT_ONLY_TABLES.has(table)) continue;
      const message = await refused(tenantContext(ids.orgA), (tx) =>
        tx.unsafe(
          `update ${quote(table)} set organisation_id = $2 where organisation_id = $1`,
          [ids.orgA, ids.orgB],
        ),
      );
      expect(message, table).toMatch(
        /row-level security|violates foreign key|duplicate key/,
      );
      // A foreign-key or unique error would hide the policy; prove the policy.
      if (!/row-level security/.test(message)) {
        throw new Error(`${table}: move refused for a reason other than RLS: ${message}`);
      }
    }
  });

  it('a tenant transaction cannot insert rows for another organisation or the platform', async () => {
    const insert = (org: string | null) => (tx: postgres.TransactionSql) =>
      tx.unsafe(
        `insert into feature_flags (id, organisation_id, key, enabled)
         values ($1, $2, $3, true)`,
        [randomUUID(), org as string, `rls-probe-${randomUUID()}`],
      );
    expect(await refused(tenantContext(ids.orgA), insert(ids.orgB))).toMatch(
      /row-level security/,
    );
    expect(await refused(tenantContext(ids.orgA), insert(null))).toMatch(
      /row-level security/,
    );
    const auditMessage = await refused(tenantContext(ids.orgA), (tx) =>
      tx.unsafe(
        `insert into audit_events (id, organisation_id, action, resource_type, result, hash)
         values ($1, $2, 'rls.probe', 'probe', 'success', $3)`,
        [randomUUID(), ids.orgB, `probe-${randomUUID()}`],
      ),
    );
    expect(auditMessage).toMatch(/row-level security/);
    // Own organisation still works.
    await expect(asApp(tenantContext(ids.orgA), insert(ids.orgA))).resolves.toBeDefined();
  });

  it('the platform bypass sees every organisation and the platform chain', async () => {
    const [platform] = await admin<{ n: number }[]>`
      select count(*)::int as n from audit_events where organisation_id is null`;
    const seen = await asApp(PLATFORM_CONTEXT, async (tx) => {
      const rows = await tx.unsafe<{ org: string | null }[]>(
        `select distinct organisation_id::text as org from audit_events
         where organisation_id is null or organisation_id in ($1, $2)`,
        [ids.orgA, ids.orgB],
      );
      return rows.map((row) => row.org);
    });
    const expected = [ids.orgA, ids.orgB, ...((platform?.n ?? 0) > 0 ? [null] : [])];
    expect(new Set(seen)).toEqual(new Set(expected));
  });

  it('settings are transaction-local and do not leak to the next transaction', async () => {
    await app.begin(async (tx) => {
      await applyRlsContext(tx, tenantContext(ids.orgA));
    });
    const [settings] = await app<{ org: string | null; bypass: string | null }[]>`
      select current_setting('app.org_id', true) as org,
             current_setting('app.bypass_rls', true) as bypass`;
    expect(settings?.org ?? '').toBe('');
    expect(settings?.bypass ?? '').toBe('');
  });

  it('a session with no context is allowed only for release N-1 (phase 1)', async () => {
    // Release N-1 sets no context. Until the follow-up migration makes the
    // unset case deny, it reads as before. Bound handles always set one.
    const count = await asApp(null, async (tx) => {
      const [row] = await tx.unsafe<{ n: number }[]>(
        `select count(*)::int as n from applications where organisation_id in ($1, $2)`,
        [ids.orgA, ids.orgB],
      );
      return row?.n ?? 0;
    });
    expect(count).toBe(2);
  });

  it('scopeFor binds RLS on the application pool, including nested platform work', async () => {
    const { scopeFor } = await import('@/db/tenant-db');
    const { platformDb } = await import('@/db/platform-db');
    const { applications } = await import('@/db/schema');
    const scope = scopeFor(ids.orgA);

    const unfiltered = await scope.db
      .select({ org: applications.organisationId })
      .from(applications);
    expect(unfiltered.map((row) => row.org)).toEqual([ids.orgA]);

    const result = await scope.db.transaction(async (tx) => {
      const [role] = await tx.execute<{ role: string }>(
        dsql`select current_user as role`,
      );
      const platformRows = await platformDb
        .select({ org: applications.organisationId })
        .from(applications)
        .where(eq(applications.organisationId, ids.orgB));
      // Back in the tenant context after the platform savepoint.
      const afterwards = await tx
        .select({ org: applications.organisationId })
        .from(applications);
      const viaScope = await scope.db
        .select({ org: applications.organisationId })
        .from(applications);
      return { role: role?.role, platformRows, afterwards, viaScope };
    });
    expect(result.role).toBe(process.env.AUDIT_DB_APP_ROLE || 'blakpath_app');
    expect(result.platformRows).toEqual([{ org: ids.orgB }]);
    expect(result.afterwards.map((row) => row.org)).toEqual([ids.orgA]);
    expect(result.viaScope.map((row) => row.org)).toEqual([ids.orgA]);

    const foreign = await scopeFor(ids.orgB)
      .db.select({ org: applications.organisationId })
      .from(applications);
    expect(foreign.map((row) => row.org)).toEqual([ids.orgB]);
  });
});
