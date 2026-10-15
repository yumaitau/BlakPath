import { createHmac } from 'node:crypto';
import { getCounterStore } from '@/lib/http/counter-store';
import { env } from '@/lib/env';
import { platformKey } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/**
 * Per-account sign-in delay and lockout.
 *
 * The counter is an HMAC of the normalised email under `BETTER_AUTH_SECRET`.
 * It does not contain the address or the client IP, so failures from rotating
 * addresses still add up, and a lock on one account does not affect another.
 *
 * A read failure locks (fail closed). A write failure is logged and does not
 * change the HTTP result — the password check already finished.
 */

export const SIGN_IN_GUARD = {
  windowSec: 15 * 60,
  lockSec: 15 * 60,
  lockAfter: 10,
  mildAfter: 4,
  strongAfter: 7,
  mildDelayMs: 400,
  strongDelayMs: 1_200,
} as const;

export type SignInDecision =
  { action: 'allow'; delayMs: number } | { action: 'lock'; retryAfter: number };

export class SignInLockedError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super('Too many requests');
    this.name = 'SignInLockedError';
    this.retryAfter = retryAfter;
  }
}

export function delayMsForFailures(priorFailures: number): number {
  if (priorFailures >= SIGN_IN_GUARD.strongAfter) return SIGN_IN_GUARD.strongDelayMs;
  if (priorFailures >= SIGN_IN_GUARD.mildAfter) return SIGN_IN_GUARD.mildDelayMs;
  return 0;
}

function accountDigest(email: string): string {
  const normalised = email.trim().toLowerCase();
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(normalised).digest('hex');
}

function failureKey(email: string): string {
  return platformKey('auth', 'sign-in', accountDigest(email));
}

function lockKey(email: string): string {
  return platformKey('auth', 'sign-in-lock', accountDigest(email));
}

export async function decideSignIn(email: string): Promise<SignInDecision> {
  try {
    const store = getCounterStore();
    const lock = await store.get(lockKey(email));
    if (lock && lock.count > 0) {
      return { action: 'lock', retryAfter: Math.max(1, lock.ttlSec) };
    }
    const prior = (await store.get(failureKey(email)))?.count ?? 0;
    if (prior >= SIGN_IN_GUARD.lockAfter) {
      return { action: 'lock', retryAfter: SIGN_IN_GUARD.lockSec };
    }
    return { action: 'allow', delayMs: delayMsForFailures(prior) };
  } catch (err) {
    logger.error({ err, scope: 'sign-in-guard' }, 'sign-in guard unavailable');
    return { action: 'lock', retryAfter: SIGN_IN_GUARD.lockSec };
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Delay, or throw `SignInLockedError` before the password check. */
export async function guardSignIn(
  email: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  const decision = await decideSignIn(email);
  if (decision.action === 'lock') throw new SignInLockedError(decision.retryAfter);
  if (decision.delayMs > 0) await sleep(decision.delayMs);
}

/**
 * `failure` counts a 401 on `/sign-in/email`. `clear` runs after a correct
 * password (including a second-factor challenge) or a verified-email block.
 */
export async function noteSignInResult(
  email: string,
  outcome: 'failure' | 'clear',
): Promise<void> {
  try {
    const store = getCounterStore();
    if (outcome === 'clear') {
      await store.delete(failureKey(email));
      await store.delete(lockKey(email));
      return;
    }
    const { count } = await store.increment(failureKey(email), SIGN_IN_GUARD.windowSec);
    if (count >= SIGN_IN_GUARD.lockAfter) {
      await store.set(lockKey(email), 1, SIGN_IN_GUARD.lockSec);
    }
  } catch (err) {
    logger.error({ err, scope: 'sign-in-guard' }, 'sign-in guard update failed');
  }
}

export function emailFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const email = (body as { email?: unknown }).email;
  return typeof email === 'string' && email.trim() ? email : null;
}

/**
 * Classify the value Better Auth stored on `context.returned`.
 * Only a 401 counts. A 403 (password was correct, email unverified) and a
 * normal body (including a second-factor challenge) clear the counter.
 * Other errors are ignored.
 */
export function signInOutcome(returned: unknown): 'failure' | 'clear' | null {
  if (!returned || typeof returned !== 'object') return 'clear';
  const error = returned as { name?: unknown; status?: unknown; statusCode?: unknown };
  if (error.name !== 'APIError') return 'clear';
  if (error.statusCode === 401 || error.status === 'UNAUTHORIZED') return 'failure';
  if (error.statusCode === 403 || error.status === 'FORBIDDEN') return 'clear';
  return null;
}
