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

/**
 * Shown to staff. No key material, no ciphertext, no fallback offer.
 * Public forms and verify pages use a separate, shorter degradation.
 */
export const TENANT_KEY_UNAVAILABLE_MESSAGE =
  "Your organisation's encryption key is unavailable. Contact your key administrator.";

export function isTenantKeyUnavailable(
  error: unknown,
): error is TenantKeyUnavailableError {
  return error instanceof TenantKeyUnavailableError;
}
