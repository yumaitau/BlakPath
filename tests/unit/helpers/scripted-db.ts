import { expect, vi } from 'vitest';

/** Transaction handles whose callback is still running. */
const openTransactions = new Set<unknown>();

/**
 * In-memory stand-in for the Drizzle chains domain services await.
 * Each terminal (`limit`, `returning`, or awaiting the builder) consumes one
 * queued result, in call order. Inserts and updates that ignore their result
 * still consume a slot — queue `[]` for those.
 */
export const script = {
  results: [] as unknown[],
  ops: [] as string[],
  writes: [] as { op: 'values' | 'set'; payload: unknown }[],
  wheres: [] as unknown[],
  /** Audit writes seen by `trackAudit`, with the transaction state at call time. */
  audits: [] as {
    action: string;
    result: unknown;
    tx: unknown;
    inTransaction: boolean;
  }[],
  reset() {
    this.results.length = 0;
    this.ops.length = 0;
    this.writes.length = 0;
    this.wheres.length = 0;
    this.audits.length = 0;
    openTransactions.clear();
  },
  take() {
    return this.results.shift() ?? [];
  },
};

function chain(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const method of [
    'from',
    'where',
    'orderBy',
    'innerJoin',
    'leftJoin',
    'onConflictDoNothing',
  ]) {
    builder[method] = passthrough;
  }
  builder.values = (payload: unknown) => {
    script.writes.push({ op: 'values', payload });
    return builder;
  };
  builder.set = (payload: unknown) => {
    script.writes.push({ op: 'set', payload });
    return builder;
  };
  builder.limit = () => Promise.resolve(script.take());
  builder.returning = () => Promise.resolve(script.take());
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(script.take()).then(resolve, reject);
  return builder;
}

export function scriptedDatabase() {
  const db: Record<string, unknown> = {
    select: () => {
      script.ops.push('select');
      return chain();
    },
    insert: () => {
      script.ops.push('insert');
      return chain();
    },
    update: () => {
      script.ops.push('update');
      return chain();
    },
    delete: () => {
      script.ops.push('delete');
      return chain();
    },
    // Each transaction gets its own handle over the same scripted surface, so
    // a test can tell whether an audit write was handed the open transaction.
    // Throwing inside the callback rejects, as a rolled-back transaction would.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = { ...db };
      openTransactions.add(tx);
      try {
        return await fn(tx);
      } finally {
        openTransactions.delete(tx);
      }
    },
  };
  return db;
}

/**
 * Make a `recordAudit` spy note whether its `tx` argument was a transaction
 * that was still open at call time. Call after any `mockReset`.
 */
export function trackAudit(spy: {
  mockImplementation: (
    fn: (input: unknown, tx?: unknown) => Promise<undefined>,
  ) => unknown;
}): void {
  spy.mockImplementation(async (input: unknown, tx?: unknown) => {
    const { action, result } = input as { action: string; result: unknown };
    script.audits.push({
      action,
      result,
      tx,
      inTransaction: tx !== undefined && openTransactions.has(tx),
    });
    return undefined;
  });
}

/** Assert `action` was audited through the transaction that made the write. */
export function expectAuditedInTransaction(action: string): void {
  const entry = script.audits.find((audit) => audit.action === action);
  expect(entry, `no audit for ${action}`).toBeDefined();
  expect(entry?.inTransaction, `${action} audited outside its transaction`).toBe(true);
}

/** Tenant-scope module shape used by `vi.mock('@/db/tenant-db')`. */
export function scriptedTenantModule(organisationId: string) {
  const db = scriptedDatabase();
  const scopeFor = vi.fn((org: string) => ({ organisationId: org, db }));
  return {
    scopeFor,
    currentScope: () => ({
      organisationId,
      db,
      where: (...args: unknown[]) => {
        script.wheres.push(args[0]);
        return {};
      },
      assertOwned<T extends { organisationId: string }>(
        row: T | undefined,
      ): T | undefined {
        if (row && row.organisationId !== organisationId) {
          throw new Error('Row does not belong to the active tenant scope.');
        }
        return row;
      },
      insertValues<T extends Record<string, unknown>>(
        values: T,
      ): T & { organisationId: string } {
        return { ...values, organisationId };
      },
    }),
  };
}
