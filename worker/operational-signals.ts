import type { Job } from 'bullmq';
import type { TenantJob } from '@/lib/queues';

export interface QueueFailureSignal {
  signal: 'queue_job_failure' | 'queue_job_exhausted';
  alert: boolean;
  attemptsMade: number;
  maxAttempts: number;
}

export interface AuditIntegrityFailureSignal {
  signal: 'audit_integrity_failure';
  alert: true;
  /** Metric name published by the audit-integrity log metric filter. */
  metric: 'AuditIntegrityFailures';
  chain: 'platform' | 'tenant';
  organisationId: string | null;
  eventId: string;
  index: number;
  reason: string;
  eventCount: number;
}

/**
 * Stable divergence signal. The CloudWatch metric filter in
 * `infra/aws/operational-alerts.example.yaml` matches `signal` + `alert` and
 * publishes `AuditIntegrityFailures`, which pages the on-call alarm.
 * Do not add event bodies, metadata or secrets to this object.
 */
export function auditIntegrityFailureSignal(
  input: Omit<AuditIntegrityFailureSignal, 'signal' | 'alert' | 'metric'>,
): AuditIntegrityFailureSignal {
  return {
    signal: 'audit_integrity_failure',
    alert: true,
    metric: 'AuditIntegrityFailures',
    chain: input.chain,
    organisationId: input.organisationId,
    eventId: input.eventId,
    index: input.index,
    reason: input.reason,
    eventCount: input.eventCount,
  };
}

/** Build a stable, machine-readable alert signal without including job payloads. */
export function queueFailureSignal(
  job: Pick<Job<TenantJob>, 'attemptsMade' | 'opts'> | undefined,
): QueueFailureSignal {
  const attemptsMade = job?.attemptsMade ?? 0;
  const configuredAttempts = job?.opts.attempts;
  const maxAttempts =
    typeof configuredAttempts === 'number' && configuredAttempts > 0
      ? configuredAttempts
      : 1;
  const exhausted = attemptsMade >= maxAttempts;
  return {
    signal: exhausted ? 'queue_job_exhausted' : 'queue_job_failure',
    alert: exhausted,
    attemptsMade,
    maxAttempts,
  };
}
