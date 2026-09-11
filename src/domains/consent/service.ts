import { asc, eq, gt, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { consentRecords } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requireAny, subjectFromContext } from '@/lib/permissions/check';

/**
 * Consent service — tenant-scoped, permission-checked, audited.
 * Records explicit consent grants/withdrawals. Representative access links
 * here; grants are time-boxed and revocable, never inferred.
 */

export type ConsentRow = typeof consentRecords.$inferSelect;

const CONSENT_WRITE = [
  'application:create',
  'application:update-intake',
  'application:assign',
] as const;
const CONSENT_READ = [
  ...CONSENT_WRITE,
  'application:read-any',
  'application:read-assigned',
] as const;

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
  requireAny(subjectFromContext(ctx), CONSENT_WRITE);
  const input = recordSchema.parse(raw);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(consentRecords)
    .values(
      scope.insertValues({
        subjectUserId: input.subjectUserId,
        recordedByUserId: ctx.userId,
        purpose: input.purpose,
        status: 'granted',
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
      }),
    )
    .returning();
  const row = must(inserted[0], 'consent record');
  await recordAudit({
    action: 'consent.recorded',
    resourceType: 'consent',
    resourceId: row.id,
    result: 'success',
  });
  return row;
}

export async function withdrawConsent(id: string): Promise<ConsentRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_WRITE);
  const scope = currentScope();
  const updated = await scope.db
    .update(consentRecords)
    .set({ status: 'withdrawn', revokedAt: new Date() })
    .where(scope.where(consentRecords.organisationId, eq(consentRecords.id, id)))
    .returning();
  const row = updated[0];
  if (!row) {
    const { AuthorizationError } = await import('@/lib/permissions/errors');
    throw new AuthorizationError('POLICY_DENIED');
  }
  await recordAudit({
    action: 'consent.withdrawn',
    resourceType: 'consent',
    resourceId: id,
    result: 'success',
  });
  return row;
}

export async function listConsents(subjectUserId: string): Promise<ConsentRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_READ);
  const scope = currentScope();
  return scope.db
    .select()
    .from(consentRecords)
    .where(
      scope.where(
        consentRecords.organisationId,
        eq(consentRecords.subjectUserId, subjectUserId),
      ),
    )
    .orderBy(asc(consentRecords.grantedAt));
}

/** True when a live (granted, unexpired, unrevoked) grant exists. */
export async function hasLiveConsent(
  subjectUserId: string,
  purpose: string,
): Promise<boolean> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CONSENT_READ);
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
