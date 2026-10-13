import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organisations } from '@/db/schema';
import {
  toPublicDirectory,
  type PublicOrganisationEntry,
  type PublicOrganisationSource,
} from './public-applications';

/**
 * Public directory reads.
 *
 * Organisations are the tenant boundary, so this list is not tenant-scoped.
 * It still returns only opted-in, active organisations. A direct slug lookup
 * uses the same rule: a closed or unknown organisation is indistinguishable.
 */

const publicColumns = {
  id: organisations.id,
  legalName: organisations.legalName,
  tradingName: organisations.tradingName,
  organisationType: organisations.organisationType,
  slug: organisations.slug,
  status: organisations.status,
  publicApplicationsOpen: organisations.publicApplicationsOpen,
};

export async function listPublicOrganisations(): Promise<PublicOrganisationEntry[]> {
  const rows = await db
    .select(publicColumns)
    .from(organisations)
    .where(
      and(
        eq(organisations.status, 'active'),
        eq(organisations.publicApplicationsOpen, true),
      ),
    );
  return toPublicDirectory(rows);
}

export async function getPublicOrganisationBySlug(
  slug: string,
): Promise<PublicOrganisationEntry | null> {
  const rows = await db
    .select(publicColumns)
    .from(organisations)
    .where(eq(organisations.slug, slug))
    .limit(1);
  const row: PublicOrganisationSource | undefined = rows[0];
  if (!row) return null;
  return toPublicDirectory([row])[0] ?? null;
}
