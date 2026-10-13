import { z } from 'zod';
import { RIGHTS_REQUEST_STATUSES, RIGHTS_REQUEST_TYPES } from './rules';

/**
 * Input validation for individual-rights handling (zod v4). Tenant and actor
 * ids never come from input — only from the DB-verified TenantContext.
 */

/** Log a request. At least one subject reference is required. */
export const logRequestSchema = z
  .object({
    type: z.enum(RIGHTS_REQUEST_TYPES),
    subjectClientId: z.uuid().optional(),
    subjectUserId: z.uuid().optional(),
    requesterName: z.string().trim().min(1).max(200),
    requesterContact: z.string().trim().max(320).optional(),
    details: z.string().trim().max(5000).optional(),
    /** When the organisation received it; defaults to now. Never in the future. */
    receivedAt: z.coerce
      .date()
      .refine((d) => d.getTime() <= Date.now() + 60_000, 'receivedAt is in the future')
      .optional(),
  })
  .refine((v) => v.subjectClientId !== undefined || v.subjectUserId !== undefined, {
    message: 'Name the client record or account the request is about.',
  });
export type LogRequestInput = z.input<typeof logRequestSchema>;

/** Move a request along, assign it, or extend its due date with a reason. */
export const updateRequestSchema = z
  .object({
    status: z.enum(RIGHTS_REQUEST_STATUSES).optional(),
    assignedToUserId: z.uuid().nullable().optional(),
    outcome: z.string().trim().max(5000).optional(),
    dueAt: z.coerce.date().optional(),
    extensionReason: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((v) => v.dueAt === undefined || v.extensionReason !== undefined, {
    message: 'Record why the due date is being extended.',
  })
  .refine((v) => v.status !== 'refused' || (v.outcome ?? '').length > 0, {
    message: 'Record the reasons for a refusal.',
  });
export type UpdateRequestInput = z.input<typeof updateRequestSchema>;

/** A record in the subject's data: a registry table name and row id. */
const recordRefSchema = z.object({
  table: z.string().trim().min(1).max(100),
  recordId: z.uuid(),
});

/** Correct one field of one record (APP 13). */
export const correctRecordSchema = recordRefSchema.extend({
  field: z.string().trim().min(1).max(100),
  /** Text for text fields; an object for structured intake fields. */
  value: z.union([
    z.string().trim().max(5000),
    z.record(z.string(), z.unknown()),
    z.null(),
  ]),
});
export type CorrectRecordInput = z.input<typeof correctRecordSchema>;

/** Attach the person's statement to a record that was not corrected (APP 13.4). */
export const associateStatementSchema = recordRefSchema.extend({
  field: z.string().trim().min(1).max(100).optional(),
  statement: z.string().trim().min(1).max(5000),
});
export type AssociateStatementInput = z.input<typeof associateStatementSchema>;

/** Redact a whole record, or one field of it, from the subject bundle. */
export const redactionSchema = z.object({
  table: z.string().trim().min(1).max(100),
  recordId: z.string().trim().min(1).max(100),
  field: z.string().trim().min(1).max(100).optional(),
  reason: z.string().trim().max(500).optional(),
});
export type Redaction = z.output<typeof redactionSchema>;

export const exportBundleSchema = z.object({
  redactions: z.array(redactionSchema).max(5000).default([]),
});
export type ExportBundleInput = z.input<typeof exportBundleSchema>;

/** Typing the organisation slug confirms a tenant-wide, irreversible action. */
export const offboardingConfirmSchema = z.object({
  confirmSlug: z.string().trim().min(1).max(200),
});
export type OffboardingConfirmInput = z.input<typeof offboardingConfirmSchema>;
