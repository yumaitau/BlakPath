import { headers } from 'next/headers';
import { headersWithTrustedClientIp } from '@/lib/http/client-ip';
import { auth } from './index';

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

/**
 * Reads the current session for the incoming request, or `null` when the
 * caller is unauthenticated. Safe to call from RSCs. Because RSCs cannot set
 * cookies, any cookie-cache refresh is deferred until the next mutating
 * interaction (route handler / server action) — this returns the current
 * verified session either way.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  const session = await auth.api.getSession({
    headers: headersWithTrustedClientIp(new Headers(await headers())),
  });
  return session ?? null;
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
 * Freshness is measured from the session's `createdAt`: Better Auth mints a new
 * session on password sign-in and after a successful second factor, so a
 * genuine re-authentication resets this clock. This complements the auth
 * config's `session.freshAge`.
 *
 * @param maxAgeSeconds Maximum allowed age of the authentication, in seconds.
 * @returns The current, sufficiently-fresh session.
 */
export async function requireRecentAuth(maxAgeSeconds: number): Promise<ServerSession> {
  const session = await requireSession();
  const authenticatedAt = session.session.createdAt;
  const ageSeconds = (Date.now() - new Date(authenticatedAt).getTime()) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds > maxAgeSeconds) {
    throw new StepUpRequiredError(maxAgeSeconds);
  }
  return session;
}

/**
 * Common step-up windows, in seconds. Named so call sites read intent rather
 * than magic numbers. Values are intentionally short.
 */
export const STEP_UP_WINDOWS = {
  /** Break-glass activation and permission/role changes: 5 minutes. */
  privileged: 5 * 60,
  /** Evidence export and certificate signing: 10 minutes. */
  sensitiveAction: 10 * 60,
  /** Ordinary destructive actions (soft-delete etc.): 15 minutes. */
  destructive: 15 * 60,
} as const;
