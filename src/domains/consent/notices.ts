import { eq } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import {
  collectionNoticeAcknowledgements,
  organisationSettings,
  organisations,
} from '@/db/schema';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  acknowledgementMatches,
  resolveCollectionNotice,
  type CollectionNotice,
  type CollectionNoticeContext,
  type CollectionNoticeMethod,
} from '@/lib/privacy/collection-notice';
import { CollectionNoticeError } from './errors';

export { CollectionNoticeError };

/**
 * Collection-notice service.
 *
 * Resolves an organisation's APP 5 collection notice and records versioned,
 * hashed acknowledgements at each point of collection. The notice is resolved
 * SERVER-SIDE at submit time and compared with what the client says it showed,
 * so a stale page or a request that skipped the notice is rejected before any
 * information is stored.
 */

export type CollectionNoticeAcknowledgementRow =
  typeof collectionNoticeAcknowledgements.$inferSelect;

/**
 * Load the notice for an organisation id that the caller has ALREADY resolved
 * from a trusted source (the tenant context, or a hashed public token). The
 * notice wording is not sensitive, so this is a plain keyed read.
 */
export async function loadCollectionNotice(
  organisationId: string,
): Promise<CollectionNotice> {
  const rows = await db
    .select({
      legalName: organisations.legalName,
      tradingName: organisations.tradingName,
      consentWording: organisationSettings.consentWording,
    })
    .from(organisations)
    .leftJoin(
      organisationSettings,
      eq(organisationSettings.organisationId, organisations.id),
    )
    .where(eq(organisations.id, organisationId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('Organisation not found for collection notice.');
  return resolveCollectionNotice({
    organisationName: row.tradingName ?? row.legalName,
    consentWording: row.consentWording,
  });
}

/** The notice for the active tenant (staff intake, applicant upload). */
export function currentCollectionNotice(): Promise<CollectionNotice> {
  return loadCollectionNotice(requireTenantContext().organisationId);
}

/** Throw {@link CollectionNoticeError} unless `raw` names the current notice. */
export function assertNoticeAcknowledged(notice: CollectionNotice, raw: unknown): void {
  if (!acknowledgementMatches(notice, raw)) throw new CollectionNoticeError();
}

export interface RecordAcknowledgementInput {
  organisationId: string;
  notice: CollectionNotice;
  context: CollectionNoticeContext;
  method: CollectionNoticeMethod;
  resourceType: 'form_response' | 'evidence' | 'application';
  resourceId: string;
  acknowledgedByUserId?: string | null;
  subjectUserId?: string | null;
  ipAddress?: string | null;
}

type Executor = Pick<Database, 'insert'>;

/**
 * Append an acknowledgement row. Pass a transaction as `executor` so the
 * acknowledgement commits atomically with the record it accompanies.
 */
export async function recordNoticeAcknowledgement(
  input: RecordAcknowledgementInput,
  executor: Executor = db,
): Promise<CollectionNoticeAcknowledgementRow> {
  const inserted = await executor
    .insert(collectionNoticeAcknowledgements)
    .values({
      organisationId: input.organisationId,
      context: input.context,
      method: input.method,
      noticeVersion: input.notice.version,
      noticeHash: input.notice.hash,
      acknowledgedByUserId: input.acknowledgedByUserId ?? null,
      subjectUserId: input.subjectUserId ?? null,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ipAddress: input.ipAddress ?? null,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('Expected acknowledgement to be returned from database.');
  return row;
}
