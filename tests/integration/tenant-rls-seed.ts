import { randomUUID } from 'node:crypto';

/** Text planted in org B rows. A cross-tenant read must not return it. */
export const TENANT_MARKER = 'RLS-ORG-B-MARKER';

const IDENT = /^[a-z_][a-z0-9_]*$/;

type Sql = {
  unsafe(query: string, parameters?: readonly unknown[]): Promise<unknown>;
};

interface ColumnInfo {
  readonly name: string;
  readonly dataType: string;
  readonly udtName: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
}

export interface IsolationIds {
  readonly orgA: string;
  readonly orgB: string;
  readonly userId: string;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier "${name}".`);
  return `"${name}"`;
}

async function columnsOf(sql: Sql, table: string): Promise<ColumnInfo[]> {
  const result = await sql.unsafe(
    `select column_name, data_type, udt_name, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = $1
     order by ordinal_position`,
    [table],
  );
  return rowsOf(result).map((row) => ({
    name: String(row.column_name),
    dataType: String(row.data_type),
    udtName: String(row.udt_name),
    nullable: row.is_nullable === 'YES',
    hasDefault: row.column_default !== null && row.column_default !== undefined,
  }));
}

async function foreignKeys(
  sql: Sql,
  table: string,
): Promise<Array<{ column: string; foreignTable: string }>> {
  const result = await sql.unsafe(
    `select kcu.column_name, ccu.table_name as foreign_table
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on tc.constraint_name = kcu.constraint_name
      and tc.table_schema = kcu.table_schema
     join information_schema.constraint_column_usage ccu
       on ccu.constraint_name = tc.constraint_name
      and ccu.table_schema = tc.table_schema
     where tc.constraint_type = 'FOREIGN KEY'
       and tc.table_schema = 'public'
       and tc.table_name = $1`,
    [table],
  );
  return rowsOf(result).map((row) => ({
    column: String(row.column_name),
    foreignTable: String(row.foreign_table),
  }));
}

async function tenantTableNames(sql: Sql): Promise<string[]> {
  const result = await sql.unsafe(
    `select c.relname as name
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and exists (
         select 1 from information_schema.columns col
         where col.table_schema = 'public'
           and col.table_name = c.relname
           and col.column_name = 'organisation_id'
       )
     order by c.relname`,
  );
  return rowsOf(result).map((row) => String(row.name));
}

function orderTables(
  tables: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): string[] {
  const pending = new Map<string, Set<string>>();
  for (const table of tables) {
    const deps = (dependencies.get(table) ?? []).filter(
      (dep) => dep !== table && tables.includes(dep),
    );
    pending.set(table, new Set(deps));
  }
  const ordered: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([table]) => table)
      .sort();
    const next = ready[0];
    if (!next) {
      throw new Error(
        `Tenant tables have a foreign-key cycle: ${[...pending.keys()].join(', ')}.`,
      );
    }
    ordered.push(next);
    pending.delete(next);
    for (const deps of pending.values()) deps.delete(next);
  }
  return ordered;
}

const enumLabels = new Map<string, string>();

async function enumLabel(sql: Sql, udtName: string): Promise<string> {
  const cached = enumLabels.get(udtName);
  if (cached) return cached;
  const result = await sql.unsafe(
    `select e.enumlabel as label
     from pg_type t
     join pg_enum e on e.enumtypid = t.oid
     where t.typname = $1
     order by e.enumsortorder
     limit 1`,
    [udtName],
  );
  const label = rowsOf(result)[0]?.label;
  if (typeof label !== 'string' || !label) {
    throw new Error(`No enum label for type "${udtName}".`);
  }
  enumLabels.set(udtName, label);
  return label;
}

async function permissionKey(sql: Sql): Promise<string> {
  const existing = rowsOf(await sql.unsafe(`select key from permissions limit 1`));
  const key = existing[0]?.key;
  if (typeof key === 'string' && key) return key;
  const created = 'application:read-any';
  await sql.unsafe(
    `insert into permissions (key, description, category) values ($1, $2, $3)`,
    [created, 'isolation fixture', 'application'],
  );
  return created;
}

interface InsertPlan {
  readonly columns: string[];
  readonly values: unknown[];
}

async function planInsert(
  sql: Sql,
  table: string,
  columnInfo: readonly ColumnInfo[],
  fks: readonly { column: string; foreignTable: string }[],
  options: {
    readonly organisationId: string | null;
    readonly userId: string;
    readonly permission: string;
    readonly parents: ReadonlyMap<string, string>;
    readonly selfId: string | null;
    readonly marker: boolean;
  },
): Promise<InsertPlan> {
  const columns: string[] = [];
  const values: unknown[] = [];
  const fkByColumn = new Map(fks.map((fk) => [fk.column, fk.foreignTable]));
  const rowKey = randomUUID();

  for (const column of columnInfo) {
    const foreignTable = fkByColumn.get(column.name);
    let value: unknown;
    let include = false;

    if (column.name === 'id' && column.dataType === 'uuid') {
      value = randomUUID();
      include = true;
    } else if (column.name === 'organisation_id') {
      value = options.organisationId;
      include = true;
    } else if (foreignTable === 'organisations') {
      value = options.organisationId;
      include = options.organisationId !== null;
    } else if (foreignTable === 'users') {
      value = options.userId;
      include = !column.nullable;
    } else if (foreignTable === 'permissions') {
      value = options.permission;
      include = !column.nullable;
    } else if (foreignTable && foreignTable !== table) {
      value = options.parents.get(foreignTable);
      if (value === undefined && !column.nullable) {
        throw new Error(`No parent id for ${table}.${column.name} -> ${foreignTable}.`);
      }
      include = value !== undefined && !column.nullable;
    } else if (foreignTable === table) {
      value = options.selfId;
      include = options.selfId !== null && !column.nullable;
      if (!include && !column.nullable && !column.hasDefault && options.selfId === null) {
        throw new Error(`${table}.${column.name} is a not-null self reference.`);
      }
    } else if (column.hasDefault || column.nullable) {
      include = false;
    } else if (
      column.dataType === 'text' ||
      column.dataType === 'character varying' ||
      column.udtName === 'citext'
    ) {
      value = options.marker
        ? `${TENANT_MARKER}:${table}:${column.name}:${rowKey}`
        : `fixture:${table}:${column.name}:${rowKey}`;
      include = true;
    } else if (column.dataType === 'uuid') {
      value = randomUUID();
      include = true;
    } else if (column.dataType === 'boolean') {
      value = false;
      include = true;
    } else if (
      column.dataType === 'integer' ||
      column.dataType === 'bigint' ||
      column.dataType === 'smallint' ||
      column.dataType === 'numeric' ||
      column.dataType === 'real' ||
      column.dataType === 'double precision'
    ) {
      value = 0;
      include = true;
    } else if (column.dataType.startsWith('timestamp') || column.dataType === 'date') {
      value = '2026-01-15T00:00:00.000Z';
      include = true;
    } else if (column.dataType === 'jsonb' || column.dataType === 'json') {
      value = '{}';
      include = true;
    } else if (column.dataType === 'ARRAY') {
      value = '{}';
      include = true;
    } else if (column.dataType === 'bytea') {
      value = Buffer.from([0]);
      include = true;
    } else if (column.dataType === 'USER-DEFINED') {
      value = await enumLabel(sql, column.udtName);
      include = true;
    } else {
      throw new Error(`Unsupported column ${table}.${column.name} (${column.dataType}).`);
    }

    if (!include) continue;
    columns.push(column.name);
    values.push(value);
  }

  return { columns, values };
}

async function insertRow(sql: Sql, table: string, plan: InsertPlan): Promise<string> {
  const names = plan.columns.map(quoteIdent).join(', ');
  const params = plan.values.map((_, index) => `$${index + 1}`).join(', ');
  const result = await sql.unsafe(
    `insert into ${quoteIdent(table)} (${names}) values (${params}) returning id`,
    plan.values,
  );
  const id = rowsOf(result)[0]?.id;
  if (typeof id !== 'string' || !id) {
    throw new Error(`Insert into ${table} did not return an id.`);
  }
  return id;
}

async function insertLabeled(
  sql: Sql,
  label: string,
  table: string,
  meta: { columns: ColumnInfo[]; fks: Array<{ column: string; foreignTable: string }> },
  options: {
    readonly organisationId: string | null;
    readonly userId: string;
    readonly permission: string;
    readonly parents: ReadonlyMap<string, string>;
    readonly selfId: string | null;
    readonly marker: boolean;
  },
): Promise<string> {
  try {
    return await insertRow(
      sql,
      table,
      await planInsert(sql, table, meta.columns, meta.fks, options),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Insert ${label} failed: ${message}`);
  }
}

