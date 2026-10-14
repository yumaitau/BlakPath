import { z } from 'zod';
import { CORRESPONDENCE_CHANNELS, CORRESPONDENCE_KINDS } from './compose';

/**
 * Input validation for correspondence (zod v4).
 *
 * Tenant id and actor id are never accepted here. They come from the
 * DB-verified tenant context.
 */

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(CORRESPONDENCE_KINDS),
  subjectTemplate: z.string().trim().min(1).max(200),
  bodyTemplate: z.string().trim().min(1).max(20_000),
});
export type CreateTemplateInput = z.input<typeof createTemplateSchema>;

export const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    subjectTemplate: z.string().trim().min(1).max(200).optional(),
    bodyTemplate: z.string().trim().min(1).max(20_000).optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.subjectTemplate !== undefined ||
      value.bodyTemplate !== undefined ||
      value.active !== undefined,
    { message: 'Provide at least one field to update.' },
  );
export type UpdateTemplateInput = z.input<typeof updateTemplateSchema>;

export const draftCorrespondenceSchema = z.object({
  kind: z.enum(CORRESPONDENCE_KINDS),
  channel: z.enum(CORRESPONDENCE_CHANNELS),
  templateId: z.uuid().optional(),
  subjectTemplate: z.string().trim().min(1).max(200).optional(),
  bodyTemplate: z.string().trim().min(1).max(20_000).optional(),
  decisionId: z.uuid().optional(),
  evidenceRequestId: z.uuid().optional(),
  certificateId: z.uuid().optional(),
  recipientEmail: z.email().max(320).optional(),
});
export type DraftCorrespondenceInput = z.input<typeof draftCorrespondenceSchema>;

export const notifyEvidenceRequestSchema = z.object({
  channel: z.enum(CORRESPONDENCE_CHANNELS).default('email'),
  templateId: z.uuid().optional(),
  recipientEmail: z.email().max(320).optional(),
});
export type NotifyEvidenceRequestInput = z.input<typeof notifyEvidenceRequestSchema>;
