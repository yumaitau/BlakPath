import { z } from 'zod';
import { requestUploadSchema } from '@/domains/evidence/schemas';
import { FormFieldsArraySchema } from '@/lib/forms/fields';

/** Input validation for form authoring (zod v4). */

export const createFormSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  applicationId: z.uuid().optional(),
});
export type CreateFormInput = z.input<typeof createFormSchema>;

export const updateFormSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullish(),
    /** The full field list; validated by the form field engine. */
    fields: FormFieldsArraySchema.optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.description !== undefined || v.fields !== undefined,
    { message: 'Provide at least one field to update.' },
  );
export type UpdateFormInput = z.input<typeof updateFormSchema>;

/** Presign a file-field upload on a public form. The field must be type `file`. */
export const publicFileUploadSchema = requestUploadSchema
  .omit({ fulfilsRequestId: true })
  .extend({
    fieldKey: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  });
export type PublicFileUploadInput = z.input<typeof publicFileUploadSchema>;

/**
 * Staff link a submitted response to a case. An empty body creates a new draft
 * case. A reference (`APP-YYYY-XXXXXX`) or application id attaches to one that
 * already exists.
 */
export const linkResponseSchema = z.object({
  applicationId: z.uuid().optional(),
  reference: z
    .string()
    .trim()
    .regex(/^APP-\d{4}-[A-F0-9]{6}$/)
    .optional(),
});
export type LinkResponseInput = z.input<typeof linkResponseSchema>;

export const createInvitationSchema = z.object({
  recipientName: z.string().trim().min(1).max(200).optional(),
  recipientEmail: z.email().optional(),
  /** Days until the link expires. Defaults to 14; capped at 90. */
  expiresInDays: z.coerce.number().int().min(1).max(90).default(14),
});
export type CreateInvitationInput = z.input<typeof createInvitationSchema>;
