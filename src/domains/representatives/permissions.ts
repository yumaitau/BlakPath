import type { Permission } from '@/lib/permissions/catalog';

/**
 * Who may request, activate, revoke or list representative access.
 * Activation still requires a live consent grant; this list does not grant it.
 */
export const REPRESENTATIVE_ACCESS_PERMISSIONS = [
  'application:create',
  'application:update-intake',
  'application:assign',
] as const satisfies readonly Permission[];

/**
 * Who may list every representative authorisation in the organisation.
 * Staff only: `application:create` alone (applicants) must not see other
 * people's authorisations.
 */
export const REPRESENTATIVE_LIST_PERMISSIONS = [
  'application:update-intake',
  'application:assign',
] as const satisfies readonly Permission[];
