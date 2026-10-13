/**
 * Outbound email pacing.
 *
 * Two worker queues send mail (Email: invitations and form links;
 * Notification: "you have a new notification" copies) and auth mail sends
 * synchronously. The sender (SES or its replacement) enforces a per-second
 * quota, so the queues are throttled by BullMQ's Redis-backed limiter, which
 * holds across every worker replica. The two queues share the quota and leave
 * headroom for auth mail, so a 500-invitation burst drains at the quota
 * instead of failing with throttling errors.
 *
 * Pure and free of env imports so it can be unit tested in isolation.
 */

export interface QueueRateLimit {
  /** Jobs allowed per `duration` window. */
  max: number;
  /** Window length in milliseconds. */
  duration: number;
}

/**
 * Split a per-second sender quota between the Email and Notification queues.
 * Roughly 60% / 30%, leaving at least 10% for synchronous auth mail. Each queue
 * always gets at least one send per second so neither starves.
 */
export function emailQueueRateLimits(quotaPerSecond: number): {
  email: QueueRateLimit;
  notification: QueueRateLimit;
} {
  const quota = Math.max(1, Math.floor(quotaPerSecond));
  return {
    email: { max: Math.max(1, Math.floor(quota * 0.6)), duration: 1_000 },
    notification: { max: Math.max(1, Math.floor(quota * 0.3)), duration: 1_000 },
  };
}

/** How long a queue pauses after the sender reports throttling. */
export const THROTTLE_BACKOFF_MS = 5_000;

const THROTTLE_ERROR_NAMES = new Set([
  'TooManyRequestsException',
  'ThrottlingException',
  'Throttling',
  'EmailThrottledError',
]);

/**
 * True when a send failed because the sender is rate limiting us (as opposed
 * to a bad address or an outage). Recognises the SES API error names, SES SMTP
 * throttling replies (454 "Throttling failure", 421 try-again-later) and an
 * HTTP 429 from an HTTP sender. Such failures are re-queued without consuming
 * a retry attempt.
 */
export function isSendThrottled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    name?: unknown;
    responseCode?: unknown;
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (typeof e.name === 'string' && THROTTLE_ERROR_NAMES.has(e.name)) return true;
  if (e.responseCode === 454 || e.responseCode === 421) return true;
  return e.status === 429 || e.statusCode === 429 || e.$metadata?.httpStatusCode === 429;
}
