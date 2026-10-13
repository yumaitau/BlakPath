import { describe, expect, it } from 'vitest';
import { emailQueueRateLimits, isSendThrottled } from '@/lib/email/rate-limit';

describe('emailQueueRateLimits', () => {
  it('keeps the two mail queues together beneath the sender quota', () => {
    for (const quota of [3, 5, 10, 14, 50, 200]) {
      const { email, notification } = emailQueueRateLimits(quota);
      expect(email.duration).toBe(1_000);
      expect(notification.duration).toBe(1_000);
      expect(email.max).toBeGreaterThanOrEqual(1);
      expect(notification.max).toBeGreaterThanOrEqual(1);
      // At least one send per second is left for synchronous auth mail.
      expect(email.max + notification.max).toBeLessThan(quota);
    }
  });

  it('never starves either queue at a tiny quota', () => {
    expect(emailQueueRateLimits(1)).toEqual({
      email: { max: 1, duration: 1_000 },
      notification: { max: 1, duration: 1_000 },
    });
  });
});

describe('isSendThrottled', () => {
  it('recognises SES API throttling errors', () => {
    expect(isSendThrottled({ name: 'TooManyRequestsException' })).toBe(true);
    expect(isSendThrottled({ name: 'ThrottlingException' })).toBe(true);
    expect(isSendThrottled({ name: 'Other', $metadata: { httpStatusCode: 429 } })).toBe(
      true,
    );
  });

  it('recognises SES SMTP throttling replies and HTTP 429', () => {
    expect(isSendThrottled({ responseCode: 454 })).toBe(true);
    expect(isSendThrottled({ responseCode: 421 })).toBe(true);
    expect(isSendThrottled({ status: 429 })).toBe(true);
    expect(isSendThrottled({ statusCode: 429 })).toBe(true);
  });

  it('does not treat other failures as throttling', () => {
    expect(isSendThrottled(new Error('boom'))).toBe(false);
    expect(isSendThrottled({ name: 'MessageRejected' })).toBe(false);
    expect(isSendThrottled({ responseCode: 550 })).toBe(false);
    expect(isSendThrottled({ status: 500 })).toBe(false);
    expect(isSendThrottled(null)).toBe(false);
    expect(isSendThrottled('throttled')).toBe(false);
  });
});
