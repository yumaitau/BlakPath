import { desc, eq, isNull } from 'drizzle-orm';
import {
  applications,
  evidence,
  formResponses,
  legalHolds,
  retentionPolicies,
} from '@/db/schema';
import { currentScope, type TenantScope } from '@/db/tenant-db';
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
import { previewRetentionSweep, type RetentionPreviewItem } from './sweep';
import type { RetentionResourceType } from './rules';

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

/** The hold target is not a row in this tenant. */
export class RetentionTargetError extends Error {
  readonly code = 'RETENTION_TARGET_MISSING';
  readonly status = 404;
  constructor() {
    super('Legal hold target does not exist.');
    this.name = 'RetentionTargetError';
  }
}

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

export async function createPolicy(
  rawInput: CreatePolicyInput,
): Promise<RetentionPolicyRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');

  const input = createPolicySchema.parse(rawInput);
  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(retentionPolicies)
      .values(
        scope.insertValues({
          resourceType: input.resourceType,
          retentionDays: input.retentionDays,
          action: input.action,
          disposalAuthorityRef: input.disposalAuthorityRef ?? null,
          createdByUserId: ctx.userId,
        }),
      )
      .returning();
    const row = must(inserted[0], 'retention policy');

    await recordAudit(
      {
        action: 'retention.policy_applied',
        resourceType: 'retention_policy',
        resourceId: row.id,
        result: 'success',
        after: {
          data: {
            resourceType: input.resourceType,
            retentionDays: input.retentionDays,
            action: input.action,
            hasDisposalAuthority: input.disposalAuthorityRef !== undefined,
          },
          allow: ['resourceType', 'retentionDays', 'action', 'hasDisposalAuthority'],
        },
      },
      tx,
    );
    return row;
  });
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
  await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(retentionPolicies)
      .set({ active: false, deletedAt: new Date() })
      .where(
        scope.where(
          retentionPolicies.organisationId,
          eq(retentionPolicies.id, id),
          isNull(retentionPolicies.deletedAt),
        ),
      )
      .returning({
        id: retentionPolicies.id,
        resourceType: retentionPolicies.resourceType,
      });
    const row = updated[0];
    if (!row) return;

    await recordAudit(
      {
        action: 'retention.policy_deleted',
        resourceType: 'retention_policy',
        resourceId: row.id,
        result: 'success',
        after: {
          data: { resourceType: row.resourceType },
          allow: ['resourceType'],
        },
      },
      tx,
    );
  });
}

export async function placeHold(rawInput: PlaceHoldInput): Promise<LegalHoldRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');

  const input = placeHoldSchema.parse(rawInput);
  const scope = currentScope();
  if (!(await retentionTargetExists(scope, input.resourceType, input.resourceId))) {
    throw new RetentionTargetError();
  }
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
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
    const row = must(inserted[0], 'legal hold');

    await recordAudit(
      {
        action: 'retention.hold_placed',
        resourceType: 'retention_policy',
        resourceId: row.id,
        result: 'success',
        after: {
          data: { resourceType: input.resourceType, resourceId: input.resourceId },
          allow: ['resourceType', 'resourceId'],
        },
      },
      tx,
    );
    return row;
  });
}

export async function releaseHold(id: string): Promise<LegalHoldRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
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
    const row = must(updated[0], 'legal hold');

    await recordAudit(
      {
        action: 'retention.hold_released',
        resourceType: 'retention_policy',
        resourceId: id,
        result: 'success',
      },
      tx,
    );
    return row;
  });
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

/** What the next sweep would do. No rows are written and nothing is audited. */
export async function previewRetention(): Promise<RetentionPreviewItem[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  return previewRetentionSweep(ctx.organisationId);
}

async function retentionTargetExists(
  scope: TenantScope,
  resourceType: RetentionResourceType,
  resourceId: string,
): Promise<boolean> {
  if (resourceType === 'application') {
    const rows = await scope.db
      .select({ id: applications.id })
      .from(applications)
      .where(scope.where(applications.organisationId, eq(applications.id, resourceId)))
      .limit(1);
    return rows.length > 0;
  }
  if (resourceType === 'evidence') {
    const rows = await scope.db
      .select({ id: evidence.id })
      .from(evidence)
      .where(scope.where(evidence.organisationId, eq(evidence.id, resourceId)))
      .limit(1);
    return rows.length > 0;
  }
  const rows = await scope.db
    .select({ id: formResponses.id })
    .from(formResponses)
    .where(scope.where(formResponses.organisationId, eq(formResponses.id, resourceId)))
    .limit(1);
  return rows.length > 0;
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
