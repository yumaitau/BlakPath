import { AsyncLocalStorage } from 'node:async_hooks';
import { db, type Database } from './client';
import { applyRlsRole, APP_ROLE, PLATFORM_ROLE } from './rls';

/**
 * Drizzle transaction handle. Same query surface as `Database` minus the
 * pool-level session, which is what tenant code already uses.
 */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

type Binding = {
  tx: Tx;
  role: string;
  organisationId: string | null;
};

const bindings = new AsyncLocalStorage<Binding>();

async function restoreBinding(current: Binding): Promise<void> {
  try {
    await applyRlsRole(current.tx, current.role, current.organisationId);
  } catch {
    // The outer transaction has already ended, so the local settings are gone.
  }
}

type Step =
  | { readonly kind: 'get'; readonly prop: PropertyKey }
  | { readonly kind: 'apply'; readonly args: readonly unknown[] };

async function inRole<T>(
  role: string,
  organisationId: string | null,
  fn: (tx: Tx) => Promise<T>,
  config?: Parameters<Database['transaction']>[1],
): Promise<T> {
  const current = bindings.getStore();
  if (current && current.role === role && current.organisationId === organisationId) {
    return fn(current.tx);
  }
  if (current) {
    // SET LOCAL inside a released savepoint sticks to the outer transaction.
    // Put the caller's role and org back before the outer work continues.
    try {
      return await current.tx.transaction(async (inner) => {
        await applyRlsRole(inner, role, organisationId);
        const next: Binding = { tx: inner, role, organisationId };
        return await bindings.run(next, () => fn(inner));
      });
    } finally {
      await restoreBinding(current);
    }
  }
  return db.transaction(async (tx) => {
    await applyRlsRole(tx, role, organisationId);
    const next: Binding = { tx, role, organisationId };
    return bindings.run(next, () => fn(tx));
  }, config);
}

async function replay(
  role: string,
  organisationId: string | null,
  steps: readonly Step[],
) {
  return inRole(role, organisationId, async (tx) => {
    let current: unknown = tx;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step || step.kind !== 'get') {
        throw new Error('Tenant database wrapper recorded an unexpected call.');
      }
      const parent = current as Record<PropertyKey, unknown>;
      const value = parent[step.prop];
      const next = steps[index + 1];
      if (next?.kind === 'apply') {
        index += 1;
        if (typeof value !== 'function') {
          throw new Error(`Tenant database wrapper cannot call "${String(step.prop)}".`);
        }
        current = value.apply(parent, next.args);
      } else {
        current = value;
      }
    }
    if (
      current !== null &&
      (typeof current === 'object' || typeof current === 'function') &&
      'then' in (current as object)
    ) {
      return await (current as Promise<unknown>);
    }
    return current;
  });
}

/**
 * Query surface bound to one role and, for the app role, one organisation.
 * Builders are recorded and replayed inside a transaction that has already
 * run SET LOCAL, so `await scope.db.select()...` keeps its existing shape.
 */
function bind(role: string, organisationId: string | null): Database {
  function recorder(steps: readonly Step[]): unknown {
    const call = (...args: unknown[]) => recorder([...steps, { kind: 'apply', args }]);
    return new Proxy(call, {
      get(_target, prop) {
        if (prop === 'then' && steps.length > 0) {
          return (
            resolve: (value: unknown) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => replay(role, organisationId, steps).then(resolve, reject);
        }
        if (prop === 'catch' && steps.length > 0) {
          return (reject: (reason: unknown) => unknown) =>
            replay(role, organisationId, steps).catch(reject);
        }
        if (prop === 'finally' && steps.length > 0) {
          return (fin: () => void) => replay(role, organisationId, steps).finally(fin);
        }
        if (prop === 'transaction' && steps.length === 0) {
          return (
            callback: (tx: Tx) => Promise<unknown>,
            config?: Parameters<Database['transaction']>[1],
          ) => inRole(role, organisationId, (tx) => callback(tx), config);
        }
        if (
          prop === 'apply' ||
          prop === 'call' ||
          prop === 'bind' ||
          prop === 'length' ||
          prop === 'name'
        ) {
          return Reflect.get(call, prop);
        }
        return recorder([...steps, { kind: 'get', prop }]);
      },
      apply(_target, _thisArg, args) {
        return recorder([...steps, { kind: 'apply', args }]);
      },
    });
  }
  return recorder([]) as Database;
}

/** Tenant work. RLS policies see only this organisation. */
export function tenantBoundDb(organisationId: string): Database {
  return bind(APP_ROLE, organisationId);
}

/**
 * Pre-tenant work that must see rows before an organisation is chosen
 * (membership resolution, token lookup, public verification). BYPASSRLS.
 */
export function platformBoundDb(): Database {
  return bind(PLATFORM_ROLE, null);
}
