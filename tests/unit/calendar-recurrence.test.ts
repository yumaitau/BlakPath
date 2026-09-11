import { describe, expect, it } from 'vitest';
import {
  expandOccurrences,
  formatExdates,
  overlaps,
  parseExdates,
  parseRrule,
} from '@/domains/calendar/recurrence';
import { buildIcs, parseIcs } from '@/lib/calendar/ics';

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

describe('overlaps', () => {  it('detects overlap and adjacency', () => {
    const a = new Date('2026-09-01T09:00:00Z');
    const b = new Date('2026-09-01T09:30:00Z');
    const c = new Date('2026-09-01T10:00:00Z');
    expect(overlaps(a, c, b, null)).toBe(true);
    expect(overlaps(a, b, c, null)).toBe(false);
  });
});

describe('exdates', () => {
  it('parses and formats exception lists symmetrically', () => {
    const stamps = [Date.UTC(2026, 8, 8, 9, 0, 0), Date.UTC(2026, 8, 15, 9, 0, 0)];
    const text = formatExdates(stamps);
    expect(text).toBe('20260908T090000Z,20260915T090000Z');
    expect(parseExdates(text)).toEqual(stamps);
    expect(parseExdates('garbage')).toEqual([]);
  });

  it('skips excepted occurrences during expansion', () => {
    const start = new Date('2026-09-01T09:00:00Z');
    const out = expandOccurrences({
      start,
      end: new Date('2026-09-01T10:00:00Z'),
      rrule: 'FREQ=WEEKLY;COUNT=3',
      exdate: '20260908T090000Z',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-10-01T00:00:00Z'),
    });
    expect(out.map((o) => o.start.toISOString())).toEqual([
      '2026-09-01T09:00:00.000Z',
      '2026-09-15T09:00:00.000Z',
    ]);
  });

  it('round-trips RRULE + EXDATE through ICS', () => {
    const ics = buildIcs({
      events: [
        {
          uid: 'r1@blakpath',
          start: new Date(Date.UTC(2026, 8, 1, 9, 0, 0)),
          summary: 'Weekly clinic',
          rrule: 'FREQ=WEEKLY;COUNT=4',
          exdates: [new Date(Date.UTC(2026, 8, 8, 9, 0, 0))],
        },
      ],
      now: new Date(Date.UTC(2026, 7, 1, 0, 0, 0)),
    });
    expect(ics).toContain('RRULE:FREQ=WEEKLY;COUNT=4');
    expect(ics).toContain('EXDATE:20260908T090000Z');
    const [parsed] = parseIcs(ics);
    expect(parsed?.rrule).toBe('FREQ=WEEKLY;COUNT=4');
    expect(parsed?.exdates).toEqual([new Date(Date.UTC(2026, 8, 8, 9, 0, 0))]);
  });
});
