import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { applicationSearchTokens } from '@/db/schema';
import { env } from '@/lib/env';
import {
  blindSearchToken,
  indexedPrefixes,
  searchBlindKeyFromMaster,
  type SearchField,
} from '@/lib/search/blind-index';

/**
 * Writes the blind-index rows used to find an application by reference or name.
 *
 * Tokens are HMACs, not copies of the name. Callers pass the plaintext before
 * any future field encryption. Replacing tokens deletes the previous set for
 * that application first, so a renamed or anonymised record cannot still be
 * found by the old name.
 */

type TokenStore = Pick<Database, 'insert' | 'delete'>;

export interface SearchableApplication {
  readonly id: string;
  readonly reference: string;
  readonly applicantName: string;
}

function tokenRows(
  organisationId: string,
  application: SearchableApplication,
): Array<{
  organisationId: string;
  applicationId: string;
  field: SearchField;
  token: string;
}> {
  const key = searchBlindKeyFromMaster(env.ENCRYPTION_MASTER_KEY);
  const fields: ReadonlyArray<readonly [SearchField, string]> = [
    ['reference', application.reference],
    ['name', application.applicantName],
  ];
  return fields.flatMap(([field, value]) =>
    indexedPrefixes(value).map((prefix) => ({
      organisationId,
      applicationId: application.id,
      field,
      token: blindSearchToken(key, organisationId, field, prefix),
    })),
  );
}

/** HMAC pair for one typed prefix, used by the list query. */
export function blindTokensForPrefix(
  organisationId: string,
  prefix: string,
): { readonly reference: string; readonly name: string } {
  const key = searchBlindKeyFromMaster(env.ENCRYPTION_MASTER_KEY);
  return {
    reference: blindSearchToken(key, organisationId, 'reference', prefix),
    name: blindSearchToken(key, organisationId, 'name', prefix),
  };
}

export async function clearApplicationSearchTokens(
  db: TokenStore,
  organisationId: string,
  applicationId: string,
): Promise<void> {
  await db
    .delete(applicationSearchTokens)
    .where(
      and(
        eq(applicationSearchTokens.organisationId, organisationId),
        eq(applicationSearchTokens.applicationId, applicationId),
      ),
    );
}

/** Replace every search token for one application with the current fields. */
export async function writeApplicationSearchTokens(
  db: TokenStore,
  organisationId: string,
  application: SearchableApplication,
): Promise<void> {
  const rows = tokenRows(organisationId, application);
  await clearApplicationSearchTokens(db, organisationId, application.id);
  if (rows.length === 0) return;
  await db.insert(applicationSearchTokens).values(rows).onConflictDoNothing();
}
