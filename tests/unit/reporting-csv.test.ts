import { describe, expect, it } from 'vitest';
import { toCsv } from '@/domains/reporting/csv';
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
});
