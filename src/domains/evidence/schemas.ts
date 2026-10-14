import { z } from 'zod';
import { EVIDENCE_RECEIPT_CHANNELS } from '@/db/schema/enums';
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

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `value` is a real civil date, not just well-shaped digits. */
function isRealCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

/**
 * Latest civil date that may be recorded as "date received". Sydney is the
 * zone the organisations using BlakPath record receipt in. A date-only value
 * has no time, so the comparison is the calendar day, not an instant.
 */
export function latestReceiptDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const receivedOnSchema = z
  .string()
  .regex(ISO_DATE, 'Enter the date received as YYYY-MM-DD.')
  .refine(isRealCalendarDate, { message: 'That date received is not a real date.' })
  .refine((value) => value <= latestReceiptDate(), {
    message: 'Date received cannot be in the future.',
  });

const receiptChannelSchema = z.enum(EVIDENCE_RECEIPT_CHANNELS);

/**
 * Channel and date for evidence a staff member received for an applicant.
 * Both are required together. Applicant uploads omit them.
 */
export const onBehalfReceiptSchema = z.object({
  receiptChannel: receiptChannelSchema,
  receivedOn: receivedOnSchema,
});

/** Request a presigned upload slot for a new piece of evidence. */
export const requestUploadSchema = z
  .object({
    fileName: fileNameSchema,
    contentType: z.string().refine(isAllowedContentType, {
      message: 'This file type is not accepted.',
    }),
    sizeBytes: z.coerce.number().int().positive().max(MAX_EVIDENCE_BYTES),
    /** Optional link to the staff request this upload fulfils. */
    fulfilsRequestId: z.uuid().optional(),
    /** Set only when recording evidence received for an applicant. */
    receiptChannel: receiptChannelSchema.optional(),
    /** Civil date received. Required together with `receiptChannel`. */
    receivedOn: receivedOnSchema.optional(),
  })
  .superRefine((value, context) => {
    const hasChannel = value.receiptChannel !== undefined;
    const hasDate = value.receivedOn !== undefined;
    if (hasChannel !== hasDate) {
      context.addIssue({
        code: 'custom',
        path: [hasChannel ? 'receivedOn' : 'receiptChannel'],
        message: 'Receipt channel and date received must be provided together.',
      });
    }
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
