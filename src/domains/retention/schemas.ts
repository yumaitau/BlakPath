import { z } from 'zod';
import { DISPOSAL_CLASSES, DISPOSAL_CLASS_INFO, RECORDS_JURISDICTIONS } from './disposal';
import { RETENTION_ACTIONS, RETENTION_RESOURCE_TYPES } from './rules';

/**
 * Input validation for retention management (zod v4).
 *
 * `RETENTION_DAYS_SANITY_MAX` is an input bound so a bad number cannot overflow
 * date maths. It is not a legal maximum. Permanent retention is `action:
 * 'retain'` with no end date. A purge must cite an authority reference; the
 * service checks that reference against a records-manager sign-off.
 */

/** 1_000 years. Not a lawful cap. */
export const RETENTION_DAYS_SANITY_MAX = 365_000;

const finiteDays = z.coerce.number().int().min(1).max(RETENTION_DAYS_SANITY_MAX);

export const createPolicySchema = z
  .object({
    resourceType: z.enum(RETENTION_RESOURCE_TYPES),
    retentionDays: z.union([z.null(), finiteDays]).optional(),
    action: z.enum(RETENTION_ACTIONS),
    jurisdiction: z.enum(RECORDS_JURISDICTIONS),
    authorityReference: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((value, context) => {
    if (value.action === 'retain') {
      if (value.retentionDays != null) {
        context.addIssue({
          code: 'custom',
          path: ['retentionDays'],
          message: 'Permanent retention has no end date.',
        });
      }
      return;
    }
    if (value.retentionDays == null) {
      context.addIssue({
        code: 'custom',
        path: ['retentionDays'],
        message: 'A finite retention period is required unless the action is retain.',
      });
    }
    if (value.action === 'purge' && !value.authorityReference) {
      context.addIssue({
        code: 'custom',
        path: ['authorityReference'],
        message: 'A purge requires a disposal authority reference.',
      });
    }
  });
export type CreatePolicyInput = z.input<typeof createPolicySchema>;

export const placeHoldSchema = z.object({
  resourceType: z.enum(RETENTION_RESOURCE_TYPES),
  resourceId: z.uuid(),
  reason: z.string().trim().min(1).max(2000),
});
export type PlaceHoldInput = z.input<typeof placeHoldSchema>;

export const signDisposalAuthoritySchema = z
  .object({
    jurisdiction: z.enum(RECORDS_JURISDICTIONS),
    disposalClass: z.enum(DISPOSAL_CLASSES),
    authorityReference: z.string().trim().min(1).max(500),
    permanent: z.boolean(),
    minimumRetentionDays: z.union([z.null(), finiteDays]).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .superRefine((value, context) => {
    if (
      DISPOSAL_CLASS_INFO[value.disposalClass].destructionForbidden &&
      !value.permanent
    ) {
      context.addIssue({
        code: 'custom',
        path: ['permanent'],
        message: 'This class cannot be destroyed. Sign it as permanent.',
      });
    }
    if (value.permanent && value.minimumRetentionDays != null) {
      context.addIssue({
        code: 'custom',
        path: ['minimumRetentionDays'],
        message: 'A permanent class has no minimum end date.',
      });
    }
  });
export type SignDisposalAuthorityInput = z.input<typeof signDisposalAuthoritySchema>;
