import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { evidence } from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import { getMalwareScanDlq, planDlqRedrive } from '@/lib/queues/dlq';
import {
  enqueueMalwareScan,
  freshScanJobId,
  inFlightScanEvidenceIds,
} from '@/lib/queues/malware-scan';
import { deleteObject, isMissingObject, QUARANTINE_BUCKET } from '@/lib/storage/s3';
import {
  pendingUploadExpired,
  quarantineAgeSeconds,
  quarantineBacklogSignal,
  quarantinedNeedsRequeue,
} from './recovery';

/**
 * Evidence scan sweeper (worker side).
 *
 * For one organisation:
 *   - redrive dead-lettered scans onto the malware-scan queue with a fresh job id;
 *   - re-queue `quarantined` rows older than the threshold that have no in-flight
 *     scan (exhausted retries, a lost job, or a crash before enqueue);
 *   - reject `pending` uploads that were never completed within 24 hours;
 *   - emit quarantined count, oldest age and dead-letter depth for CloudWatch.
 *
 * FAIL-SECURE: this never marks evidence clean, infected or servable. A human
 * still decides what a document means. The scan processor is the only path
 * that promotes bytes.
 */

const BATCH = 100;
const DLQ_PAGE = 200;

export interface EvidenceSweepInput {
  organisationId: string;
  correlationId: string;
}

