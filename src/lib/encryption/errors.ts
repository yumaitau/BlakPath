/**
 * Fail-closed signal for a tenant whose key cannot wrap or unwrap data.
 * Callers map this to HTTP 423 or 503. They must not substitute plaintext.
 */
export class TenantKeyUnavailableError extends Error {
  readonly code = 'TENANT_KEY_UNAVAILABLE' as const;
  readonly organisationId: string;
  readonly httpStatus: 423 | 503;

  constructor(organisationId: string, httpStatus: 423 | 503) {
    super('TENANT_KEY_UNAVAILABLE');
    this.name = 'TenantKeyUnavailableError';
    this.organisationId = organisationId;
    this.httpStatus = httpStatus;
  }
}

/** Shown to people. No key material, no ciphertext, no fallback offer. */
export const TENANT_KEY_UNAVAILABLE_MESSAGE =
  "This organisation's records are locked because its encryption key is unavailable. Nothing was read. A key custodian can restore access. Other organisations are unaffected.";

export function isTenantKeyUnavailable(
  error: unknown,
): error is TenantKeyUnavailableError {
  return error instanceof TenantKeyUnavailableError;
}
