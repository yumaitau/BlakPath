import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryCounterStore,
  setCounterStore,
  type CounterStore,
  type MemoryCounterStore,
} from '@/lib/http/counter-store';
import { REVOKE_SESSIONS_ON_PASSWORD_RESET } from '@/lib/auth/session-policy';
import {
  SIGN_IN_GUARD,
  decideSignIn,
  delayMsForFailures,
  guardSignIn,
  noteSignInResult,
  signInOutcome,
  SignInLockedError,
} from '@/lib/auth/sign-in-guard';

function memory(): MemoryCounterStore {
  const store = createMemoryCounterStore();
  setCounterStore(store);
  return store;
}

afterEach(() => {
  setCounterStore(undefined);
});

describe('sign-in account guard', () => {
  it('delays then locks one account after 10 failures from any address', async () => {
    const store = memory();
    const email = 'Ada@Example.com';
    const delays: number[] = [];

    for (let prior = 0; prior < SIGN_IN_GUARD.lockAfter; prior += 1) {
      const decision = await decideSignIn(email);
      expect(decision.action).toBe('allow');
      if (decision.action === 'allow') {
        expect(decision.delayMs).toBe(delayMsForFailures(prior));
        delays.push(decision.delayMs);
      }
      await noteSignInResult(`  ${email}  `, 'failure');
    }

    expect(delays.filter((ms) => ms === 0)).toHaveLength(SIGN_IN_GUARD.mildAfter);
    expect(delays.filter((ms) => ms === SIGN_IN_GUARD.mildDelayMs)).toHaveLength(
      SIGN_IN_GUARD.strongAfter - SIGN_IN_GUARD.mildAfter,
    );
    expect(delays.filter((ms) => ms === SIGN_IN_GUARD.strongDelayMs)).toHaveLength(
      SIGN_IN_GUARD.lockAfter - SIGN_IN_GUARD.strongAfter,
    );

    const locked = await decideSignIn('ada@example.com');
    expect(locked).toEqual({ action: 'lock', retryAfter: SIGN_IN_GUARD.lockSec });
    await expect(
      guardSignIn('ada@example.com', async () => undefined),
    ).rejects.toBeInstanceOf(SignInLockedError);

    const other = await decideSignIn('other@example.com');
    expect(other).toEqual({ action: 'allow', delayMs: 0 });

    const joined = store.keys().join(' ');
    expect(joined).not.toContain('ada@example.com');
    expect(joined).not.toContain('203.0.113.');
    expect(joined).not.toContain('.');

    for (const key of store.keys()) {
      if (key.includes(':sign-in:')) await store.delete(key);
    }
    expect((await decideSignIn(email)).action).toBe('lock');
  });

  it('clears the counter after a successful sign-in', async () => {
    memory();
    for (let i = 0; i < SIGN_IN_GUARD.mildAfter; i += 1) {
      await noteSignInResult('ada@example.com', 'failure');
    }
    const delayed = await decideSignIn('ada@example.com');
    expect(delayed).toEqual({ action: 'allow', delayMs: SIGN_IN_GUARD.mildDelayMs });
    await noteSignInResult('ada@example.com', 'clear');
    expect(await decideSignIn('ada@example.com')).toEqual({
      action: 'allow',
      delayMs: 0,
    });
  });

  it('locks when the store cannot be read and ignores a failed write', async () => {
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
    expect(await decideSignIn('ada@example.com')).toMatchObject({ action: 'lock' });
    await expect(noteSignInResult('ada@example.com', 'failure')).resolves.toBeUndefined();
  });

  it('counts only a 401 and clears a correct password', () => {
    expect(
      signInOutcome({ name: 'APIError', status: 'UNAUTHORIZED', statusCode: 401 }),
    ).toBe('failure');
    expect(
      signInOutcome({ name: 'APIError', status: 'FORBIDDEN', statusCode: 403 }),
    ).toBe('clear');
    expect(signInOutcome({ twoFactorRedirect: true })).toBe('clear');
    expect(
      signInOutcome({ name: 'APIError', status: 'TOO_MANY_REQUESTS', statusCode: 429 }),
    ).toBe(null);
    expect(signInOutcome(undefined)).toBe('clear');
  });
});

describe('password reset session policy', () => {
  it('revokes sessions on password reset and does not cache sessions in Redis', () => {
    expect(REVOKE_SESSIONS_ON_PASSWORD_RESET).toBe(true);
    const source = readFileSync(
      new URL('../../src/lib/auth/index.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain(
      'revokeSessionsOnPasswordReset: REVOKE_SESSIONS_ON_PASSWORD_RESET',
    );
    expect(source).toContain("ipAddressHeaders: ['cf-connecting-ip']");
    expect(source).toContain('customStorage: createAuthRateLimitStorage()');
    expect(source).not.toMatch(/secondaryStorage\s*:/);
  });
});