/**
 * Insert one org-A row and one org-B row into every tenant table, plus a
 * null-organisation row where the column is nullable (platform defaults / chain).
 * Runs as the migrator (superuser), which bypasses RLS. Returns table names.
 */
export interface SeedResult {
  readonly tables: readonly string[];
  readonly orgAIds: Readonly<Record<string, string>>;
  readonly orgBIds: Readonly<Record<string, string>>;
}

export async function seedTenantRows(sql: Sql, ids: IsolationIds): Promise<SeedResult> {
  await sql.unsafe(
    `insert into users (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [ids.userId, 'RLS Fixture User', `rls-${ids.userId}@example.test`],
  );
  await sql.unsafe(
    `insert into organisations (id, legal_name, slug, status)
     values ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
    [
      ids.orgA,
      'RLS Organisation A',
      `rls-a-${ids.orgA.slice(0, 8)}`,
      ids.orgB,
      `${TENANT_MARKER} Organisation B`,
      `rls-b-${ids.orgB.slice(0, 8)}`,
    ],
  );

  const permission = await permissionKey(sql);
  const tables = await tenantTableNames(sql);
  const info = new Map<
    string,
    { columns: ColumnInfo[]; fks: Array<{ column: string; foreignTable: string }> }
  >();
  for (const table of tables) {
    info.set(table, {
      columns: await columnsOf(sql, table),
      fks: await foreignKeys(sql, table),
    });
  }
  const dependencies = new Map<string, string[]>();
  for (const table of tables) {
    const deps = new Set<string>();
    for (const fk of info.get(table)?.fks ?? []) {
      const column = info.get(table)?.columns.find((item) => item.name === fk.column);
      if (column && !column.nullable) deps.add(fk.foreignTable);
    }
    dependencies.set(table, [...deps]);
  }

  const parentsA = new Map<string, string>();
  const parentsB = new Map<string, string>();
  const orgAIds: Record<string, string> = {};
  const orgBIds: Record<string, string> = {};
  for (const table of orderTables(tables, dependencies)) {
    const meta = info.get(table);
    if (!meta) throw new Error(`Missing column metadata for ${table}.`);
    const idB = await insertLabeled(sql, `${table} org B`, table, meta, {
      organisationId: ids.orgB,
      userId: ids.userId,
      permission,
      parents: parentsB,
      selfId: null,
      marker: true,
    });
    orgBIds[table] = idB;
    parentsB.set(table, idB);
    const idA = await insertLabeled(sql, `${table} org A`, table, meta, {
      organisationId: ids.orgA,
      userId: ids.userId,
      permission,
      parents: parentsA,
      selfId: null,
      marker: false,
    });
    orgAIds[table] = idA;
    parentsA.set(table, idA);

    const orgColumn = meta.columns.find((column) => column.name === 'organisation_id');
    // System roles are the null-org catalogue. The development seed owns that
    // set, and seed.test.ts asserts it exactly. Those rows already satisfy the
    // shared-read check, so this fixture must not add another null role.
    if (orgColumn?.nullable && table !== 'roles') {
      await insertLabeled(sql, `${table} (null org)`, table, meta, {
        organisationId: null,
        userId: ids.userId,
        permission,
        parents: parentsA,
        selfId: null,
        marker: false,
      });
    }
  }

  return { tables, orgAIds, orgBIds };
}

/** Stable digest of every org-B row. Used to detect cross-tenant writes. */
export async function snapshotOrganisation(
  sql: Sql,
  tables: readonly string[],
  organisationId: string,
): Promise<string> {
  if (tables.length === 0) return '';
  const branches = tables.map((table) => {
    const quoted = quoteIdent(table);
    return `select '${table}' as table_name, count(*)::text as n, coalesce(md5(string_agg(row_to_json(x)::text, '|' order by row_to_json(x)::text)), '') as digest from ${quoted} x where x.organisation_id = $1`;
  });
  const result = await sql.unsafe(branches.join(' union all '), [organisationId]);
  return rowsOf(result)
    .map((row) => `${String(row.table_name)}:${String(row.n)}:${String(row.digest)}`)
    .sort()
    .join('\n');
}
