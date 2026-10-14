import { getCounterStore } from '@/lib/http/counter-store';
import { platformKey } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/**
 * Better Auth rate-limit storage.
 *
 * `customStorage.consume` is the atomic path. This is not `secondaryStorage`:
 * that switch makes Better Auth read sessions and verification tokens from
 * Redis and skip the Postgres row that holds `activeOrganisationId` and
 * two-factor state. Limits alone live here.
 *
 * A store error denies the request. The log line has no key and no address.
 */

function storageKey(key: string): string {
  return platformKey('auth', 'ba', key);
}

export function createAuthRateLimitStorage() {
  return {
    async get(key: string) {
      const value = await getCounterStore().get(storageKey(key));
      if (!value) return null;
      return { key, count: value.count, lastRequest: Date.now() };
    },
    async set(key: string, value: { count: number }) {
      await getCounterStore().set(storageKey(key), value.count, 60);
    },
    async consume(key: string, rule: { window: number; max: number }) {
      try {
        const { count, ttlSec } = await getCounterStore().increment(
          storageKey(key),
          rule.window,
        );
        if (count <= rule.max) return { allowed: true as const, retryAfter: null };
        return { allowed: false as const, retryAfter: Math.max(1, ttlSec) };
      } catch (err) {
        logger.error({ err, scope: 'auth' }, 'auth rate limit store unavailable');
        return { allowed: false as const, retryAfter: rule.window };
      }
    },
  };
}
