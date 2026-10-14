import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_BACKOFF_TYPE,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_SCHEDULE_MS,
  webhookAttemptOffsetMs,
  webhookBackoffStrategy,
  webhookJobOptions,
  webhookRetryDelayMs,
} from '@/domains/webhooks/retry';

const HOUR = 3_600_000;

describe('webhook retry schedule', () => {
  it('backs off over hours rather than seconds', () => {
    expect(webhookRetryDelayMs(1)).toBe(30_000);
    expect(webhookRetryDelayMs(2)).toBe(120_000);
    expect(webhookRetryDelayMs(WEBHOOK_RETRY_SCHEDULE_MS.length)).toBe(8 * HOUR);
    // Beyond the schedule the last delay repeats; nonsense input clamps.
    expect(webhookRetryDelayMs(99)).toBe(8 * HOUR);
    expect(webhookRetryDelayMs(0)).toBe(30_000);
  });

  it('keeps retrying after a receiver has been down for an hour', () => {
    // Find the first attempt made after a 1h outage; it must be within the cap.
    const attempt = Array.from({ length: WEBHOOK_MAX_ATTEMPTS }, (_, i) => i + 1).find(
      (n) => webhookAttemptOffsetMs(n) >= HOUR,
    );
    expect(attempt).toBeDefined();
    expect(attempt).toBeLessThan(WEBHOOK_MAX_ATTEMPTS);
    // The whole retry window spans most of a day.
    expect(webhookAttemptOffsetMs(WEBHOOK_MAX_ATTEMPTS)).toBeGreaterThan(12 * HOUR);
  });

  it('only applies to jobs tagged with the webhook backoff type', () => {
    expect(webhookBackoffStrategy(3, WEBHOOK_BACKOFF_TYPE)).toBe(webhookRetryDelayMs(3));
    expect(webhookBackoffStrategy(3, 'exponential')).toBe(-1);
    expect(webhookBackoffStrategy(3)).toBe(-1);
  });

  it('keys jobs by delivery id with the webhook attempt budget', () => {
    expect(webhookJobOptions('delivery-1')).toEqual({
      jobId: 'delivery-1',
      attempts: WEBHOOK_MAX_ATTEMPTS,
      backoff: { type: WEBHOOK_BACKOFF_TYPE },
    });
  });
});
