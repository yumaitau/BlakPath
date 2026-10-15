/**
 * Authorisation errors.
 *
 * These are surfaced to callers when a permission check or separation-of-duties
 * guard fails. Messages are deliberately generic: they NEVER confirm or deny
 * the existence of a resource, a tenant, or another user. Leaking "this record
 * exists but you can't see it" is itself an information disclosure — refusals
 * look identical whether the resource is missing or merely forbidden.
 */

/** Stable machine-readable codes for authorisation failures. */
export type AuthorizationErrorCode =
  'PERMISSION_DENIED' | 'SEPARATION_OF_DUTIES' | 'CONFLICT_OF_INTEREST' | 'POLICY_DENIED';

/**
 * Raised when an actor is not permitted to perform an action. The `message` is
 * safe to return to the client verbatim; put any sensitive diagnostic detail in
 * server-side logs, not here.
 */
export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;
  /** Marks this as an expected authorisation refusal (audited as `denied`). */
  readonly isAuthorizationError = true as const;

  constructor(
    code: AuthorizationErrorCode,
    message = 'You do not have permission to perform this action.',
  ) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

/** Type guard for narrowing unknown catch values. */
export function isAuthorizationError(error: unknown): error is AuthorizationError {
  return (
    error instanceof AuthorizationError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { isAuthorizationError?: unknown }).isAuthorizationError === true)
  );
}
