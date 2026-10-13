import { and, eq, inArray, not, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { evidence, formResponses, rightsRequests } from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import type { AuditAction, ResourceType } from '@/domains/audit/events';
import { logger } from '@/lib/observability/logger';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { addJob, QueueName, type TenantJob } from '@/lib/queues';
import {
  deleteAllObjectVersions,
  EVIDENCE_BUCKET,
  QUARANTINE_BUCKET,
} from '@/lib/storage/s3';
import {
  anonymisedValue,
  DATA_REGISTRY,
  SUBJECT_TABLES,
  type ErasureRule,
} from './registry';
import { loadOpenRequest, markInProgress } from './requests';
import {
  isClosedStatus,
  type RightsRequestStatus,
  type RightsRequestType,
} from './rules';
import {
  activeHolds,
  columnKeys,
  resolveOfficial,
  resolveSubject,
  SUBJECT_TARGETS,
} from './subject';

/**
 * Erasure — anonymise everything the organisation holds about a person, except
 * official records and anything under a legal hold.
 *
 * Driven entirely by the registry: for every `subject` table, every column in
 * its `erase` map is overwritten (null, `[erased]` or `{}`). Columns marked
 * `officialRecord` are kept on rows that belong to an official-record
 * application (finalised decision or issued certificate). Applications under a
 * legal hold — and their children — are left untouched, as are held evidence
 * and form responses. Evidence files are deleted from object storage, every
 * version, before the rows are anonymised; a failed deletion is audited as a
 * failure, that row keeps its object keys, and the report asks for a retry.
 *
 * The audit trail, decisions, votes and certificates are official records and
 * are never touched (see the registry).
 *
 * Staff queue the erasure from the web app; the worker runs it, because only the
 * worker role may delete stored objects. The run's report (counts and ids, no
 * content) is saved on the request and summarised in the audit trail.
 */

/** Request types that may lead to erasure. */
export const ERASABLE_TYPES: readonly RightsRequestType[] = ['erasure', 'withdrawal'];

export interface ErasureJob extends TenantJob {
  requestId: string;
  /** The staff member who queued it, for audit attribution. */
  requestedByUserId: string;
}

export interface ErasureReport {
  readonly requestId: string;
  /** Rows anonymised per table. */
  readonly tables: Readonly<Record<string, number>>;
  /** Applications whose official-record fields were kept. */
  readonly officialApplicationIds: readonly string[];
  /** Applications skipped entirely because of a legal hold. */
  readonly heldApplicationIds: readonly string[];
  readonly objectVersionsDeleted: number;
  /** Evidence ids whose stored file could not be deleted (retry the erasure). */
  readonly objectFailures: readonly string[];
}

/** The values erasure writes for one table, keyed by Drizzle property. */
export function erasureSet(
  table: PgTable,
  rules: Readonly<Record<string, ErasureRule>>,
  options: { keepOfficial: boolean },
): Record<string, unknown> {
  const keys = columnKeys(table);
  const set: Record<string, unknown> = {};
  for (const [column, rule] of Object.entries(rules)) {
    if (options.keepOfficial && rule.officialRecord) continue;
    const key = keys.get(column);
    if (!key) throw new Error(`Registry column ${column} is not on the table.`);
    set[key] = anonymisedValue(rule);
  }
  return set;
}

/** Queue the erasure of a request's subject. Requires `privacy:manage`. */
export async function requestErasure(requestId: string): Promise<void> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  const request = await loadOpenRequest(requestId, ERASABLE_TYPES);
  // No fixed jobId: a retry after a partial failure must be able to run again.
  await addJob<ErasureJob>(QueueName.Privacy, 'erase', {
    organisationId: ctx.organisationId,
    correlationId: ctx.correlationId,
    requestId,
    requestedByUserId: ctx.userId,
  });
  await markInProgress(request);
  await recordAudit({
    action: 'privacy.erasure_requested',
    resourceType: 'rights_request',
    resourceId: requestId,
    result: 'success',
  });
}

