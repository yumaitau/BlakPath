import type { Permission } from '@/lib/permissions/catalog';

/**
 * Who may record or withdraw a consent grant.
 * A grant is always an explicit human act — these keys do not infer agreement.
 */
export const CONSENT_WRITE_PERMISSIONS = [
  'application:create',
  'application:update-intake',
  'application:assign',
] as const satisfies readonly Permission[];

/** Who may read consent grants recorded for a person. */
export const CONSENT_READ_PERMISSIONS = [
  ...CONSENT_WRITE_PERMISSIONS,
  'application:read-any',
  'application:read-assigned',
] as const satisfies readonly Permission[];
