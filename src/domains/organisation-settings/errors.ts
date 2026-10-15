import { ClientSafeError } from '@/lib/http/error-response';

/**
 * Expected failures for organisation settings and domain verification.
 *
 * `message` is a fixed phrase safe to show to an administrator. Do not put
 * tokens, DNS payloads or other tenants' data in it.
 */
export class OrganisationSettingsError extends ClientSafeError {
  constructor(code: string, message: string, status: number) {
    super(status, code, message);
    this.name = 'OrganisationSettingsError';
  }
}
