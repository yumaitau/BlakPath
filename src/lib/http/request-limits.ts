import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getCounterStore } from '@/lib/http/counter-store';
import { platformKey } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/**
 * Shared request limits. Every public and bearer route below counts per
 * client IP and, when a credential is present, per token or key id. Both
 * must pass. A store error is a 429 — never a bypass, and the log line is
 * the scope only.
 *
 * Auth routes keep their own rules (`AUTH_LIMITS`) inside Better Auth.
 * Page routes `/form/:token`, `/verify/:code` and `/c/:token` are enforced in `src/proxy.ts`
 * so the response can be a real 429 before render.
 */

export interface RequestLimitPolicy {
  readonly scope: string;
  readonly windowSec: number;
  readonly ipMax: number;
  readonly subjectMax: number;
}

export const REQUEST_LIMITS = {
  createAccount: { scope: 'create-account', windowSec: 60, ipMax: 5, subjectMax: 5 },
  publicFormPost: { scope: 'public-form', windowSec: 60, ipMax: 20, subjectMax: 10 },
  // Draft autosave fires after a 1.5s pause in typing, so it gets more room.
  publicFormDraft: {
    scope: 'public-form-draft',
    windowSec: 60,
    ipMax: 120,
    subjectMax: 60,
  },
  // Two calls per file (presign + complete).
  publicFormFile: { scope: 'public-form-file', windowSec: 60, ipMax: 30, subjectMax: 20 },
  formPage: { scope: 'form-page', windowSec: 60, ipMax: 60, subjectMax: 30 },
  verifyPage: { scope: 'verify-page', windowSec: 60, ipMax: 30, subjectMax: 15 },
  correspondencePage: {
    scope: 'correspondence-page',
    windowSec: 60,
    ipMax: 30,
    subjectMax: 15,
  },
  invitationAccept: {
    scope: 'invitation-accept',
    windowSec: 60,
    ipMax: 10,
    subjectMax: 5,
  },
  api: { scope: 'v1', windowSec: 60, ipMax: 60, subjectMax: 120 },
  mcp: { scope: 'mcp', windowSec: 60, ipMax: 30, subjectMax: 60 },
  scim: { scope: 'scim', windowSec: 60, ipMax: 20, subjectMax: 60 },
  emailEvents: { scope: 'email-events', windowSec: 60, ipMax: 30, subjectMax: 60 },
} as const satisfies Record<string, RequestLimitPolicy>;

/** Better Auth credential windows. Custom rules replace the library defaults. */
export const AUTH_LIMITS = {
  window: 60,
  max: 100,
  signInEmail: { window: 60, max: 5 },
  signUpEmail: { window: 60, max: 5 },
  forgetPassword: { window: 60, max: 3 },
  requestPasswordReset: { window: 60, max: 3 },
  resetPassword: { window: 60, max: 5 },
  verifyTotp: { window: 60, max: 5 },
  verifyBackupCode: { window: 60, max: 5 },
} as const;

export class RateLimitedError extends Error {
  readonly status = 429;
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super('Too many requests');
    this.name = 'RateLimitedError';
    this.retryAfter = retryAfter;
  }
}

export type CounterKind = 'ip' | 'token' | 'key';

export function counterKey(scope: string, kind: CounterKind, identity: string): string {
  return platformKey('rl', scope, kind, identity);
}

/** SHA-256 hex. Bearer tokens and webhook secrets are never stored raw. */
export function hashIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

type TakeResult = { allowed: true } | { allowed: false; retryAfter: number };

async function take(
  policy: RequestLimitPolicy,
  kind: CounterKind,
  identity: string,
  max: number,
): Promise<TakeResult> {
  try {
    const { count, ttlSec } = await getCounterStore().increment(
      counterKey(policy.scope, kind, identity),
      policy.windowSec,
    );
    if (count <= max) return { allowed: true };
    return { allowed: false, retryAfter: Math.max(1, ttlSec) };
  } catch (err) {
    logger.error({ err, scope: policy.scope }, 'request limit store unavailable');
    return { allowed: false, retryAfter: policy.windowSec };
  }
}

export function rateLimitResponse(retryAfter: number): NextResponse {
  const seconds = String(Math.max(1, retryAfter));
  return NextResponse.json(
    { error: 'Too many requests' },
    {
      status: 429,
      headers: {
        'Retry-After': seconds,
        'X-Retry-After': seconds,
      },
    },
  );
}

function asResponse(result: TakeResult): NextResponse | null {
  if (result.allowed) return null;
  return rateLimitResponse(result.retryAfter);
}

function asError(result: TakeResult): void {
  if (!result.allowed) throw new RateLimitedError(result.retryAfter);
}

export async function limitIp(
  policy: RequestLimitPolicy,
  ip: string,
): Promise<NextResponse | null> {
  return asResponse(await take(policy, 'ip', ip, policy.ipMax));
}

/** Hash `raw` before it touches the store. Empty raw skips this dimension. */
export async function limitSubject(
  policy: RequestLimitPolicy,
  raw: string,
): Promise<NextResponse | null> {
  if (!raw) return null;
  return asResponse(await take(policy, 'token', hashIdentity(raw), policy.subjectMax));
}

/** Key id is already an opaque database id, not the bearer secret. */
export async function limitKey(
  policy: RequestLimitPolicy,
  keyId: string,
): Promise<NextResponse | null> {
  if (!keyId) return rateLimitResponse(policy.windowSec);
  return asResponse(await take(policy, 'key', keyId, policy.subjectMax));
}

export async function enforcePair(
  policy: RequestLimitPolicy,
  ip: string,
  subject: string | null,
): Promise<NextResponse | null> {
  const ipLimited = await limitIp(policy, ip);
  if (ipLimited) return ipLimited;
  if (!subject) return null;
  return limitSubject(policy, subject);
}

export async function assertIp(policy: RequestLimitPolicy, ip: string): Promise<void> {
  asError(await take(policy, 'ip', ip, policy.ipMax));
}

export async function assertKey(
  policy: RequestLimitPolicy,
  keyId: string,
): Promise<void> {
  if (!keyId) throw new RateLimitedError(policy.windowSec);
  asError(await take(policy, 'key', keyId, policy.subjectMax));
}
