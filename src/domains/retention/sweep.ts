import { and, eq, isNull } from 'drizzle-orm';
import {
  applications,
  evidence,
  formResponses,
  legalHolds,
  retentionPolicies,
} from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import type { AuditAction, ResourceType } from '@/domains/audit/events';
import { sealApplicationFields } from '@/lib/encryption/tenant-fields';
import { logger } from '@/lib/observability/logger';
import { deleteObject, EVIDENCE_BUCKET, QUARANTINE_BUCKET } from '@/lib/storage/s3';
import { dueForRetention, isRetentionResourceType } from './rules';

/**
 * Retention sweep (worker side).
 *
 * For each active policy, finds records past their retention period that are NOT
 * under a legal hold, and purges or anonymises them. Runs with an explicit
 * organisation id. FAIL-SAFE: a held record is never touched; every action is
 * audited; the append-only audit trail itself is never a target and is never
 * rewritten. Anonymisation therefore removes the applicant name only when the
 * trail never stored it. Batched so one run is bounded — the next sweep
 * continues where this left off.
 */

const BATCH = 500;

export interface SweepInput {
  organisationId: string;
  correlationId: string;
}

type Scope = ReturnType<typeof scopeFor>;

function sysAudit(
  organisationId: string,
  correlationId: string,
  action: AuditAction,
  resourceType: ResourceType,
  resourceId: string,
  result: 'success' | 'failure' = 'success',
) {
  return recordAudit({
    action,
    resourceType,
    resourceId,
    result,
    organisationId,
    actorUserId: null,
    actingRole: 'system',
    sessionId: null,
    correlationId,
  });
}

/** Active (unreleased) legal-hold resource ids for a type. */
async function heldIds(scope: Scope, organisationId: string, resourceType: string) {
  const rows = await scope.db
    .select({ resourceId: legalHolds.resourceId })
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.organisationId, organisationId),
        eq(legalHolds.resourceType, resourceType),
        isNull(legalHolds.releasedAt),
      ),
    );
  return new Set(rows.map((r) => r.resourceId));
}

export async function processRetentionSweep(input: SweepInput): Promise<void> {
  const { organisationId, correlationId } = input;
  const scope = scopeFor(organisationId);
  const now = new Date();

  const policies = await scope.db
    .select()
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.organisationId, organisationId),
        eq(retentionPolicies.active, true),
        isNull(retentionPolicies.deletedAt),
      ),
    );

  for (const policy of policies) {
    if (!isRetentionResourceType(policy.resourceType)) continue;
    const held = await heldIds(scope, organisationId, policy.resourceType);
    const due = (recordDate: Date, id: string) =>
      dueForRetention({
        recordDate,
        retentionDays: policy.retentionDays,
        isHeld: held.has(id),
        now,
      });

    let actioned = 0;

    if (policy.resourceType === 'application') {
      const rows = await scope.db
        .select({ id: applications.id, createdAt: applications.createdAt })
        .from(applications)
        .where(
          and(
            eq(applications.organisationId, organisationId),
            isNull(applications.deletedAt),
          ),
        )
        .limit(BATCH);
      for (const r of rows) {
        if (!due(r.createdAt, r.id)) continue;
        if (policy.action === 'anonymise') {
          const sealed = await sealApplicationFields(organisationId, r.id, {
            applicantName: '[retained-anonymised]',
            intake: null,
          });
          await scope.db
            .update(applications)
            .set({
              applicantName: sealed.applicantName,
              applicantNameBidx: sealed.applicantNameBidx,
              applicantNameTokenBidx: sealed.applicantNameTokenBidx,
              applicantUserId: null,
              intake: null,
            })
            .where(
              and(
                eq(applications.organisationId, organisationId),
                eq(applications.id, r.id),
              ),
            );
          await sysAudit(
            organisationId,
            correlationId,
            'retention.record_anonymised',
            'application',
            r.id,
          );
        } else {
          await scope.db
            .update(applications)
            .set({ deletedAt: now })
            .where(
              and(
                eq(applications.organisationId, organisationId),
                eq(applications.id, r.id),
              ),
            );
          await sysAudit(
            organisationId,
            correlationId,
            'retention.record_purged',
            'application',
            r.id,
          );
        }
        actioned += 1;
      }
    } else if (policy.resourceType === 'evidence') {
      const rows = await scope.db
        .select({
          id: evidence.id,
          createdAt: evidence.createdAt,
          quarantineKey: evidence.quarantineKey,
          evidenceKey: evidence.evidenceKey,
        })
        .from(evidence)
        .where(
          and(eq(evidence.organisationId, organisationId), isNull(evidence.deletedAt)),
        )
        .limit(BATCH);
      for (const r of rows) {
        if (!due(r.createdAt, r.id)) continue;
        // Best-effort object removal; the row is still tombstoned regardless.
        for (const [bucket, key] of [
          [EVIDENCE_BUCKET, r.evidenceKey] as const,
          [QUARANTINE_BUCKET, r.quarantineKey] as const,
        ]) {
          if (key) {
            try {
              await deleteObject({ bucket, key });
            } catch {
              /* ignore */
            }
          }
        }
        await scope.db
          .update(evidence)
          .set({ deletedAt: now })
          .where(and(eq(evidence.organisationId, organisationId), eq(evidence.id, r.id)));
        await sysAudit(
          organisationId,
          correlationId,
          'retention.record_purged',
          'evidence',
          r.id,
        );
        actioned += 1;
      }
    } else {
      // form_response — no soft-delete column, so purge is a hard delete.
      const rows = await scope.db
        .select({ id: formResponses.id, submittedAt: formResponses.submittedAt })
        .from(formResponses)
        .where(eq(formResponses.organisationId, organisationId))
        .limit(BATCH);
      for (const r of rows) {
        if (!due(r.submittedAt, r.id)) continue;
        await scope.db
          .delete(formResponses)
          .where(
            and(
              eq(formResponses.organisationId, organisationId),
              eq(formResponses.id, r.id),
            ),
          );
        await sysAudit(
          organisationId,
          correlationId,
          'retention.record_purged',
          'form_response',
          r.id,
        );
        actioned += 1;
      }
    }

    await sysAudit(
      organisationId,
      correlationId,
      'retention.policy_applied',
      'retention_policy',
      policy.id,
    );
    if (actioned > 0) {
      logger.info(
        {
          organisationId,
          resourceType: policy.resourceType,
          action: policy.action,
          actioned,
        },
        'retention sweep actioned records',
      );
    }
  }
}
