import { headers } from 'next/headers';
import { headersWithTrustedClientIp } from '@/lib/http/client-ip';
import { isAuthenticationStale, STEP_UP_WINDOWS } from './step-up-policy';
import { enforceStaffSessionLifetime } from './staff-session';
import { auth } from './index';

export { STEP_UP_WINDOWS };

/**
 * Server-side session helpers for React Server Components, route handlers and
 * server actions.
 *
 * SECURITY INTENT
 * ---------------
 * These helpers read the session from the request via Better Auth using the
 * incoming (httpOnly, signed) cookies — never from a client-supplied body or
 * query parameter. They authenticate the *person*; they deliberately expose no
 * tenant scope. Establishing and DB-verifying the tenant context is the job of
 * the tenancy layer and must happen after these checks.
 */

/** The resolved session shape returned by Better Auth's `getSession`. */
export type ServerSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export type SessionUser = ServerSession['user'];

function sessionInstant(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Reads the current session for the incoming request, or `null` when the
 * caller is unauthenticated. Safe to call from RSCs. Because RSCs cannot set
 * cookies, any cookie-cache refresh is deferred until the next mutating
 * interaction (route handler / server action) — this returns the current
 * verified session either way.
 *
 * When the session has an active organisation, a 12-hour absolute cap and the
 * tenant idle timeout are applied here. An expired staff session is deleted
 * and this returns null.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  const session = await auth.api.getSession({
    headers: headersWithTrustedClientIp(new Headers(await headers())),
  });
  if (!session) return null;

  const row = session.session as {
    activeOrganisationId?: string | null;
    updatedAt?: Date | string | null;
    lastAuthenticatedAt?: Date | string | null;
  };
  const organisationId = row.activeOrganisationId;
  if (!organisationId) return session;

  const createdAt = sessionInstant(session.session.createdAt);
  if (!createdAt) return null;
  const lifetime = await enforceStaffSessionLifetime({
    sessionId: session.session.id,
    organisationId,
    createdAt,
    lastActivityAt: sessionInstant(row.updatedAt) ?? createdAt,
  });
  if (lifetime === 'expired') return null;
  return session;
}

/**
 * Thrown when an operation requires an authenticated user but none is present.
 * Callers (route handlers, server actions) translate this into a 401 / redirect
 * to sign-in. It carries no user-identifying detail.
 */
export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  readonly status = 401;
  constructor(message = 'Authentication is required for this action.') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Thrown when a sensitive action requires a recently-authenticated session
 * (step-up) but the current session is too old. Callers translate this into a
 * re-authentication prompt (password re-entry, passkey, or TOTP).
 */
export class StepUpRequiredError extends Error {
  readonly code = 'STEP_UP_REQUIRED';
  readonly status = 401;
  /** How recent the authentication must be, in seconds. */
  readonly maxAgeSeconds: number;
  constructor(maxAgeSeconds: number) {
    super('Please re-authenticate to continue with this sensitive action.');
    this.name = 'StepUpRequiredError';
    this.maxAgeSeconds = maxAgeSeconds;
  }
}

/**
 * Returns the current session, throwing {@link UnauthenticatedError} if the
 * caller is not signed in. Use at the top of any protected handler/action.
 */
export async function requireSession(): Promise<ServerSession> {
  const session = await getServerSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  return session;
}

/**
 * Returns the current authenticated user, throwing if unauthenticated.
 * Convenience over {@link requireSession} when only the user is needed.
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await requireSession();
  return session.user;
}

/**
 * Step-up guard. Ensures the caller authenticated within the last
 * `maxAgeSeconds` seconds; otherwise throws {@link StepUpRequiredError}.
 *
 * Gate EVERY sensitive action behind this: evidence exports, certificate
 * signing, break-glass activation, permission/role changes, and any
 * destructive operation. A long-lived "remember me" session is convenient for
 * reading, but must never be sufficient on its own to perform an irreversible
 * or authority-bearing act.
 *
 * Freshness is measured from `lastAuthenticatedAt` when set, otherwise
 * `createdAt`. Re-authentication mints a new session and stamps
 * `lastAuthenticatedAt`, which resets this clock. Rows written before that
 * column was populated fall back to `createdAt`. Sensitive routes use
 * `STEP_UP_ROUTES` rather than `session.freshAge`.
 *
 * @param maxAgeSeconds Maximum allowed age of the authentication, in seconds.
 * @returns The current, sufficiently-fresh session.
 */
export async function requireRecentAuth(maxAgeSeconds: number): Promise<ServerSession> {
  const session = await requireSession();
  const row = session.session as { lastAuthenticatedAt?: Date | string | null };
  const authenticatedAt =
    sessionInstant(row.lastAuthenticatedAt) ?? sessionInstant(session.session.createdAt);
  if (!authenticatedAt || isAuthenticationStale(authenticatedAt, maxAgeSeconds)) {
    throw new StepUpRequiredError(maxAgeSeconds);
  }
  return session;
}
