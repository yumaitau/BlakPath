import { asc, eq, gt, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { consentRecords, organisationSettings } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requireAny, subjectFromContext } from '@/lib/permissions/check';
import { openConsentRows, sealWordingSnapshot } from '@/lib/encryption/tenant-fields';
import { CONSENT_READ_PERMISSIONS, CONSENT_WRITE_PERMISSIONS } from './permissions';

/**
 * Consent service — tenant-scoped, permission-checked, audited.
 * Records explicit consent grants/withdrawals. Representative access links
 * here; grants are time-boxed and revocable, never inferred.
 */

export type ConsentRow = typeof consentRecords.$inferSelect;

const recordSchema = z.object({
  subjectUserId: z.uuid(),
  purpose: z.string().trim().min(1).max(200),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().trim().max(2000).optional(),
});

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} from database.`);
  return row;
}

export async function recordConsent(
  raw: z.input<typeof recordSchema>,
): Promise<ConsentRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_WRITE_PERMISSIONS);
  const input = recordSchema.parse(raw);
  const scope = currentScope();
  const wordingRows = await scope.db
    .select({ consentWording: organisationSettings.consentWording })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, scope.organisationId))
    .limit(1);
  const id = uuidv7();
  const wordingSnapshot = await sealWordingSnapshot(
    scope.organisationId,
    id,
    wordingRows[0]?.consentWording ?? null,
  );
  const inserted = await scope.db
    .insert(consentRecords)
    .values(
      scope.insertValues({
        id,
        subjectUserId: input.subjectUserId,
        recordedByUserId: ctx.userId,
        purpose: input.purpose,
        status: 'granted',
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
        wordingSnapshot,
      }),
    )
    .returning();
  const stored = must(inserted[0], 'consent record');
  const [row] = await openConsentRows(scope.organisationId, [stored]);
  const opened = must(row, 'consent record');
  await recordAudit({
    action: 'consent.recorded',
    resourceType: 'consent',
    resourceId: opened.id,
    result: 'success',
  });
  return opened;
}

export async function withdrawConsent(id: string): Promise<ConsentRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_WRITE_PERMISSIONS);
  const scope = currentScope();
  const updated = await scope.db
    .update(consentRecords)
    .set({ status: 'withdrawn', revokedAt: new Date() })
    .where(scope.where(consentRecords.organisationId, eq(consentRecords.id, id)))
    .returning();
  const stored = updated[0];
  if (!stored) {
    const { AuthorizationError } = await import('@/lib/permissions/errors');
    throw new AuthorizationError('POLICY_DENIED');
  }
  const [row] = await openConsentRows(scope.organisationId, [stored]);
  const opened = must(row, 'consent record');
  await recordAudit({
    action: 'consent.withdrawn',
    resourceType: 'consent',
    resourceId: id,
    result: 'success',
  });
  return opened;
}

export async function listConsents(subjectUserId: string): Promise<ConsentRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_READ_PERMISSIONS);
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(consentRecords)
    .where(
      scope.where(
        consentRecords.organisationId,
        eq(consentRecords.subjectUserId, subjectUserId),
      ),
    )
    .orderBy(asc(consentRecords.grantedAt));
  return openConsentRows(scope.organisationId, rows);
}

/** True when a live (granted, unexpired, unrevoked) grant exists. */
export async function hasLiveConsent(
  subjectUserId: string,
  purpose: string,
): Promise<boolean> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_READ_PERMISSIONS);
  const scope = currentScope();
  const now = new Date();
  const rows = await scope.db
    .select({ id: consentRecords.id })
    .from(consentRecords)
    .where(
      scope.where(
        consentRecords.organisationId,
        eq(consentRecords.subjectUserId, subjectUserId),
        eq(consentRecords.purpose, purpose),
        eq(consentRecords.status, 'granted'),
        isNull(consentRecords.revokedAt),
        or(isNull(consentRecords.expiresAt), gt(consentRecords.expiresAt, now)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
