import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { organisationSettings } from '@/db/schema';
import { requireTenantContext } from '@/lib/tenancy/context';

/**
 * Deceased-name warning for family links.
 *
 * Showing a name of someone who has passed is a cultural-safety concern for
 * many communities. The words are organisation-authored guidance, stored on
 * `organisation_settings.terminology.deceasedNameWarning`. They never score,
 * hide a record from an authorised reader, or decide anything about identity.
 */

export const DEFAULT_DECEASED_NAME_WARNING =
  'This record names someone who has passed. Some communities ask that a name not be shown without warning. Show it only if you are prepared to see it.';

const terminologySchema = z
  .object({
    deceasedNameWarning: z.string().trim().min(1).max(500).optional(),
  })
  .passthrough();

/** Resolve the warning copy. Invalid or missing org text falls back to the default. */
export function deceasedNameWarningFromTerminology(value: unknown): string {
  const parsed = terminologySchema.safeParse(value);
  return parsed.success && parsed.data.deceasedNameWarning
    ? parsed.data.deceasedNameWarning
    : DEFAULT_DECEASED_NAME_WARNING;
}

/** Load the active organisation's deceased-name warning. */
export async function loadDeceasedNameWarning(): Promise<string> {
  const ctx = requireTenantContext();
  const rows = await db
    .select({ terminology: organisationSettings.terminology })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, ctx.organisationId))
    .limit(1);
  return deceasedNameWarningFromTerminology(rows[0]?.terminology);
}
