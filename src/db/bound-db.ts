import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { schema, sqlClient, type Database } from './client';
import {
  applyRlsContext,
  PLATFORM_CONTEXT,
  sameRlsContext,
  tenantContext,
  type RlsContext,
} from './rls';

/**
 * Database handles bound to a row-level security context.
 *
 * A bound handle is a real Drizzle database, so builders, subqueries and
 * relational queries behave as usual. Only execution differs: the handle's
 * client runs each statement inside a transaction that first applies the
 * context (`SET LOCAL` role, `app.org_id`, `app.bypass_rls`).
 *
 * Inside a bound transaction, every bound handle with the same context reuses
 * that transaction. A different context runs in a savepoint and the outer
 * context is put back afterwards. So a caller transaction (`scope.db.transaction`)
 * stays one transaction even when a helper reaches for `currentScope().db`.
 * Do not run two contexts concurrently (`Promise.all`) inside one transaction:
 * they share one connection and one set of settings.
 */

type TxSql = postgres.TransactionSql;

interface Binding {
  readonly sql: TxSql;
  readonly context: RlsContext;
  active: boolean;
}

const bindings = new AsyncLocalStorage<Binding>();

/** The open bound transaction for this async call chain, if any. */
function currentBinding(): Binding | undefined {
  const binding = bindings.getStore();
  // A promise that outlives its transaction (fire-and-forget) must not reuse it.
  return binding?.active ? binding : undefined;
}

async function runBound<T>(
  sql: TxSql,
  context: RlsContext,
  work: (sql: TxSql) => Promise<T>,
): Promise<T> {
  const binding: Binding = { sql, context, active: true };
  try {
    return await bindings.run(binding, () => work(sql));
  } finally {
    binding.active = false;
  }
}

/**
 * postgres.js resolves an array returned from `begin`/`savepoint` with
 * `Promise.all`, which strips `count` from a result list. Box the value.
 */
type Box<T> = { value: T };

async function withContext<T>(
  context: RlsContext,
  work: (sql: TxSql) => Promise<T>,
  options: { savepointWhenNested: boolean },
): Promise<T> {
  const current = currentBinding();
  if (current && sameRlsContext(current.context, context)) {
    if (!options.savepointWhenNested) return work(current.sql);
    const boxed = (await current.sql.savepoint(async (sp) => ({
      value: await runBound(sp, context, work),
    }))) as unknown as Box<T>;
    return boxed.value;
  }
  if (current) {
    try {
      const boxed = (await current.sql.savepoint(async (sp) => {
        await applyRlsContext(sp, context);
        return { value: await runBound(sp, context, work) };
      })) as unknown as Box<T>;
      return boxed.value;
    } finally {
      // SET LOCAL from a released savepoint sticks to the outer transaction.
      await applyRlsContext(current.sql, current.context).catch(() => undefined);
    }
  }
  const boxed = (await sqlClient.begin(async (tx) => {
    await applyRlsContext(tx, context);
    return { value: await runBound(tx, context, work) };
  })) as unknown as Box<T>;
  return boxed.value;
}

type Parameters_ = Parameters<postgres.Sql['unsafe']>[1];

/**
 * The subset of the postgres.js client Drizzle's session calls: `unsafe`
 * (awaited, or `.values()`), `begin` for `db.transaction`, and `options`.
 */
function boundClient(context: RlsContext): postgres.Sql {
  const client = {
    options: sqlClient.options,
    unsafe(query: string, parameters?: Parameters_) {
      const run = (values: boolean) =>
        withContext(
          context,
          async (sql) =>
            values
              ? await sql.unsafe(query, parameters).values()
              : await sql.unsafe(query, parameters),
          { savepointWhenNested: false },
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
      return withContext(
        context,
        async (sql) => {
          const result = await callback(sql);
          return Array.isArray(result) ? Promise.all(result) : result;
        },
        { savepointWhenNested: true },
      );
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

/** For tests: the context of the open bound transaction, if any. */
export function activeRlsContext(): RlsContext | undefined {
  return currentBinding()?.context;
}
