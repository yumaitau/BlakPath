import { describe, expect, it } from 'vitest';
import { formatEventTime } from '@/domains/calendar/format';

describe('formatEventTime', () => {
  const at = new Date('2026-10-14T22:30:00Z');

  it('formats in the event zone with its abbreviation, not raw UTC', () => {
    expect(formatEventTime(at, 'Australia/Sydney')).toBe(
      'Thursday 15 October 2026 at 9:30 am AEDT',
    );
    expect(formatEventTime(at, 'Australia/Perth')).toBe(
      'Thursday 15 October 2026 at 6:30 am AWST',
    );
    expect(formatEventTime(at, 'Australia/Sydney')).not.toContain('2026-10-14T');
  });

  it('falls back to the platform default for a missing or invalid zone', () => {
    const fallback = 'Thursday 15 October 2026 at 9:30 am AEDT';
    expect(formatEventTime(at, null)).toBe(fallback);
    expect(formatEventTime(at, '')).toBe(fallback);
    expect(formatEventTime(at, 'Not/AZone')).toBe(fallback);
  });
});