interface SweepStats {
  redriven: number;
  requeued: number;
  expired: number;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function deleteQuarantineBestEffort(key: string | null): Promise<void> {
  if (!key) return;
  try {
    await deleteObject({ bucket: QUARANTINE_BUCKET, key });
  } catch (err) {
    if (!isMissingObject(err)) {
      logger.warn({ err }, 'expired pending upload quarantine delete failed');
    }
  }
}

export async function sweepEvidenceScans(input: EvidenceSweepInput): Promise<SweepStats> {
  const { organisationId, correlationId } = input;
  const now = new Date();
  const requeueAfterMs = env.EVIDENCE_QUARANTINE_REQUEUE_AFTER_MS;
  const pendingExpireMs = env.EVIDENCE_PENDING_EXPIRE_MS;
  const alarmAfterSeconds = env.EVIDENCE_QUARANTINE_ALARM_AGE_SECONDS;
  const scope = scopeFor(organisationId);
  const inFlight = await inFlightScanEvidenceIds();

  const dlqJobs = await getMalwareScanDlq().getJobs(
    ['waiting', 'delayed', 'paused', 'failed'],
    0,
    DLQ_PAGE - 1,
    true,
  );
  const candidates = dlqJobs.flatMap((job) => {
    if (!job.id) return [];
    const data = job.data as { organisationId?: unknown; evidenceId?: unknown };
    return [
      {
        jobId: job.id,
        organisationId:
          typeof data.organisationId === 'string' ? data.organisationId : '',
        evidenceId: data.evidenceId,
      },
    ];
  });
  const plan = planDlqRedrive(candidates, organisationId, inFlight);
  let redriven = 0;
  for (const evidenceId of plan.enqueueEvidenceIds) {
    await recordAudit({
      action: 'evidence.scan_requeued',
      resourceType: 'evidence',
      resourceId: evidenceId,
      result: 'success',
      reason: 'dead-letter redrive',
      organisationId,
      actorUserId: null,
      actingRole: 'system',
      sessionId: null,
      correlationId,
    });
    await enqueueMalwareScan({
      organisationId,
      correlationId,
      evidenceId,
      jobId: freshScanJobId(evidenceId, now.getTime()),
    });
    inFlight.add(evidenceId);
    redriven += 1;
  }
  const removeIds = new Set(plan.removeJobIds);
  let dlqDepth = candidates.filter((job) => job.organisationId === organisationId).length;
  for (const job of dlqJobs) {
    if (!job.id || !removeIds.has(job.id)) continue;
    await job.remove();
    dlqDepth -= 1;
  }

  const [stats] = await scope.db
    .select({
      count: sql<number>`cast(count(*) as int)`,
      oldest: sql<Date | string | null>`min(${evidence.updatedAt})`,
    })
    .from(evidence)
    .where(
      scope.where(
        evidence.organisationId,
        eq(evidence.status, 'quarantined'),
        isNull(evidence.deletedAt),
      ),
    );
  const quarantinedCount = Number(stats?.count ?? 0);
  const oldest = asDate(stats?.oldest);
  const oldestQuarantinedAgeSeconds =
    oldest && Number.isFinite(quarantinedCount) && quarantinedCount > 0
      ? quarantineAgeSeconds(oldest, now)
      : 0;

  const requeueCutoff = new Date(now.getTime() - requeueAfterMs);
  const due = await scope.db
    .select({ id: evidence.id, updatedAt: evidence.updatedAt })
    .from(evidence)
    .where(
      scope.where(
        evidence.organisationId,
        eq(evidence.status, 'quarantined'),
        isNull(evidence.deletedAt),
        lte(evidence.updatedAt, requeueCutoff),
      ),
    )
    .limit(BATCH);

  let requeued = 0;
  for (const row of due) {
    if (
      !quarantinedNeedsRequeue({
        updatedAt: row.updatedAt,
        now,
        requeueAfterMs,
        inFlight: inFlight.has(row.id),
      })
    ) {
      continue;
    }
    await recordAudit({
      action: 'evidence.scan_requeued',
      resourceType: 'evidence',
      resourceId: row.id,
      result: 'success',
      reason: 'quarantine age exceeded',
      organisationId,
      actorUserId: null,
      actingRole: 'system',
      sessionId: null,
      correlationId,
    });
    await enqueueMalwareScan({
      organisationId,
      correlationId,
      evidenceId: row.id,
      jobId: freshScanJobId(row.id, now.getTime()),
    });
    inFlight.add(row.id);
    requeued += 1;
  }

  const expireCutoff = new Date(now.getTime() - pendingExpireMs);
  const stalePending = await scope.db
    .select({
      id: evidence.id,
      createdAt: evidence.createdAt,
      quarantineKey: evidence.quarantineKey,
    })
    .from(evidence)
    .where(
      scope.where(
        evidence.organisationId,
        eq(evidence.status, 'pending'),
        isNull(evidence.deletedAt),
        lte(evidence.createdAt, expireCutoff),
      ),
    )
    .limit(BATCH);

  let expired = 0;
  for (const row of stalePending) {
    if (!pendingUploadExpired(row.createdAt, now, pendingExpireMs)) continue;
    await deleteQuarantineBestEffort(row.quarantineKey);
    const updated = await scope.db
      .update(evidence)
      .set({
        status: 'rejected',
        scanResult: 'expired:pending',
        scannedAt: now,
      })
      .where(
        and(
          eq(evidence.organisationId, organisationId),
          eq(evidence.id, row.id),
          eq(evidence.status, 'pending'),
        ),
      )
      .returning({ id: evidence.id });
    if (updated.length === 0) continue;
    await recordAudit({
      action: 'evidence.rejected',
      resourceType: 'evidence',
      resourceId: row.id,
      result: 'failure',
      reason: 'pending upload expired',
      organisationId,
      actorUserId: null,
      actingRole: 'system',
      sessionId: null,
      correlationId,
    });
    expired += 1;
  }

  logger.info(
    {
      ...quarantineBacklogSignal({
        backlog: {
          quarantinedCount: Number.isFinite(quarantinedCount) ? quarantinedCount : 0,
          oldestQuarantinedAgeSeconds,
        },
        alarmAfterSeconds,
        dlqDepth: Math.max(0, dlqDepth),
        redriven,
      }),
      organisationId,
    },
    'evidence quarantine backlog',
  );

  return { redriven, requeued, expired };
}
