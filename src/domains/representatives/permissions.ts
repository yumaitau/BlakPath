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
