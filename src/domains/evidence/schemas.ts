import { z } from 'zod';
import { collectionNoticeAcknowledgementSchema } from '@/lib/privacy/collection-notice';
import { isAllowedContentType, MAX_EVIDENCE_BYTES } from './status';

/**
 * Input validation for the evidence domain (zod v4).
 *
 * Upload requests are the hostile surface: the declared content type and size
 * are validated here BEFORE a presigned URL is minted, so a client can never
 * ask us to accept an executable or an oversized object. The real content type
 * is re-verified from magic bytes in the worker (see status.ts).
 */

/** True if the string contains any ASCII control character (code < 32). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 32) return true;
  }
  return false;
}

/**
 * A safe display filename. Path separators, control characters and parent
 * traversal are rejected; ordinary spaces, hyphens and dots are fine because the
 * object KEY is derived from the evidence id, never from this name.
 */
const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      !name.includes('/') &&
      !name.includes('\\') &&
      !name.includes('..') &&
      !hasControlChar(name),
    { message: 'Filename contains path separators or control characters.' },
  );

/** Request a presigned upload slot for a new piece of evidence. */
export const requestUploadSchema = z.object({
  fileName: fileNameSchema,
  contentType: z.string().refine(isAllowedContentType, {
    message: 'This file type is not accepted.',
  }),
  sizeBytes: z.coerce.number().int().positive().max(MAX_EVIDENCE_BYTES),
  /** Optional link to the staff request this upload fulfils. */
  fulfilsRequestId: z.uuid().optional(),
  /**
   * Acknowledgement of the organisation's collection notice. Optional in the
   * schema so a missing one maps to a 409 (not a generic 400); the service
   * rejects any upload that does not name the CURRENT notice.
   */
  collectionNotice: collectionNoticeAcknowledgementSchema.optional(),
});
export type RequestUploadInput = z.input<typeof requestUploadSchema>;

/** Record an administrative classification on a piece of evidence. */
export const classifyEvidenceSchema = z.object({
  classification: z.string().trim().min(1).max(120),
});
export type ClassifyEvidenceInput = z.input<typeof classifyEvidenceSchema>;

/** Ask an applicant to provide further evidence. */
export const requestEvidenceSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  dueAt: z.coerce.date().optional(),
});
export type RequestEvidenceInput = z.input<typeof requestEvidenceSchema>;
