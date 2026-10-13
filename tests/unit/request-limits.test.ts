import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetEnvCache } from '@/lib/env';
import { clientIp, UNKNOWN_CLIENT_IP } from '@/lib/http/client-ip';
import {
  createMemoryCounterStore,
  getCounterStore,
  setCounterStore,
  type CounterStore,
  type MemoryCounterStore,
} from '@/lib/http/counter-store';
import {
  AUTH_LIMITS,
  REQUEST_LIMITS,
  counterKey,
  enforcePair,
  hashIdentity,
  limitIp,
  limitKey,
  limitSubject,
} from '@/lib/http/request-limits';
import { createAuthRateLimitStorage } from '@/lib/auth/rate-limit-storage';

function memory(): MemoryCounterStore {
  const store = createMemoryCounterStore();
  setCounterStore(store);
  return store;
}

afterEach(() => {
  setCounterStore(undefined);
  vi.unstubAllEnvs();
  __resetEnvCache();
});

describe('client address', () => {
  it('uses a single cf-connecting-ip and ignores forwarded lists', () => {
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.8',
      'x-forwarded-for': '198.51.100.2, 10.0.0.1',
      'x-real-ip': '198.51.100.9',
    });
    expect(clientIp(headers)).toBe('203.0.113.8');
  });

  it('rejects a multi-value cf-connecting-ip', () => {
    expect(
      clientIp(new Headers({ 'cf-connecting-ip': '203.0.113.8, 198.51.100.2' })),
    ).toBe(UNKNOWN_CLIENT_IP);
  });

  it('accepts one x-real-ip outside production and ignores it in production', () => {
    const headers = new Headers({ 'x-real-ip': '203.0.113.9' });
    expect(clientIp(headers)).toBe('203.0.113.9');
    vi.stubEnv('NODE_ENV', 'production');
    __resetEnvCache();
    expect(clientIp(headers)).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp(new Headers({ 'cf-connecting-ip': '2001:db8::1' }))).toBe(
      '2001:db8::1',
    );
  });
});

describe('shared request limits', () => {
  it('limits two addresses independently and keeps the count across replicas', async () => {
    const backing = new Map();
    const replicaA = createMemoryCounterStore(backing);
    const replicaB = createMemoryCounterStore(backing);
    const policy = REQUEST_LIMITS.createAccount;

    setCounterStore(replicaA);
    for (let i = 0; i < policy.ipMax; i += 1) {
      expect(await limitIp(policy, '203.0.113.1')).toBeNull();
    }
    setCounterStore(replicaB);
    const blocked = await limitIp(policy, '203.0.113.1');
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get('Retry-After')).toBeTruthy();
    expect(blocked?.headers.get('X-Retry-After')).toBe(
      blocked?.headers.get('Retry-After'),
    );
    expect(await limitIp(policy, '203.0.113.2')).toBeNull();
  });

  it('limits a token separately from the address and stores only the hash', async () => {
    const store = memory();
    const policy = REQUEST_LIMITS.publicFormPost;
    const token = 'form-token-raw-value';
    await store.set(
      counterKey(policy.scope, 'token', hashIdentity(token)),
      policy.subjectMax,
      policy.windowSec,
    );

    const blocked = await enforcePair(policy, '203.0.113.3', token);
    expect(blocked?.status).toBe(429);
    expect(await enforcePair(policy, '203.0.113.3', 'other-form-token')).toBeNull();
    expect(store.keys().join(' ')).not.toContain(token);
    expect(store.keys().some((key) => key.includes(hashIdentity(token)))).toBe(true);
  });

  it('keys an API key by its id, not the bearer secret', async () => {
    const store = memory();
    const policy = REQUEST_LIMITS.api;
    const raw = 'bp_secret_key_a_0123456789';
    await store.set(
      counterKey(policy.scope, 'key', 'key-a'),
      policy.subjectMax,
      policy.windowSec,
    );

    const blocked = await limitKey(policy, 'key-a');
    expect(blocked?.status).toBe(429);
    expect(await limitKey(policy, 'key-b')).toBeNull();
    const joined = store.keys().join(' ');
    expect(joined).not.toContain(raw);
    expect(joined).toContain('key-a');
    expect(joined).toContain(policy.scope);
  });

  it('fails closed when the store throws', async () => {
    const broken: CounterStore = {
      async increment() {
        throw new Error('down');
      },
      async get() {
        throw new Error('down');
      },
      async set() {
        throw new Error('down');
      },
      async delete() {
        throw new Error('down');
      },
    };
    setCounterStore(broken);
    const response = await limitSubject(REQUEST_LIMITS.scim, 'bearer-secret');
    expect(response?.status).toBe(429);
    expect(getCounterStore()).toBe(broken);
  });

  it('publishes the auth windows used by the auth config', () => {
    expect(AUTH_LIMITS.signInEmail).toEqual({ window: 60, max: 5 });
    expect(AUTH_LIMITS.requestPasswordReset).toEqual({ window: 60, max: 3 });
    expect(AUTH_LIMITS.forgetPassword.max).toBe(AUTH_LIMITS.requestPasswordReset.max);
  });
});

describe('auth rate limit storage', () => {
  it('counts each address on its own and shares that count across replicas', async () => {
    const backing = new Map();
    setCounterStore(createMemoryCounterStore(backing));
    const first = createAuthRateLimitStorage();
    const rule = {
      window: AUTH_LIMITS.signInEmail.window,
      max: AUTH_LIMITS.signInEmail.max,
    };
    const alice = '203.0.113.1|/sign-in/email';
    const bob = '203.0.113.2|/sign-in/email';

    for (let i = 0; i < rule.max; i += 1) {
      expect(await first.consume(alice, rule)).toEqual({
        allowed: true,
        retryAfter: null,
      });
    }
    setCounterStore(createMemoryCounterStore(backing));
    const second = createAuthRateLimitStorage();
    const blocked = await second.consume(alice, rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(await second.consume(bob, rule)).toEqual({ allowed: true, retryAfter: null });
  });

  it('denies when the store throws', async () => {
    setCounterStore({
      async increment() {
        throw new Error('down');
      },
      async get() {
        throw new Error('down');
      },
      async set() {
        throw new Error('down');
      },
      async delete() {
        throw new Error('down');
      },
    });
    const storage = createAuthRateLimitStorage();
    await expect(
      storage.consume('203.0.113.1|/sign-in/email', { window: 60, max: 5 }),
    ).resolves.toEqual({
      allowed: false,
      retryAfter: 60,
    });
  });
});
