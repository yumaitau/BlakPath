import { describe, expect, it } from 'vitest';
import { toCsv } from '@/domains/reporting/csv';
import { REPORT_COLUMNS, REPORT_TYPES, isReportType } from '@/domains/reporting/reports';
import {
  exportRange,
  readStoredExportFilters,
  requestExportSchema,
} from '@/domains/reporting/schemas';

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

  it('prefixes cells that begin with a spreadsheet formula character', () => {
    const hyperlink = '=HYPERLINK("http://example.test/a","click")';
    const csv = toCsv(
      ['value'],
      [
        [hyperlink],
        ['=1+1'],
        ['+1+1'],
        ['-1+1'],
        ['@SUM(1)'],
        ['\tcmd'],
        ['\rcmd'],
        ['safe name'],
        [-2],
      ],
    );
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://example.test/a"",""click"")"`);
    expect(lines[1]).toContain("'=HYPERLINK(");
    expect(lines[2]).toBe("'=1+1");
    expect(lines[3]).toBe("'+1+1");
    expect(lines[4]).toBe("'-1+1");
    expect(lines[5]).toBe("'@SUM(1)");
    expect(lines[6]).toBe("'\tcmd");
    expect(lines[7]).toBe('"\'\rcmd"');
    expect(lines[8]).toBe('safe name');
    // Negative numbers stringify with a leading minus, so they are text too.
    expect(lines[9]).toBe("'-2");
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

  it('accepts a date range and application status, and rejects a reversed range', () => {
    const parsed = requestExportSchema.parse({
      type: 'applications',
      status: 'submitted',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(parsed.status).toBe('submitted');
    expect(
      requestExportSchema.safeParse({
        type: 'applications',
        from: '2026-02-01',
        to: '2026-01-01',
      }).success,
    ).toBe(false);
    expect(
      requestExportSchema.safeParse({ type: 'decisions', status: 'draft' }).success,
    ).toBe(false);
    expect(requestExportSchema.parse({ type: 'decisions', from: '', to: '' }).from).toBe(
      undefined,
    );
  });

  it('reads stored filters and expands calendar days to inclusive UTC bounds', () => {
    expect(readStoredExportFilters(null)).toEqual({});
    expect(
      readStoredExportFilters({ status: 'draft', from: '2026-03-01', to: '2026-03-02' }),
    ).toEqual({ status: 'draft', from: '2026-03-01', to: '2026-03-02' });
    expect(() => readStoredExportFilters({ from: 'March' })).toThrow(
      'Export filters are invalid',
    );
    const range = exportRange({ from: '2026-03-01', to: '2026-03-01' });
    expect(range.start?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(range.end?.toISOString()).toBe('2026-03-01T23:59:59.999Z');
  });
});
