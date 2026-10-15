import { randomBytes } from 'node:crypto';
import type { JobsOptions } from 'bullmq';

/**
 * Malware-scan retry policy.
 *
 * The shared queue default (5 attempts, 2s exponential) is exhausted in about
 * 30 seconds. A ClamAV restart, signature reload or OOM lasts longer than that
 * and used to leave evidence quarantined with no further retries. This policy
 * keeps retrying through a 10 minute outage, then every 10 minutes, without
 * stretching the last waits out to days.
 *
 * BullMQ calls the backoff with `attemptsMade` starting at 1 for the first
 * failure (`job.attemptsMade + 1` in `shouldRetryJob`).
 */

/** Attempts before the scan is dead-lettered. Covers a >=10 minute outage. */
export const MALWARE_SCAN_ATTEMPTS = 24;

/** First retry delay. Later delays double until the cap. */
export const MALWARE_SCAN_BACKOFF_BASE_MS = 2_000;

/** Longest wait between scan attempts. */
export const MALWARE_SCAN_BACKOFF_CAP_MS = 10 * 60 * 1000;

/** Custom BullMQ backoff type. Built-in `exponential` has no cap. */
export const MALWARE_SCAN_BACKOFF_TYPE = 'malware-scan';

/** Holding queue for scans that exhausted MALWARE_SCAN_ATTEMPTS. No worker consumes it. */
export const MALWARE_SCAN_DLQ_NAME = 'malware-scan-dlq';

/**
 * Delay before the next scan attempt. `attemptsMade` is 1 after the first failure.
 * Sequence: 2s, 4s, 8s, … capped at 10 minutes.
 */
export function malwareScanBackoffMs(attemptsMade: number): number {
  const exponent = Math.max(0, attemptsMade - 1);
  const raw = MALWARE_SCAN_BACKOFF_BASE_MS * 2 ** exponent;
  return Math.min(raw, MALWARE_SCAN_BACKOFF_CAP_MS);
}

/**
 * Worker backoff hook. Only the custom scan type is capped; any other type that
 * reaches this hook keeps the base delay instead of failing the job closed.
 */
export function malwareScanBackoffStrategy(attemptsMade: number, type?: string): number {
  if (type === undefined || type === MALWARE_SCAN_BACKOFF_TYPE) {
    return malwareScanBackoffMs(attemptsMade);
  }
  return MALWARE_SCAN_BACKOFF_BASE_MS;
}

/** Job options for a scan. Sweep jobs on the same queue override attempts. */
export const malwareScanJobOptions: JobsOptions = {
  attempts: MALWARE_SCAN_ATTEMPTS,
  backoff: { type: MALWARE_SCAN_BACKOFF_TYPE, delay: MALWARE_SCAN_BACKOFF_BASE_MS },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * BullMQ rejects custom ids that contain `:`. The evidence id stays in the
 * suffix so operators can correlate a job without reading its payload.
 */
export function freshScanJobId(evidenceId: string, now = Date.now()): string {
  const stamp = now.toString(36);
  const noise = randomBytes(3).toString('hex');
  return `scan-${evidenceId}-${stamp}-${noise}`;
}
