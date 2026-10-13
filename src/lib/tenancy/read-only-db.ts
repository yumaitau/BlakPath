import type { Database } from '@/db/client';
import { BreakGlassWriteError } from './break-glass-write';

const BLOCKED = new Set(['insert', 'update', 'delete', 'execute', 'transaction']);

/**
 * Drizzle handle that rejects writes. Reads (`select`) pass through.
 * Used as the tenant scope database while a break-glass grant is active.
 */
export function readOnlyDatabase(database: Database): Database {
  return new Proxy(database, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && BLOCKED.has(prop)) {
        return () => {
          throw new BreakGlassWriteError();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
  });
}
