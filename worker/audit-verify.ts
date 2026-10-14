import type { Logger } from 'pino';
import { QueueName } from '@/lib/queues';
import {
  PLATFORM_CHAIN_ID,
  settleAuditChain,
  type AnchoredChainProbe,
  type AnchorSigner,
  type AuditAnchorStore,
  type SettleAuditChainResult,
} from '@/domains/audit/anchor';
import { createS3AuditAnchorStore } from '@/domains/audit/anchor-s3';
import { loadAnchorSigner } from '@/domains/audit/anchor-sign';
import {
  auditChainProbe,
  checkpointVerifiedSuffix,
  verifyFromCheckpoint,
  type VerifyAndCheckpointOptions,
  type VerifyAndCheckpointResult,
  type VerifyFromCheckpointResult,
} from '@/domains/audit/verify';
import { auditIntegrityFailureSignal } from './operational-signals';

export interface AuditVerifyJob {
  readonly organisationId: string;
  readonly correlationId: string;
  /** Set by the scheduler for the null-organisation (platform) chain. */
  readonly platformChain?: boolean;
  readonly jobId?: string;
}

/**
 * True only for the scheduler's platform-chain audit job: the audit queue, the
 * `platform` sentinel id and the explicit flag. That job has no tenant, so the
 * organisation status, tenant-key and active-tenant gates do not apply to it.
 */
export function isPlatformAuditJob(queueName: string, data: unknown): boolean {
  if (queueName !== QueueName.AuditVerify || typeof data !== 'object' || data === null) {
    return false;
  }
  const payload = data as Record<string, unknown>;
  return (
    payload.platformChain === true &&
    payload.organisationId === PLATFORM_CHAIN_ID &&
    typeof payload.correlationId === 'string' &&
    payload.correlationId.trim().length > 0
  );
}

/** Injection points for tests. Production uses Postgres, S3 and the KMS signer. */
export interface AuditVerifyDeps {
  readonly verify?: VerifyAndCheckpointOptions;
  readonly store?: AuditAnchorStore;
  readonly signer?: AnchorSigner;
  readonly probe?: (verified: VerifyFromCheckpointResult) => Promise<AnchoredChainProbe>;
  readonly now?: Date;
}

export interface AuditVerifyOutcome extends VerifyAndCheckpointResult {
  readonly anchor: SettleAuditChainResult;
}

/**
 * Scheduled audit verification. Walks the chain from its latest checkpoint,
 * compares the whole chain to the signed anchors (length and anchored heads),
 * and only then writes the next checkpoint. Divergence or an anchor mismatch
 * emits the integrity-failure signal and writes nothing; a clean chain is a
 * normal result and must not throw. A store outage throws so BullMQ retries.
 */
export async function processAuditVerifyJob(
  job: AuditVerifyJob,
  logger: Logger,
  deps: AuditVerifyDeps = {},
): Promise<AuditVerifyOutcome> {
  const organisationId = job.platformChain === true ? null : job.organisationId;
  const chain = organisationId === null ? 'platform' : 'tenant';
  const verifyOptions = deps.verify ?? {};
  const verified = await verifyFromCheckpoint(organisationId, verifyOptions);
  const probe = await (deps.probe ?? ((input) => auditChainProbe(input)))(verified);
  const anchor = await settleAuditChain({
    organisationId,
    chain: probe,
    store: deps.store ?? createS3AuditAnchorStore(),
    signer: deps.signer ?? loadAnchorSigner(),
    ...(deps.now ? { now: deps.now } : {}),
  });

  if (anchor.status === 'divergence' || anchor.status === 'anchor_mismatch') {
    logger.error(
      {
        ...auditIntegrityFailureSignal({
          chain,
          organisationId,
          eventId: verified.divergence?.eventId ?? null,
          index: verified.divergence?.index ?? null,
          reason: verified.divergence?.reason ?? anchor.reason ?? 'unknown',
          eventCount: verified.eventCount,
        }),
        anchorDay: anchor.day,
        ...(job.jobId !== undefined ? { jobId: job.jobId } : {}),
        correlationId: job.correlationId,
      },
      'audit chain verification FAILED',
    );
    return {
      ...verified,
      checkpointId: verified.priorCheckpointId,
      checkpointWritten: false,
      anchor,
    };
  }

  const written = await checkpointVerifiedSuffix(verified, verifyOptions);
  const checkpointId = written ?? verified.priorCheckpointId;
  logger.info(
    {
      ...(job.jobId !== undefined ? { jobId: job.jobId } : {}),
      organisationId,
      chain,
      correlationId: job.correlationId,
      eventCount: verified.eventCount,
      checkpointId,
      checkpointWritten: written !== null,
      anchor: anchor.status,
    },
    'audit chain verified clean',
  );
  return { ...verified, checkpointId, checkpointWritten: written !== null, anchor };
}
