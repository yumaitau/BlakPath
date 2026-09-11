import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { consentRecords, representativeAuthorisations } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requireAny, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';

/**
 * Representative access — consent-backed, time-boxed, revocable.
 *
 * A representative (parent, advocate) acts for a subject user. Activation
 * REQUIRES a live consent grant (`hasLiveConsent` semantics inlined here so
 * the check and the state change share one scope): granted status, unrevoked,
 * unexpired. Purpose is fixed to `representative-access`. No consent, no
 * access — the check runs on request AND on activation.
 */

export type RepresentativeRow = typeof representativeAuthorisations.$inferSelect;

const REP_WRITE = ['application:create', 'application:update-intake', 'application:assign'] as const;

const requestSchema = z.object({
  subjectUserId: z.uuid(),
  representativeUserId: z.uuid(),
  purpose: z.string().trim().min(1).max(500),
  consentRecordId: z.uuid(),
  expiresAt: z.coerce.date().optional(),
});

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} from database.`);
  return row;
}

async function liveConsent(
  scope: ReturnType<typeof currentScope>,
  consentRecordId: string,
  subjectUserId: string,
): Promise<boolean> {
  const now = new Date();
  const rows = await scope.db
    .select({ id: consentRecords.id })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.organisationId, scope.organisationId),
        eq(consentRecords.id, consentRecordId),
        eq(consentRecords.subjectUserId, subjectUserId),
        eq(consentRecords.purpose, 'representative-access'),
        eq(consentRecords.status, 'granted'),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  const full = await scope.db
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.organisationId, scope.organisationId),
        eq(consentRecords.id, consentRecordId),
      ),
    )
    .limit(1);
  const record = full[0];
  if (!record || record.revokedAt) return false;
  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

export async function requestRepresentativeAccess(
  raw: z.input<typeof requestSchema>,
): Promise<RepresentativeRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), REP_WRITE);
  const input = requestSchema.parse(raw);
  if (input.subjectUserId === input.representativeUserId) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  const scope = currentScope();
  if (!(await liveConsent(scope, input.consentRecordId, input.subjectUserId))) {
    await recordAudit({
      action: 'representative.requested',
      resourceType: 'representative_authorisation',
      resourceId: null,
      result: 'denied',
      reason: 'no live consent',
    });
    throw new AuthorizationError('POLICY_DENIED');
  }
  const inserted = await scope.db
    .insert(representativeAuthorisations)
    .values(
      scope.insertValues({
        subjectUserId: input.subjectUserId,
        representativeUserId: input.representativeUserId,
        purpose: input.purpose,
        status: 'pending',
        expiresAt: input.expiresAt ?? null,
        consentRecordId: input.consentRecordId,
      }),
    )
    .returning();
  const row = must(inserted[0], 'representative authorisation');
  await recordAudit({
    action: 'representative.requested',
    resourceType: 'representative_authorisation',
    resourceId: row.id,
    result: 'success',
  });
  return row;
}

export async function activateRepresentativeAccess(id: string): Promise<RepresentativeRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), REP_WRITE);
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(representativeAuthorisations)
    .where(
      scope.where(representativeAuthorisations.organisationId, eq(representativeAuthorisations.id, id)),
    )
    .limit(1);
  const existing = scope.assertOwned(rows[0]);
  if (!existing || existing.status !== 'pending') throw new AuthorizationError('POLICY_DENIED');
  if (
    !existing.consentRecordId ||
    !(await liveConsent(scope, existing.consentRecordId, existing.subjectUserId))
  ) {
    await recordAudit({
      action: 'representative.activated',
      resourceType: 'representative_authorisation',
      resourceId: id,
      result: 'denied',
      reason: 'consent lapsed',
    });
    throw new AuthorizationError('POLICY_DENIED');
  }
  const updated = await scope.db
    .update(representativeAuthorisations)
    .set({ status: 'active', grantedAt: new Date() })
    .where(
      scope.where(representativeAuthorisations.organisationId, eq(representativeAuthorisations.id, id)),
    )
    .returning();
  const row = must(updated[0], 'representative authorisation');
  await recordAudit({
    action: 'representative.activated',
    resourceType: 'representative_authorisation',
    resourceId: id,
    result: 'success',
  });
  return row;
}

export async function revokeRepresentativeAccess(id: string): Promise<RepresentativeRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), REP_WRITE);
  const scope = currentScope();
  const updated = await scope.db
    .update(representativeAuthorisations)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      scope.where(representativeAuthorisations.organisationId, eq(representativeAuthorisations.id, id)),
    )
    .returning();
  const row = updated[0];
  if (!row) throw new AuthorizationError('POLICY_DENIED');
  await recordAudit({
    action: 'representative.revoked',
    resourceType: 'representative_authorisation',
    resourceId: id,
    result: 'success',
  });
  return row;
}
