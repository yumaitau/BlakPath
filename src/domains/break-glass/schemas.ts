import { z } from 'zod';

/** Input validation for the break-glass flow (zod v4). */

/** A platform operator requests emergency access to a specific organisation. */
export const requestBreakGlassSchema = z.object({
  /** The organisation whose data is to be accessed. */
  organisationId: z.uuid(),
  /** External support-case reference this access is justified against. */
  supportCaseRef: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(2000),
  /** Narrowed description of what may be accessed. */
  scope: z.string().trim().min(1).max(2000),
  /** Grant lifetime once approved. Default 60 minutes, max 8 hours. */
  expiresInMinutes: z.coerce.number().int().min(5).max(480).default(60),
});
export type RequestBreakGlassInput = z.input<typeof requestBreakGlassSchema>;

/** Deny a requested grant, recording why. */
export const denyBreakGlassSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});
export type DenyBreakGlassInput = z.input<typeof denyBreakGlassSchema>;

/**
 * Post-use review. The notes are the human record of whether the access
 * matched the stated support purpose. The software does not judge that.
 */
export const reviewBreakGlassSchema = z.object({
  notes: z.string().trim().min(1).max(2000),
});
export type ReviewBreakGlassInput = z.input<typeof reviewBreakGlassSchema>;
