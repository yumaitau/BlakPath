import { desc, eq, isNull } from 'drizzle-orm';
import { legalHolds, retentionPolicies } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { addJob, QueueName } from '@/lib/queues';
import {
  createPolicySchema,
  placeHoldSchema,
  type CreatePolicyInput,
  type PlaceHoldInput,
} from './schemas';

/**
 * Retention management — tenant-scoped, permission-checked, audited.
 *
 * All operations require `retention:manage`. Policies and legal holds are set
 * here; the actual sweep runs out-of-band in the Retention worker (see
 * sweep.ts). `queueRetentionSweep` enqueues a sweep for a tenant (a scheduler
 * will call it periodically — issue #14).
 */

export type RetentionPolicyRow = typeof retentionPolicies.$inferSelect;
export type LegalHoldRow = typeof legalHolds.$inferSelect;

export async function createPolicy(
  rawInput: CreatePolicyInput,
): Promise<RetentionPolicyRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');

  const input = createPolicySchema.parse(rawInput);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(retentionPolicies)
    .values(
      scope.insertValues({
        resourceType: input.resourceType,
        retentionDays: input.retentionDays,
        action: input.action,
        createdByUserId: ctx.userId,
      }),
    )
    .returning();
  const row = expectRow(inserted[0], 'retention policy');

  await recordAudit({
    action: 'retention.policy_applied',
    resourceType: 'retention_policy',
    resourceId: row.id,
    result: 'success',
    after: {
      data: {
        resourceType: input.resourceType,
        retentionDays: input.retentionDays,
        action: input.action,
      },
      allow: ['resourceType', 'retentionDays', 'action'],
    },
  });
  return row;
}

export async function listPolicies(): Promise<RetentionPolicyRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  return scope.db
    .select()
    .from(retentionPolicies)
    .where(
      scope.where(retentionPolicies.organisationId, isNull(retentionPolicies.deletedAt)),
    )
    .orderBy(desc(retentionPolicies.createdAt));
}

export async function deletePolicy(id: string): Promise<void> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  await scope.db
    .update(retentionPolicies)
    .set({ active: false, deletedAt: new Date() })
    .where(scope.where(retentionPolicies.organisationId, eq(retentionPolicies.id, id)));
}

export async function placeHold(rawInput: PlaceHoldInput): Promise<LegalHoldRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');

  const input = placeHoldSchema.parse(rawInput);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(legalHolds)
    .values(
      scope.insertValues({
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        reason: input.reason,
        placedByUserId: ctx.userId,
      }),
    )
    .returning();
  const row = expectRow(inserted[0], 'legal hold');

  await recordAudit({
    action: 'retention.hold_placed',
    resourceType: 'retention_policy',
    resourceId: row.id,
    result: 'success',
    after: {
      data: { resourceType: input.resourceType, resourceId: input.resourceId },
      allow: ['resourceType', 'resourceId'],
    },
  });
  return row;
}

export async function releaseHold(id: string): Promise<LegalHoldRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  const updated = await scope.db
    .update(legalHolds)
    .set({ releasedAt: new Date(), releasedByUserId: ctx.userId })
    .where(
      scope.where(
        legalHolds.organisationId,
        eq(legalHolds.id, id),
        isNull(legalHolds.releasedAt),
      ),
    )
    .returning();
  const row = expectRow(updated[0], 'legal hold');

  await recordAudit({
    action: 'retention.hold_released',
    resourceType: 'retention_policy',
    resourceId: id,
    result: 'success',
  });
  return row;
}

export async function listHolds(): Promise<LegalHoldRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  return scope.db
    .select()
    .from(legalHolds)
    .where(scope.where(legalHolds.organisationId))
    .orderBy(desc(legalHolds.createdAt));
}

/** Enqueue a retention sweep for a tenant (called by a scheduler — issue #14). */
export async function queueRetentionSweep(
  organisationId: string,
  correlationId?: string,
): Promise<void> {
  await addJob(QueueName.Retention, 'sweep', {
    organisationId,
    correlationId: correlationId ?? globalThis.crypto.randomUUID(),
  });
}
