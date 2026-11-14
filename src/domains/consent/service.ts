import { asc, eq, gt, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { consentRecords, organisationSettings } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext, type TenantContext } from '@/lib/tenancy/context';
import { requireAny, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { isApplicantOnlyRoleSet } from '@/lib/permissions/roles';
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

/**
 * Applicant portal accounts may only act on consent about themselves. Staff
 * record consent on a person's behalf; an applicant may not do that for
 * someone else.
 */
async function refuseForeignSubject(
  ctx: TenantContext,
  subjectUserId: string | null | undefined,
  action: 'consent.recorded' | 'consent.viewed' | 'consent.withdrawn',
  resourceId: string | null,
): Promise<void> {
  if (!isApplicantOnlyRoleSet(ctx.roles)) return;
  if (subjectUserId === ctx.userId) return;
  await recordAudit({
    action,
    resourceType: 'consent',
    resourceId,
    result: 'denied',
    reason: 'consent.subject_not_self',
  });
  throw new AuthorizationError('POLICY_DENIED');
}

export async function recordConsent(
  raw: z.input<typeof recordSchema>,
): Promise<ConsentRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_WRITE_PERMISSIONS);
  const input = recordSchema.parse(raw);
  await refuseForeignSubject(ctx, input.subjectUserId, 'consent.recorded', null);
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
  const stored = await scope.db.transaction(async (tx) => {
    const inserted = await tx
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
    const created = expectRow(inserted[0], 'consent record');
    await recordAudit(
      {
        action: 'consent.recorded',
        resourceType: 'consent',
        resourceId: created.id,
        result: 'success',
      },
      tx,
    );
    return created;
  });
  const [row] = await openConsentRows(scope.organisationId, [stored]);
  return expectRow(row, 'consent record');
}

export async function withdrawConsent(id: string): Promise<ConsentRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_WRITE_PERMISSIONS);
  const scope = currentScope();
  if (isApplicantOnlyRoleSet(ctx.roles)) {
    const owner = await scope.db
      .select({ subjectUserId: consentRecords.subjectUserId })
      .from(consentRecords)
      .where(scope.where(consentRecords.organisationId, eq(consentRecords.id, id)))
      .limit(1);
    // A missing row is refused the same way as a foreign one.
    await refuseForeignSubject(ctx, owner[0]?.subjectUserId, 'consent.withdrawn', id);
  }
  const stored = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(consentRecords)
      .set({ status: 'withdrawn', revokedAt: new Date() })
      .where(scope.where(consentRecords.organisationId, eq(consentRecords.id, id)))
      .returning();
    const withdrawn = updated[0];
    if (!withdrawn) throw new AuthorizationError('POLICY_DENIED');
    await recordAudit(
      {
        action: 'consent.withdrawn',
        resourceType: 'consent',
        resourceId: id,
        result: 'success',
      },
      tx,
    );
    return withdrawn;
  });
  const [row] = await openConsentRows(scope.organisationId, [stored]);
  return expectRow(row, 'consent record');
}

export async function listConsents(subjectUserId: string): Promise<ConsentRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_READ_PERMISSIONS);
  await refuseForeignSubject(ctx, subjectUserId, 'consent.viewed', null);
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
