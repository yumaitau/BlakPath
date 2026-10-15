import { z } from 'zod';

/**
 * Input validation for the family-links domain (zod v4). Records a specific
 * family connection — never a judgement about a person's Aboriginality.
 */

/** Request that a family connection be recorded for an application. */
export const requestFamilyLinkSchema = z.object({
  relationship: z.string().trim().min(1).max(120),
  relativeName: z.string().trim().min(1).max(200),
  community: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  /** Cultural-safety flag. True when the relative has passed. */
  relativeDeceased: z.boolean().optional(),
});
export type RequestFamilyLinkInput = z.input<typeof requestFamilyLinkSchema>;

/** Approve or dispute a requested family link, with an optional note. */
export const decideFamilyLinkSchema = z.object({
  note: z.string().trim().max(5000).optional(),
});
export type DecideFamilyLinkInput = z.input<typeof decideFamilyLinkSchema>;
