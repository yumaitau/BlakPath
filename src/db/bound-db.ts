import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { schema, sqlClient, type Database } from './client';
import {
  applyRlsContext,
  PLATFORM_CONTEXT,
  rlsSettings,
  sameRlsContext,
  tenantContext,
  type RlsContext,
} from './rls';

/**
 * Database handles bound to a row-level security context.
 *
 * A bound handle is a real Drizzle database, so builders, subqueries and
 * relational queries behave as usual. Only execution differs: the handle's
 * client runs each statement inside its own transaction that first applies
 * the context (`SET LOCAL` of `app.org_id`, `app.bypass_rls` and role), and
 * `handle.transaction(fn)` applies it once at the start of the transaction.
 *
 * Transaction boundaries are the same as on the raw pool: a bound handle
 * never joins a transaction it was not given. Work that must be atomic with a
 * caller's transaction uses that `tx`. When such work needs another context
 * (e.g. a platform-chain audit row from a tenant transaction) it goes through
 * `withRlsContextOn(tx, ...)`, which switches in a savepoint and restores.
 */

type TxSql = postgres.TransactionSql;

/** A Drizzle transaction handle (top level or savepoint). */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Context applied to each open bound transaction, keyed by its connection. */
const transactionContexts = new WeakMap<object, RlsContext>();

type Box<T> = { value: T };

/**
 * postgres.js resolves an array returned from `begin` with `Promise.all`,
 * which strips `count` from a result list. Box the value through it.
 */
async function inContext<T>(
  context: RlsContext,
  work: (sql: TxSql) => Promise<T>,
): Promise<T> {
  const boxed = (await sqlClient.begin(async (tx) => {
    await applyRlsContext(tx, context);
    transactionContexts.set(tx, context);
    return { value: await work(tx) };
  })) as unknown as Box<T>;
  return boxed.value;
}

type UnsafeParameters = Parameters<postgres.Sql['unsafe']>[1];

/**
 * The subset of the postgres.js client Drizzle's session calls: `unsafe`
 * (awaited, or `.values()`), `begin` for `db.transaction`, and `options`.
 */
function boundClient(context: RlsContext): postgres.Sql {
  const client = {
    options: sqlClient.options,
    unsafe(query: string, parameters?: UnsafeParameters) {
      const run = (values: boolean) =>
        inContext(context, async (tx) =>
          values
            ? await tx.unsafe(query, parameters).values()
            : await tx.unsafe(query, parameters),
        );
      return {
        values: () => run(true),
        then<A, B>(
          resolve?: ((value: unknown) => A | PromiseLike<A>) | null,
          reject?: ((reason: unknown) => B | PromiseLike<B>) | null,
        ) {
          return run(false).then(resolve, reject);
        },
      };
    },
    begin(callback: (sql: TxSql) => unknown) {
      return inContext(context, async (tx) => {
        const result = await callback(tx);
        return Array.isArray(result) ? Promise.all(result) : result;
      });
    },
  };
  return client as unknown as postgres.Sql;
}

function bind(context: RlsContext): Database {
  return drizzle(boundClient(context), { schema, casing: 'snake_case' }) as Database;
}

const tenantHandles = new Map<string, Database>();
const MAX_CACHED_TENANT_HANDLES = 500;

/** Tenant work. RLS shows and accepts only this organisation's rows. */
export function tenantBoundDb(organisationId: string): Database {
  const cached = tenantHandles.get(organisationId);
  if (cached) return cached;
  const handle = bind(tenantContext(organisationId));
  if (tenantHandles.size >= MAX_CACHED_TENANT_HANDLES) tenantHandles.clear();
  tenantHandles.set(organisationId, handle);
  return handle;
}

let platformHandle: Database | undefined;

/**
 * Explicit RLS bypass. Only `src/db/platform-db.ts` exports it; ESLint limits
 * who may import that module.
 */
export function platformBoundDb(): Database {
  platformHandle ??= bind(PLATFORM_CONTEXT);
  return platformHandle;
}

function connectionOf(tx: DbTransaction): object | undefined {
  return (tx as unknown as { session?: { client?: object } }).session?.client;
}

/** Context of a transaction opened by a bound handle; undefined for the raw pool. */
export function transactionRlsContext(tx: DbTransaction): RlsContext | undefined {
  const connection = connectionOf(tx);
  return connection ? transactionContexts.get(connection) : undefined;
}

function settingsSql(context: RlsContext) {
  const settings = rlsSettings(context);
  return sql`select set_config('app.org_id', ${settings.organisationId}, true), set_config('app.bypass_rls', ${settings.bypass}, true), case when to_regrole(${settings.role}) is not null and pg_has_role(current_user, to_regrole(${settings.role}), 'MEMBER') then set_config('role', ${settings.role}, true) end`;
}

const RESET_SQL = sql.raw(
  `select set_config('app.org_id', '', true), set_config('app.bypass_rls', 'off', true), set_config('role', 'none', true)`,
);

/**
 * Run `work` inside the caller's transaction `tx` under `context`.
 *
 * Same context, or a platform transaction (which may write anything): runs
 * directly. Otherwise a savepoint applies `context`, and afterwards the
 * caller's context is restored (or cleared for a raw-pool transaction),
 * because `SET LOCAL` from a released savepoint sticks to the transaction.
 */
export async function withRlsContextOn<T>(
  tx: DbTransaction,
  context: RlsContext,
  work: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const current = transactionRlsContext(tx);
  if (current && (current.kind === 'platform' || sameRlsContext(current, context))) {
    return work(tx);
  }
  try {
    return await tx.transaction(async (savepoint) => {
      await savepoint.execute(settingsSql(context));
      const connection = connectionOf(savepoint);
      if (connection) transactionContexts.set(connection, context);
      return work(savepoint);
    });
  } finally {
    await tx.execute(current ? settingsSql(current) : RESET_SQL).catch(() => undefined);
  }
}
