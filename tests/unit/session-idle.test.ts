import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  IDLE_WARNING_MS,
  idleStatus,
  parseStoredActivity,
} from '@/lib/auth/idle';

const MINUTE = 60_000;
const TIMEOUT = 30 * MINUTE;

describe('idleStatus', () => {
  const last = 1_000_000;

  it('is active until the warning window', () => {
    expect(idleStatus(last, last, TIMEOUT)).toEqual({
      phase: 'active',
      remainingMs: TIMEOUT,
    });
    expect(idleStatus(last + TIMEOUT - IDLE_WARNING_MS - 1, last, TIMEOUT).phase).toBe(
      'active',
    );
  });

  it('warns in the final two minutes', () => {
    const status = idleStatus(last + TIMEOUT - IDLE_WARNING_MS, last, TIMEOUT);
    expect(status).toEqual({ phase: 'warning', remainingMs: IDLE_WARNING_MS });
    expect(idleStatus(last + TIMEOUT - 1, last, TIMEOUT).phase).toBe('warning');
  });

  it('expires at the timeout and stays expired', () => {
    expect(idleStatus(last + TIMEOUT, last, TIMEOUT)).toEqual({
      phase: 'expired',
      remainingMs: 0,
    });
    expect(idleStatus(last + 2 * TIMEOUT, last, TIMEOUT).remainingMs).toBe(0);
  });

  it('never warns for longer than the timeout itself', () => {
    expect(idleStatus(last, last, MINUTE).phase).toBe('warning');
  });
});

describe('formatCountdown', () => {
  it('renders minutes and zero-padded seconds, rounding up', () => {
    expect(formatCountdown(IDLE_WARNING_MS)).toBe('2:00');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(500)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-10)).toBe('0:00');
  });
});

describe('parseStoredActivity', () => {
  const now = 2_000_000;
  it('accepts a past timestamp', () => {
    expect(parseStoredActivity('1999000', now)).toBe(1_999_000);
  });
  it.each([null, '', 'abc', '-5', '0', String(now + 1)])('ignores %j', (raw) => {
    expect(parseStoredActivity(raw, now)).toBeNull();
  });
});
