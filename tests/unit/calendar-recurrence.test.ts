import { describe, expect, it } from 'vitest';
import { expandOccurrences, overlaps, parseRrule } from '@/domains/calendar/recurrence';

describe('parseRrule', () => {
  it('parses weekly count', () => {
    expect(parseRrule('FREQ=WEEKLY;COUNT=4')).toEqual({ freq: 'WEEKLY', count: 4 });
  });
  it('rejects unsupported freq', () => {
    expect(parseRrule('FREQ=MONTHLY;COUNT=4')).toBeNull();
  });
});

describe('expandOccurrences', () => {
  it('expands weekly count within range', () => {
    const start = new Date('2026-09-01T09:00:00Z');
    const out = expandOccurrences({
      start,
      end: new Date('2026-09-01T10:00:00Z'),
      rrule: 'FREQ=WEEKLY;COUNT=3',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-10-01T00:00:00Z'),
    });
    expect(out).toHaveLength(3);
    expect(out[1]?.start.toISOString()).toBe('2026-09-08T09:00:00.000Z');
  });
  it('returns single outside recurrence', () => {
    const start = new Date('2026-09-01T09:00:00Z');
    const out = expandOccurrences({
      start,
      end: null,
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-11-01T00:00:00Z'),
    });
    expect(out).toHaveLength(0);
  });
});

describe('overlaps', () => {
  it('detects overlap and adjacency', () => {
    const a = new Date('2026-09-01T09:00:00Z');
    const b = new Date('2026-09-01T09:30:00Z');
    const c = new Date('2026-09-01T10:00:00Z');
    expect(overlaps(a, c, b, null)).toBe(true);
    expect(overlaps(a, b, c, null)).toBe(false);
  });
});
