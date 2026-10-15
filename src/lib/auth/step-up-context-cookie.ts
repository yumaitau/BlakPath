import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived proof that a passkey re-auth started from an existing session.
 *
 * The passkey sign-in mints a new session and drops `activeOrganisationId`.
 * The sealed payload carries the user and organisation from the previous
 * server session so completion can copy them only when the user id matches.
 * The secret is passed in; callers read it from `env`.
 */

export const STEP_UP_CONTEXT_COOKIE = 'blakpath.step_up_context';
export const STEP_UP_CONTEXT_TTL_MS = 5 * 60 * 1000;

export interface StepUpContextPayload {
  userId: string;
  organisationId: string | null;
  exp: number;
}

export function sealStepUpContext(payload: StepUpContextPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function openStepUpContext(
  token: string,
  secret: string,
  now = Date.now(),
): StepUpContextPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as {
      userId?: unknown;
      organisationId?: unknown;
      exp?: unknown;
    };
    if (typeof record.userId !== 'string' || record.userId.length === 0) return null;
    if (
      typeof record.exp !== 'number' ||
      !Number.isFinite(record.exp) ||
      record.exp < now
    ) {
      return null;
    }
    if (record.organisationId !== null && typeof record.organisationId !== 'string') {
      return null;
    }
    return {
      userId: record.userId,
      organisationId: record.organisationId ?? null,
      exp: record.exp,
    };
  } catch {
    return null;
  }
}
