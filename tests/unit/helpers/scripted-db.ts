import { vi } from 'vitest';

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
  reset() {
    this.results.length = 0;
    this.ops.length = 0;
    this.writes.length = 0;
    this.wheres.length = 0;
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
    // The transaction handle is the same scripted surface. Throwing inside
    // the callback rejects, as a rolled-back transaction would.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db;
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
