import { and, eq, isNull } from 'drizzle-orm';
import {
  applications,
  destructionRegister,
  disposalAuthoritySignoffs,
  evidence,
  formResponses,
  legalHolds,
  retentionPolicies,
} from '@/db/schema';
import type { Database } from '@/db/client';
import { scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import type { AuditAction, ResourceType } from '@/domains/audit/events';
import { logger } from '@/lib/observability/logger';
import { deleteObject, EVIDENCE_BUCKET, QUARANTINE_BUCKET } from '@/lib/storage/s3';
import { sweepBlockReason, type AuthoritySignoffGate } from './approval';
import { CATALOGUE_VERSION, DISPOSAL_CLASS_INFO, isDisposalClass } from './disposal';
import { dueForRetention, isSweepResourceType } from './rules';

/**
 * Retention sweep (worker side).
 *
 * For each active, two-person-approved policy, finds records past their
 * retention period that are NOT under a legal hold, and purges or anonymises
 * them. A purge runs only when a current records-manager sign-off matches the
 * policy's authority reference. Permanent policies and self-approved policies
 * are skipped. Runs with an explicit organisation id.
 *
 * FAIL-SAFE: a held record is never touched; every action is audited; the
 * append-only audit trail itself is never a target. Batched so one run is
 * bounded — the next sweep continues where this left off.
 *
 * Only application, evidence and form_response have a destruction implementation.
 * Other classes are classified and can be scheduled, but this worker does not
 * destroy them (see issue #79).
 */

const BATCH = 500;

export interface SweepInput {
  organisationId: string;
  correlationId: string;
}

type Scope = ReturnType<typeof scopeFor>;
type PolicyRow = typeof retentionPolicies.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function sysAudit(
  organisationId: string,
  correlationId: string,
  action: AuditAction,
  resourceType: ResourceType,
  resourceId: string,
  result: 'success' | 'failure' = 'success',
  reason?: string,
) {
  return recordAudit({
    action,
    resourceType,
    resourceId,
    result,
    ...(reason !== undefined ? { reason } : {}),
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

function signoffGate(
  rows: readonly (typeof disposalAuthoritySignoffs.$inferSelect)[],
  policy: PolicyRow,
): AuthoritySignoffGate | null {
  if (!policy.jurisdiction || !policy.disposalClass) return null;
  const row = rows.find(
    (candidate) =>
      candidate.jurisdiction === policy.jurisdiction &&
      candidate.disposalClass === policy.disposalClass,
  );
  if (!row) return null;
  return {
    authorityReference: row.authorityReference,
    permanent: row.permanent,
    disposalClass: row.disposalClass,
    jurisdiction: row.jurisdiction,
    minimumRetentionDays: row.minimumRetentionDays,
  };
}

/**
 * Commit the destructive write and the destruction-register row together.
 * If either fails, neither remains.
 */
async function commitPurge(
  scope: Scope,
  policy: PolicyRow,
  entry: {
    organisationId: string;
    resourceType: string;
    resourceId: string;
    destroyedAt: Date;
    correlationId: string;
  },
  mutate: (tx: Tx) => Promise<void>,
): Promise<boolean> {
  const authorityReference = policy.authorityReference?.trim() ?? '';
  if (!policy.disposalClass || !policy.jurisdiction || authorityReference.length === 0) {
    return false;
  }
  await scope.db.transaction(async (tx) => {
    await mutate(tx);
    await tx.insert(destructionRegister).values({
      organisationId: entry.organisationId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      disposalClass: policy.disposalClass ?? '',
      jurisdiction: policy.jurisdiction ?? '',
      authorityReference,
      policyId: policy.id,
      destroyedAt: entry.destroyedAt,
      correlationId: entry.correlationId,
    });
  });
  return true;
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

  const signoffs = await scope.db
    .select()
    .from(disposalAuthoritySignoffs)
    .where(
      and(
        eq(disposalAuthoritySignoffs.organisationId, organisationId),
        eq(disposalAuthoritySignoffs.catalogueVersion, CATALOGUE_VERSION),
        isNull(disposalAuthoritySignoffs.supersededAt),
      ),
    );

  for (const policy of policies) {
    if (!isSweepResourceType(policy.resourceType)) continue;
    const disposalClass = policy.disposalClass;
    const destructionForbidden =
      disposalClass !== null && isDisposalClass(disposalClass)
        ? DISPOSAL_CLASS_INFO[disposalClass].destructionForbidden
        : true;
    const block = sweepBlockReason(
      policy,
      signoffGate(signoffs, policy),
      destructionForbidden,
    );
    if (block) {
      if (policy.action === 'purge') {
        await sysAudit(
          organisationId,
          correlationId,
          'retention.purge_blocked',
          'retention_policy',
          policy.id,
          'failure',
          block,
        );
        logger.warn(
          { organisationId, policyId: policy.id, reason: block },
          'retention purge blocked',
        );
      }
      continue;
    }

    const retentionDays = policy.retentionDays;
    if (retentionDays == null) continue;
    const held = await heldIds(scope, organisationId, policy.resourceType);
    const due = (recordDate: Date, id: string) =>
      dueForRetention({
        recordDate,
        retentionDays,
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
          await scope.db
            .update(applications)
            .set({
              applicantName: '[retained-anonymised]',
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
          const committed = await commitPurge(
            scope,
            policy,
            {
              organisationId,
              resourceType: 'application',
              resourceId: r.id,
              destroyedAt: now,
              correlationId,
            },
            async (tx) => {
              await tx
                .update(applications)
                .set({ deletedAt: now })
                .where(
                  and(
                    eq(applications.organisationId, organisationId),
                    eq(applications.id, r.id),
                  ),
                );
            },
          );
          if (!committed) continue;
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
      // Anonymise is not a destruction path for evidence. Do not delete objects
      // as a side effect of a non-purge policy.
      if (policy.action !== 'purge') continue;
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
        const committed = await commitPurge(
          scope,
          policy,
          {
            organisationId,
            resourceType: 'evidence',
            resourceId: r.id,
            destroyedAt: now,
            correlationId,
          },
          async (tx) => {
            await tx
              .update(evidence)
              .set({ deletedAt: now })
              .where(
                and(eq(evidence.organisationId, organisationId), eq(evidence.id, r.id)),
              );
          },
        );
        if (!committed) continue;
        await sysAudit(
          organisationId,
          correlationId,
          'retention.record_purged',
          'evidence',
          r.id,
        );
        actioned += 1;
      }
    } else if (policy.resourceType === 'form_response') {
      if (policy.action !== 'purge') continue;
      // form_response — no soft-delete column, so purge is a hard delete.
      const rows = await scope.db
        .select({ id: formResponses.id, submittedAt: formResponses.submittedAt })
        .from(formResponses)
        .where(eq(formResponses.organisationId, organisationId))
        .limit(BATCH);
      for (const r of rows) {
        if (!due(r.submittedAt, r.id)) continue;
        const committed = await commitPurge(
          scope,
          policy,
          {
            organisationId,
            resourceType: 'form_response',
            resourceId: r.id,
            destroyedAt: now,
            correlationId,
          },
          async (tx) => {
            await tx
              .delete(formResponses)
              .where(
                and(
                  eq(formResponses.organisationId, organisationId),
                  eq(formResponses.id, r.id),
                ),
              );
          },
        );
        if (!committed) continue;
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
