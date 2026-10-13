import { describe, expect, it, vi } from 'vitest';
import { applyRlsRole, APP_ROLE } from '@/db/rls';

const ORG = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  executed: 0,
  queries: [] as string[],
}));

vi.mock('@/db/client', () => {
  function chain() {
    const builder: Record<string, unknown> = {};
    const passthrough = () => builder;
    for (const method of ['from', 'where', 'limit', 'orderBy']) {
      builder[method] = passthrough;
    }
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve([{ ok: true }]).then(resolve);
    return builder;
  }
  const tx = {
    execute: async () => {
      state.executed += 1;
      return [];
    },
    select: () => {
      state.queries.push('select');
      return chain();
    },
  };
  return {
    db: {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

describe('tenant database role', () => {
  it('refuses an unknown role and an app role without an organisation', async () => {
    const tx = { execute: async () => undefined };
    await expect(applyRlsRole(tx, 'postgres', ORG)).rejects.toThrow(
      /unknown database role/,
    );
    await expect(applyRlsRole(tx, APP_ROLE, null)).rejects.toThrow(/organisation id/);
  });

  it('sets the role and the org GUC', async () => {
    const queries: string[] = [];
    await applyRlsRole(
      {
        execute: async (query) => {
          queries.push(JSON.stringify(query));
        },
      },
      APP_ROLE,
      ORG,
    );
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain(APP_ROLE);
    expect(queries[1]).toContain('app.org_id');
    expect(queries[1]).toContain(ORG);
  });

  it('replays scope.db.select inside the role transaction', async () => {
    state.executed = 0;
    state.queries = [];
    const { tenantBoundDb } = await import('@/db/bound-db');
    const bound = tenantBoundDb(ORG);
    const rows = await bound.select().from({} as never);
    expect(rows).toEqual([{ ok: true }]);
    expect(state.queries).toEqual(['select']);
    expect(state.executed).toBe(2);
  });
});
