import { and, eq, lt, lte, or } from 'drizzle-orm';
import { exportRequests } from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { recordAudit, type AuditTransaction } from '@/domains/audit/service';
import { logger } from '@/lib/observability/logger';
import { addJob, QueueName } from '@/lib/queues';
import { deleteAllObjectVersions, EVIDENCE_BUCKET } from '@/lib/storage/s3';
import { EXPORT_STALE_MS, MAX_EXPORT_ATTEMPTS } from './generate';

/**
 * Export maintenance sweep (worker side, scheduled per tenant).
 *
 *   1. EXPIRE — a `ready` export past `expiresAt` has every object version
 *      removed from storage, then the row is marked `expired` (audited). If the
 *      storage purge fails the row is left `ready` (downloads are already
 *      refused past `expiresAt`) and the next sweep retries; the bucket
 *      lifecycle rule is the backstop.
 *   2. RECOVER — an export stranded `pending` (job lost) or `processing` past
 *      its claim window (worker died) is re-enqueued so a retry takes it over.
 *      One that has used its attempt budget is marked `failed` instead, so a
 *      poison export cannot loop forever.
 *
 * Batched so one run is bounded; the next sweep continues.
 */

const BATCH = 200;

export interface ExportMaintenanceInput {
  organisationId: string;
  correlationId: string;
}

export interface ExportMaintenanceResult {
  expired: number;
  requeued: number;
  abandoned: number;
}

function sysAudit(
  organisationId: string,
  correlationId: string,
  action: 'export.expired' | 'export.failed',
  resourceId: string,
  tx: AuditTransaction,
) {
  return recordAudit(
    {
      action,
      resourceType: 'export',
      resourceId,
      result: action === 'export.failed' ? 'failure' : 'success',
      organisationId,
      actorUserId: null,
      actingRole: 'system',
      sessionId: null,
      correlationId,
    },
    tx,
  );
}

export async function processExportMaintenance(
  input: ExportMaintenanceInput,
  now: Date = new Date(),
): Promise<ExportMaintenanceResult> {
  const { organisationId, correlationId } = input;
  const scope = scopeFor(organisationId);
  const inOrg = (id: string) =>
    and(eq(exportRequests.organisationId, organisationId), eq(exportRequests.id, id));
  const result: ExportMaintenanceResult = { expired: 0, requeued: 0, abandoned: 0 };

  // 1. Expire ready exports whose download window has closed.
  const due = await scope.db
    .select({ id: exportRequests.id, objectKey: exportRequests.objectKey })
    .from(exportRequests)
    .where(
      and(
        eq(exportRequests.organisationId, organisationId),
        eq(exportRequests.status, 'ready'),
        lte(exportRequests.expiresAt, now),
      ),
    )
    .limit(BATCH);
  for (const row of due) {
    if (row.objectKey) {
      try {
        await deleteAllObjectVersions({ bucket: EVIDENCE_BUCKET, key: row.objectKey });
      } catch (err) {
        logger.warn(
          { organisationId, exportRequestId: row.id, err },
          'export object purge failed — will retry next sweep',
        );
        continue;
      }
    }
    const marked = await scope.db.transaction(async (tx) => {
      const rows = await tx
        .update(exportRequests)
        .set({ status: 'expired', objectKey: null })
        .where(and(inOrg(row.id), eq(exportRequests.status, 'ready')))
        .returning({ id: exportRequests.id });
      if (rows.length === 0) return false;
      await sysAudit(organisationId, correlationId, 'export.expired', row.id, tx);
      return true;
    });
    if (marked) result.expired += 1;
  }

  // 2. Recover stranded exports.
  const staleBefore = new Date(now.getTime() - EXPORT_STALE_MS);
  const stranded = await scope.db
    .select({
      id: exportRequests.id,
      status: exportRequests.status,
      startedAt: exportRequests.startedAt,
      createdAt: exportRequests.createdAt,
      attempts: exportRequests.attempts,
    })
    .from(exportRequests)
    .where(
      and(
        eq(exportRequests.organisationId, organisationId),
        or(
          and(
            eq(exportRequests.status, 'pending'),
            lt(exportRequests.createdAt, staleBefore),
          ),
          and(
            eq(exportRequests.status, 'processing'),
            lt(exportRequests.startedAt, staleBefore),
          ),
        ),
      ),
    )
    .limit(BATCH);
  for (const row of stranded) {
    if (row.attempts >= MAX_EXPORT_ATTEMPTS) {
      const failed = await scope.db.transaction(async (tx) => {
        const rows = await tx
          .update(exportRequests)
          .set({
            status: 'failed',
            error: `export abandoned after ${row.attempts} interrupted attempts`,
            completedAt: now,
          })
          .where(
            and(
              inOrg(row.id),
              eq(exportRequests.status, row.status),
              lt(exportRequests.startedAt, staleBefore),
            ),
          )
          .returning({ id: exportRequests.id });
        if (rows.length === 0) return false;
        await sysAudit(organisationId, correlationId, 'export.failed', row.id, tx);
        return true;
      });
      if (failed) result.abandoned += 1;
      continue;
    }
    // One recovery job per claim: the id is stable while the row stays stuck,
    // so repeated sweeps do not pile up duplicates.
    const since = (row.startedAt ?? row.createdAt).getTime();
    await addJob(
      QueueName.Export,
      'generate',
      { organisationId, correlationId, exportRequestId: row.id },
      { jobId: `${row.id}-recover-${since}` },
    );
    result.requeued += 1;
  }

  if (result.expired + result.requeued + result.abandoned > 0) {
    logger.info({ organisationId, ...result }, 'export maintenance actioned exports');
  }
  return result;
}
