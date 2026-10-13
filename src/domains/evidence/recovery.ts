/**
 * Pure evidence-scan recovery rules.
 *
 * The sweeper and `completeUpload` share these decisions so a unit test can
 * cover the age threshold, the missing-object rejection and the backlog alarm
 * without Postgres, Redis or S3.
 *
 * PRODUCT INVARIANT: nothing here scores or infers Aboriginality. Recovery
 * only re-queues a malware scan or expires an upload that never arrived.
 */

export interface ObjectHead {
  readonly contentLength: number;
}

/** Why `completeUpload` must refuse to leave `pending`. `null` means the bytes match. */
export function quarantineUploadProblem(
  expectedBytes: number,
  head: ObjectHead | null,
): 'missing' | 'size-mismatch' | null {
  if (!head) return 'missing';
  if (head.contentLength !== expectedBytes) return 'size-mismatch';
  return null;
}

/**
 * A quarantined row needs a new scan job when it has been waiting at least
 * `requeueAfterMs` and no scan is active, waiting or delayed. In-flight retries
 * already cover a scanner blip; this catches exhausted or lost jobs.
 */
export function quarantinedNeedsRequeue(input: {
  updatedAt: Date;
  now: Date;
  requeueAfterMs: number;
  inFlight: boolean;
}): boolean {
  if (input.inFlight) return false;
  return input.now.getTime() - input.updatedAt.getTime() >= input.requeueAfterMs;
}

/** A `pending` upload that was never completed is abandoned after this age. */
export function pendingUploadExpired(
  createdAt: Date,
  now: Date,
  expireAfterMs: number,
): boolean {
  return now.getTime() - createdAt.getTime() >= expireAfterMs;
}

export interface QuarantineBacklog {
  quarantinedCount: number;
  oldestQuarantinedAgeSeconds: number;
}

/** Whole seconds since `updatedAt`. Never negative. */
export function quarantineAgeSeconds(updatedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / 1000));
}

/** Count and oldest age of rows still `quarantined`. Empty backlog reports age 0. */
export function quarantineBacklog(
  updatedAts: readonly Date[],
  now: Date,
): QuarantineBacklog {
  let oldestQuarantinedAgeSeconds = 0;
  for (const updatedAt of updatedAts) {
    const ageSeconds = quarantineAgeSeconds(updatedAt, now);
    if (ageSeconds > oldestQuarantinedAgeSeconds)
      oldestQuarantinedAgeSeconds = ageSeconds;
  }
  return { quarantinedCount: updatedAts.length, oldestQuarantinedAgeSeconds };
}

export interface QuarantineBacklogSignal {
  signal: 'evidence_quarantine_backlog';
  alert: boolean;
  quarantinedCount: number;
  oldestQuarantinedAgeSeconds: number;
  dlqDepth: number;
  redriven: number;
}

/**
 * One structured log line. CloudWatch metric filters read the numeric fields.
 * `alert` is true when the handling target is breached or the dead-letter
 * queue still holds work after this sweep.
 */
export function quarantineBacklogSignal(input: {
  backlog: QuarantineBacklog;
  alarmAfterSeconds: number;
  dlqDepth: number;
  redriven: number;
}): QuarantineBacklogSignal {
  return {
    signal: 'evidence_quarantine_backlog',
    alert:
      input.backlog.oldestQuarantinedAgeSeconds >= input.alarmAfterSeconds ||
      input.dlqDepth > 0,
    quarantinedCount: input.backlog.quarantinedCount,
    oldestQuarantinedAgeSeconds: input.backlog.oldestQuarantinedAgeSeconds,
    dlqDepth: input.dlqDepth,
    redriven: input.redriven,
  };
}
