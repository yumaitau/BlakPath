/**
 * Webhook retry policy — pure and testable.
 *
 * Receivers go down for minutes or hours (deploys, certificate renewals,
 * outages), so webhook delivery uses its own backoff measured in hours rather
 * than the queue-wide default of a few seconds. The schedule is explicit so the
 * total retry window is reviewable: a receiver that is down for an hour still
 * receives the event on a later attempt.
 */

/** BullMQ backoff `type` naming this strategy (registered on the webhook worker). */
export const WEBHOOK_BACKOFF_TYPE = 'webhook';

/**
 * Delay before each retry, indexed by the number of attempts already made
 * (entry 0 is the wait after the first failure). The last entry repeats if a
 * job is ever configured with more attempts than the schedule lists.
 */
export const WEBHOOK_RETRY_SCHEDULE_MS: readonly number[] = [
  30_000, // 30s
  2 * 60_000, // 2m
  10 * 60_000, // 10m
  30 * 60_000, // 30m
  60 * 60_000, // 1h
  2 * 3_600_000, // 2h
  4 * 3_600_000, // 4h
  8 * 3_600_000, // 8h
];

/** Total attempts per delivery: the first try plus one retry per schedule entry. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_SCHEDULE_MS.length + 1;

/**
 * A `pending` delivery untouched for this long with no live queue job is
 * considered lost (e.g. the enqueue after insert failed) and is re-queued.
 */
export const WEBHOOK_STALE_PENDING_MS = 3_600_000;

/** Delay before the next attempt after `attemptsMade` failed attempts. */
export function webhookRetryDelayMs(attemptsMade: number): number {
  const index = Math.min(
    Math.max(Math.trunc(attemptsMade), 1) - 1,
    WEBHOOK_RETRY_SCHEDULE_MS.length - 1,
  );
  return WEBHOOK_RETRY_SCHEDULE_MS[index] ?? 0;
}

/**
 * BullMQ custom backoff strategy. Registered on the webhook worker; returns -1
 * (no retry) for any other backoff type so a mis-tagged job fails visibly.
 */
export function webhookBackoffStrategy(attemptsMade: number, type?: string): number {
  if (type !== WEBHOOK_BACKOFF_TYPE) return -1;
  return webhookRetryDelayMs(attemptsMade);
}

/** Job options for a webhook delivery job keyed by its delivery id. */
export function webhookJobOptions(deliveryId: string) {
  return {
    jobId: deliveryId,
    attempts: WEBHOOK_MAX_ATTEMPTS,
    backoff: { type: WEBHOOK_BACKOFF_TYPE },
  };
}

/** Milliseconds from the first attempt until attempt `n` (1-based) is made. */
export function webhookAttemptOffsetMs(n: number): number {
  let total = 0;
  for (let made = 1; made < n; made += 1) total += webhookRetryDelayMs(made);
  return total;
}
