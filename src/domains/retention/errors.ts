/**
 * Retention rule failures that are not permission failures.
 *
 * Messages are safe to return to a caller who already holds `retention:manage`.
 * They do not reveal another tenant's records.
 */

export type RetentionErrorCode =
  | 'AUTHORITY_REQUIRED'
  | 'SIGN_OFF_REQUIRED'
  | 'PERMANENT_CLASS'
  | 'CLASS_FORBIDDEN'
  | 'BELOW_SIGNED_MINIMUM'
  | 'ALREADY_ACTIVE';

export class RetentionError extends Error {
  readonly code: RetentionErrorCode;

  constructor(code: RetentionErrorCode, message: string) {
    super(message);
    this.name = 'RetentionError';
    this.code = code;
  }
}
