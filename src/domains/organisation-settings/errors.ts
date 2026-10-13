/**
 * Expected failures for organisation settings and domain verification.
 *
 * `message` is safe to show to an administrator. Do not put tokens, DNS
 * payloads or other tenants' data in it.
 */
export class OrganisationSettingsError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'OrganisationSettingsError';
    this.code = code;
    this.status = status;
  }
}