/** Worker: run the erasure. Returns null when the request is gone or closed. */
export async function processErasure(input: ErasureJob): Promise<ErasureReport | null> {
  const scope = scopeFor(input.organisationId);
  const org = scope.organisationId;
  const found = await scope.db
    .select()
    .from(rightsRequests)
    .where(
      scope.where(rightsRequests.organisationId, eq(rightsRequests.id, input.requestId)),
    )
    .limit(1);
  const request = found[0];
  if (
    !request ||
    !ERASABLE_TYPES.includes(request.type as RightsRequestType) ||
    isClosedStatus(request.status as RightsRequestStatus)
  ) {
    logger.warn(
      { organisationId: org, correlationId: input.correlationId },
      'erasure skipped: request missing, not erasable or closed',
    );
    return null;
  }

  const audit = (
    action: AuditAction,
    resourceType: ResourceType,
    resourceId: string,
    extra: Partial<Parameters<typeof recordAudit>[0]> = {},
  ) =>
    recordAudit({
      action,
      resourceType,
      resourceId,
      result: 'success',
      organisationId: org,
      actorUserId: input.requestedByUserId,
      actingRole: 'system',
      sessionId: null,
      correlationId: input.correlationId,
      ...extra,
    });

  const ref = { clientId: request.subjectClientId, userId: request.subjectUserId };
  const holds = await activeHolds(scope);
  const heldApps = holds.get('application') ?? new Set<string>();
  const everything = await resolveSubject(scope, ref);
  const heldApplicationIds = everything.applicationIds.filter((id) => heldApps.has(id));
  const subject = await resolveSubject(scope, ref, {
    excludeApplicationIds: heldApplicationIds,
  });
  const official = await resolveOfficial(scope, subject);

  // Row-level holds on evidence and form responses.
  const heldRows: Record<string, SQL | undefined> = {
    evidence: notIn(evidence.id, holds.get('evidence')),
    form_responses: notIn(formResponses.id, holds.get('form_response')),
  };

  // The stored files behind the subject's evidence.
  const objectRows = await scope.db
    .select({
      id: evidence.id,
      evidenceKey: evidence.evidenceKey,
      quarantineKey: evidence.quarantineKey,
    })
    .from(evidence)
    .where(
      and(
        eq(evidence.organisationId, org),
        SUBJECT_TARGETS.evidence!.match(subject),
        heldRows.evidence,
      ),
    );

  // Delete stored files first. A row whose file could not be deleted keeps its
  // object keys (it is skipped below) so a retry can still find the file.
  let objectVersionsDeleted = 0;
  const objectFailures: string[] = [];
  for (const row of objectRows) {
    const targets: Array<[string, string | null]> = [
      [EVIDENCE_BUCKET, row.evidenceKey],
      [QUARANTINE_BUCKET, row.quarantineKey],
    ];
    for (const [bucket, key] of targets) {
      if (!key) continue;
      try {
        objectVersionsDeleted += await deleteAllObjectVersions({
          bucket,
          prefix: key,
          exactKey: true,
        });
      } catch {
        objectFailures.push(row.id);
        await audit('privacy.object_delete_failed', 'evidence', row.id, {
          result: 'failure',
          reason: 'stored file could not be deleted during erasure',
        });
      }
    }
  }

  const failedEvidence = new Set([...(holds.get('evidence') ?? []), ...objectFailures]);
  heldRows.evidence = notIn(evidence.id, failedEvidence);

  const now = new Date();
  const tables: Record<string, number> = {};
  await scope.db.transaction(async (tx) => {
    for (const name of SUBJECT_TABLES) {
      const policy = DATA_REGISTRY[name];
      const target = SUBJECT_TARGETS[name];
      if (!policy || policy.class !== 'subject' || !target) {
        throw new Error(`Subject table ${name} has no erasure target.`);
      }
      const base = and(
        eq(target.organisationId, org),
        target.match(subject),
        heldRows[name],
      ) as SQL;
      const full = erasureSet(target.table, policy.erase, { keepOfficial: false });
      if (name === 'evidence') full.deletedAt = now;
      if (Object.keys(full).length === 0) {
        tables[name] = 0;
        continue;
      }

      let count = 0;
      const officialWhere = target.official?.(official);
      if (officialWhere && official.applicationIds.length > 0) {
        const kept = erasureSet(target.table, policy.erase, { keepOfficial: true });
        const notOfficial = await tx
          .update(target.table)
          .set(full)
          .where(and(base, not(officialWhere)))
          .returning({ id: target.id });
        count += notOfficial.length;
        if (Object.keys(kept).length > 0) {
          const officialRows = await tx
            .update(target.table)
            .set(kept)
            .where(and(base, officialWhere))
            .returning({ id: target.id });
          count += officialRows.length;
        }
      } else {
        const rows = await tx
          .update(target.table)
          .set(full)
          .where(base)
          .returning({ id: target.id });
        count = rows.length;
      }
      tables[name] = count;
    }
  });

  const report: ErasureReport = {
    requestId: input.requestId,
    tables,
    officialApplicationIds: official.applicationIds,
    heldApplicationIds,
    objectVersionsDeleted,
    objectFailures: [...new Set(objectFailures)],
  };
  await scope.db
    .update(rightsRequests)
    .set({ erasedAt: new Date(), erasureReport: report })
    .where(
      scope.where(rightsRequests.organisationId, eq(rightsRequests.id, input.requestId)),
    );
  await markInProgress(request, scope);

  await audit('privacy.subject_erased', 'rights_request', input.requestId, {
    result: report.objectFailures.length > 0 ? 'failure' : 'success',
    reason:
      report.objectFailures.length > 0
        ? `${report.objectFailures.length} stored file(s) could not be deleted; retry the erasure`
        : null,
    after: {
      data: {
        ...tables,
        officialApplications: official.applicationIds.length,
        heldApplications: heldApplicationIds.length,
        objectVersionsDeleted,
      },
      allow: [
        ...Object.keys(tables),
        'officialApplications',
        'heldApplications',
        'objectVersionsDeleted',
      ],
    },
  });
  return report;
}

function notIn(
  column: typeof evidence.id | typeof formResponses.id,
  ids: Set<string> | undefined,
): SQL | undefined {
  return ids && ids.size > 0 ? not(inArray(column, [...ids])) : undefined;
}
