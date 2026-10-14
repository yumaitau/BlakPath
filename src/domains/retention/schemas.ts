import { z } from 'zod';
import { MIN_RETENTION_DAYS, RETENTION_ACTIONS, RETENTION_RESOURCE_TYPES } from './rules';

/** Input validation for retention management (zod v4). */

export const createPolicySchema = z.object({
  resourceType: z.enum(RETENTION_RESOURCE_TYPES),
  /** Floor of {@link MIN_RETENTION_DAYS}, cap of 10 years. */
  retentionDays: z.coerce.number().int().min(MIN_RETENTION_DAYS).max(3650),
  action: z.enum(RETENTION_ACTIONS),
  /**
   * Reference to an approved disposal authority. Required before a sweep may
   * touch a decided application, a finalised decision, or an issued certificate.
   * Dual-control approval of this reference is a separate records control.
   */
  disposalAuthorityRef: z.string().trim().min(1).max(200).optional(),
});
export type CreatePolicyInput = z.input<typeof createPolicySchema>;

export const placeHoldSchema = z.object({
  resourceType: z.enum(RETENTION_RESOURCE_TYPES),
  resourceId: z.uuid(),
  reason: z.string().trim().min(1).max(2000),
});
export type PlaceHoldInput = z.input<typeof placeHoldSchema>;
