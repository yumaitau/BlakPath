import { describe, expect, it } from 'vitest';
import { toCsv, toCsvLine } from '@/domains/reporting/csv';
import { REPORT_COLUMNS, REPORT_TYPES, isReportType } from '@/domains/reporting/reports';
import { requestExportSchema } from '@/domains/reporting/schemas';

describe('csv serialiser', () => {
  it('quotes cells with commas, quotes or newlines and doubles quotes', () => {
    const csv = toCsv(
      ['a', 'b', 'c'],
      [
        ['plain', 'has,comma', 'has "quote"'],
        ['line\nbreak', 1, null],
      ],
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('a,b,c');
    expect(lines[1]).toBe('plain,"has,comma","has ""quote"""');
    expect(lines[2]).toBe('"line\nbreak",1,');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('serialises dates as ISO and booleans as words; empty for nullish', () => {
    const csv = toCsv(
      ['d', 'b', 'n'],
      [[new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), true, undefined]],
    );
    expect(csv.split('\r\n')[1]).toBe('2026-01-02T03:04:05.000Z,true,');
  });
});

describe('report registry + schema', () => {
  it('defines columns for every report type', () => {
    for (const t of REPORT_TYPES) {
      expect(REPORT_COLUMNS[t].length).toBeGreaterThan(0);
    }
  });

  it('validates report types', () => {
    expect(isReportType('applications')).toBe(true);
    expect(isReportType('everything')).toBe(false);
    expect(requestExportSchema.safeParse({ type: 'decisions' }).success).toBe(true);
    expect(requestExportSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });
});

describe('streamed csv lines', () => {
  it('serialises a single line with its terminator, matching the document form', () => {
    expect(toCsvLine(['a', 'b,c', null])).toBe('a,"b,c",\r\n');
    expect(toCsv(['h'], [['x']])).toBe(toCsvLine(['h']) + toCsvLine(['x']));
  });
});
