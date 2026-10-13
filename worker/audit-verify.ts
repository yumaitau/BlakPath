import type { Logger } from 'pino';
import { auditOrganisationIdFromJob } from '@/domains/audit/chain-id';
import {
  verifyAndCheckpoint,
  type VerifyAndCheckpointOptions,
  type VerifyAndCheckpointResult,
} from '@/domains/audit/verify';
import { auditIntegrityFailureSignal } from './operational-signals';

export interface AuditVerifyJob {
  readonly organisationId: string;
  readonly correlationId: string;
  readonly jobId?: string;
}

/**
 * Scheduled audit verification. Resumes from the latest checkpoint, writes the
 * next one when the suffix is intact, and emits the integrity-failure signal
 * on divergence. A clean chain is a normal result and must not throw.
 */
export async function processAuditVerifyJob(
  job: AuditVerifyJob,
  logger: Logger,
  options?: VerifyAndCheckpointOptions,
): Promise<VerifyAndCheckpointResult> {
  const organisationId = auditOrganisationIdFromJob(job.organisationId);
  const chain = organisationId === null ? 'platform' : 'tenant';
  const result = await verifyAndCheckpoint(organisationId, options ?? {});
  if (!result.ok && result.divergence) {
    logger.error(
      {
        ...auditIntegrityFailureSignal({
          chain,
          organisationId,
          eventId: result.divergence.eventId,
          index: result.divergence.index,
          reason: result.divergence.reason,
          eventCount: result.eventCount,
        }),
        ...(job.jobId !== undefined ? { jobId: job.jobId } : {}),
        correlationId: job.correlationId,
      },
      'audit chain verification FAILED — divergence detected',
    );
    return result;
  }
  logger.info(
    {
      ...(job.jobId !== undefined ? { jobId: job.jobId } : {}),
      organisationId,
      chain,
      correlationId: job.correlationId,
      eventCount: result.eventCount,
      checkpointId: result.checkpointId,
      checkpointWritten: result.checkpointWritten,
    },
    'audit chain verified clean',
  );
  return result;
}
