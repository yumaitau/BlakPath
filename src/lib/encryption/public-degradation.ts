import { isTenantKeyUnavailable } from './errors';

/**
 * Public forms and certificate verify have no staff session. A missing key
 * must not look like a bad link or an invalid certificate, and it must not
 * surface a stack.
 */
export const PUBLIC_KEY_UNAVAILABLE_MESSAGE =
  "This page can't be shown right now. The organisation's encryption key is unavailable. Contact the organisation.";

export function publicKeyDegradation(error: unknown): string | null {
  if (!isTenantKeyUnavailable(error)) return null;
  return PUBLIC_KEY_UNAVAILABLE_MESSAGE;
}
