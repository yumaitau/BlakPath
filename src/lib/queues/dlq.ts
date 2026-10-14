import { Queue } from 'bullmq';
import { queueConnection, type TenantJob } from '@/lib/queues';
import { MALWARE_SCAN_DLQ_NAME } from '@/lib/queues/scan-policy';

/**
 * Dead-letter holding queue for malware scans that exhausted their retries.
 *
 * There is deliberately no worker on this queue. The evidence sweeper redrives
 * a job onto `malware-scan` with a fresh id, then removes the dead letter.
 * The file stays quarantined until a scan reports clean, infected or rejected.
 */

export interface DlqCandidate {
  jobId: string;
  organisationId: string;
  evidenceId: unknown;
}

export interface DlqRedrivePlan {
  /** Evidence ids that need a new scan job. */
  enqueueEvidenceIds: string[];
  /** Dead-letter job ids to remove (enqueued, already in flight, or malformed). */
  removeJobIds: string[];
}

let dlq: Queue | null = null;

/** Lazily open the holding queue. Closed with the other producers on shutdown. */
export function getMalwareScanDlq(): Queue {
  dlq ??= new Queue(MALWARE_SCAN_DLQ_NAME, {
    connection: queueConnection,
    prefix: 'bp:queue',
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  return dlq;
}

export async function closeMalwareScanDlq(): Promise<void> {
  if (!dlq) return;
  await dlq.close();
  dlq = null;
}

/**
 * Copy an exhausted scan onto the dead-letter queue. Idempotent on the source
 * job id. Sweep jobs and malformed payloads are ignored.
 */
export async function deadLetterExhaustedScan(job: {
  id?: string;
  name: string;
  data: TenantJob;
}): Promise<void> {
  if (job.name !== 'scan' || !job.id) return;
  const evidenceId = (job.data as { evidenceId?: unknown }).evidenceId;
  if (typeof evidenceId !== 'string' || evidenceId.length === 0) return;
  await getMalwareScanDlq().add(
    'dead',
    { ...job.data, evidenceId },
    {
      jobId: `dlq-${job.id}`,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  );
}

/**
 * Decide which dead letters this tenant should redrive. Other tenants' jobs
 * are left untouched. A second letter for an evidence id already chosen, or
 * one whose scan is still in flight, is only removed.
 */
export function planDlqRedrive(
  jobs: readonly DlqCandidate[],
  organisationId: string,
  inFlight: ReadonlySet<string>,
): DlqRedrivePlan {
  const enqueueEvidenceIds: string[] = [];
  const removeJobIds: string[] = [];
  const chosen = new Set<string>();

  for (const job of jobs) {
    if (job.organisationId !== organisationId) continue;
    if (typeof job.evidenceId !== 'string' || job.evidenceId.length === 0) {
      removeJobIds.push(job.jobId);
      continue;
    }
    if (inFlight.has(job.evidenceId) || chosen.has(job.evidenceId)) {
      removeJobIds.push(job.jobId);
      continue;
    }
    chosen.add(job.evidenceId);
    enqueueEvidenceIds.push(job.evidenceId);
    removeJobIds.push(job.jobId);
  }

  return { enqueueEvidenceIds, removeJobIds };
}
