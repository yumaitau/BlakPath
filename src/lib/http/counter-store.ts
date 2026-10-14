import { redis } from '@/lib/redis';

/**
 * Fixed-window counters shared by every app process.
 *
 * `INCR` plus `EXPIRE` only when the key is new (or has no TTL) is the atomic
 * step. Two replicas calling `increment` on the same key share one count.
 * Tests inject an in-memory store so unit tests never open Redis.
 */

export interface CounterValue {
  count: number;
  ttlSec: number;
}

export interface CounterStore {
  increment(key: string, ttlSec: number): Promise<CounterValue>;
  get(key: string): Promise<CounterValue | null>;
  set(key: string, count: number, ttlSec: number): Promise<void>;
  delete(key: string): Promise<void>;
}

const INCREMENT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
else
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

interface MemoryEntry {
  count: number;
  expiresAt: number;
}

export interface MemoryCounterStore extends CounterStore {
  keys(): string[];
}

export function createMemoryCounterStore(
  backing: Map<string, MemoryEntry> = new Map(),
  now: () => number = Date.now,
): MemoryCounterStore {
  const live = (key: string): MemoryEntry | null => {
    const entry = backing.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      backing.delete(key);
      return null;
    }
    return entry;
  };

  return {
    async increment(key, ttlSec) {
      const entry = live(key);
      if (!entry) {
        backing.set(key, { count: 1, expiresAt: now() + ttlSec * 1000 });
        return { count: 1, ttlSec };
      }
      entry.count += 1;
      const ttl = Math.max(1, Math.ceil((entry.expiresAt - now()) / 1000));
      return { count: entry.count, ttlSec: ttl };
    },
    async get(key) {
      const entry = live(key);
      if (!entry) return null;
      return {
        count: entry.count,
        ttlSec: Math.max(1, Math.ceil((entry.expiresAt - now()) / 1000)),
      };
    },
    async set(key, count, ttlSec) {
      backing.set(key, { count, expiresAt: now() + ttlSec * 1000 });
    },
    async delete(key) {
      backing.delete(key);
    },
    keys() {
      for (const key of [...backing.keys()]) live(key);
      return [...backing.keys()];
    },
  };
}

function createRedisCounterStore(): CounterStore {
  return {
    async increment(key, ttlSec) {
      const raw: unknown = await redis.eval(INCREMENT_LUA, 1, key, String(ttlSec));
      if (!Array.isArray(raw) || raw.length < 2) {
        throw new Error('unexpected counter reply');
      }
      const ttl = Number(raw[1]);
      return {
        count: Number(raw[0]),
        ttlSec: ttl > 0 ? ttl : ttlSec,
      };
    },
    async get(key) {
      const exec = await redis.pipeline().get(key).ttl(key).exec();
      if (!exec) return null;
      const getResult = exec[0];
      const ttlResult = exec[1];
      if (!getResult || !ttlResult) return null;
      const [getErr, raw] = getResult;
      const [ttlErr, ttlRaw] = ttlResult;
      if (getErr) throw getErr;
      if (ttlErr) throw ttlErr;
      if (raw === null || raw === undefined) return null;
      const ttl = Number(ttlRaw);
      return { count: Number(raw), ttlSec: ttl > 0 ? ttl : 0 };
    },
    async set(key, count, ttlSec) {
      await redis.set(key, String(count), 'EX', ttlSec);
    },
    async delete(key) {
      await redis.del(key);
    },
  };
}

let override: CounterStore | undefined;
let redisStore: CounterStore | undefined;

/** Tests call this with `createMemoryCounterStore()`. Pass undefined to restore Redis. */
export function setCounterStore(store: CounterStore | undefined): void {
  override = store;
}

export function getCounterStore(): CounterStore {
  if (override) return override;
  redisStore ??= createRedisCounterStore();
  return redisStore;
}
