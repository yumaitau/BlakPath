import { describe, expect, it } from 'vitest';
import { CsvParseError, parseCsv } from '@/domains/imports/csv';
import {
  IMPORT_MAX_ISSUES,
  IMPORT_MAX_ROWS,
  ImportFileError,
  buildValidationReport,
  fileContents,
  parseImportCsv,
  requiredImportPermissions,
  validateImportRecord,
  type ImportRecord,
} from '@/domains/imports/schemas';

const none = {
  externalReferences: new Set<string>(),
  certificateReferences: new Set<string>(),
};

function record(overrides: Record<string, string> = {}): ImportRecord {
  return { external_reference: 'LEG-1', applicant_name: 'Test Applicant', ...overrides };
}

const decided = {
  status: 'decided',
  decided_on: '2019-03-04',
  outcome: 'confirmed',
  outcome_recorded_by: 'Confirmation committee, meeting 2019-03-04',
};

describe('csv parser', () => {
  it('handles quotes, embedded commas/newlines, CRLF, BOM and blank lines', () => {
    const text = '﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\nplain,\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
      ['plain', ''],
    ]);
  });

  it('rejects malformed quoting instead of guessing', () => {
    expect(() => parseCsv('a\n"unterminated')).toThrow(CsvParseError);
    expect(() => parseCsv('a\nbad"quote')).toThrow(CsvParseError);
  });
});

describe('import file header', () => {
  it('maps rows to header keys, normalising case and intake columns', () => {
    const records = parseImportCsv(
      'External_Reference,applicant_name,Intake.PreferredName\nLEG-1,Test,Sam\n',
    );
    expect(records).toEqual([
      {
        external_reference: 'LEG-1',
        applicant_name: 'Test',
        'intake.PreferredName': 'Sam',
      },
    ]);
  });

  it('rejects unknown, duplicate and missing columns as a whole-file problem', () => {
    try {
      parseImportCsv('external_reference,externl_typo,external_reference\nA,B,C\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImportFileError);
      const problems = (error as ImportFileError).problems.join(' ');
      expect(problems).toContain('Unknown column "externl_typo"');
      expect(problems).toContain('appears more than once');
      expect(problems).toContain('Missing required column "applicant_name"');
    }
  });

  it('rejects empty files and files over the row limit', () => {
    expect(() => parseImportCsv('')).toThrow(ImportFileError);
    expect(() => parseImportCsv('external_reference,applicant_name\n')).toThrow(
      ImportFileError,
    );
    const rows = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `R${i},N`);
    expect(() =>
      parseImportCsv(`external_reference,applicant_name\n${rows.join('\n')}`),
    ).toThrow(/limit is/);
  });
});

describe('row validation', () => {
  it('accepts a minimal row as a draft with normal priority', () => {
    const result = validateImportRecord(record());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row).toMatchObject({
      externalReference: 'LEG-1',
      status: 'draft',
      priority: 'normal',
      outcome: null,
      certificate: null,
      intake: null,
    });
  });

  it('keeps historical status, dates and intake fields', () => {
    const result = validateImportRecord(
      record({
        status: 'Withdrawn',
        submitted_on: '2018-01-02',
        withdrawn_on: '2018-05-06',
        withdrawn_reason: 'Applicant request',
        'intake.region': ' North ',
        'intake.empty': '',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.status).toBe('withdrawn');
    expect(result.row.submittedAt?.toISOString()).toBe('2018-01-02T00:00:00.000Z');
    expect(result.row.withdrawnReason).toBe('Applicant request');
    expect(result.row.intake).toEqual({ region: 'North' });
  });

  it('imports a recorded outcome only with who recorded it, a decision date and a decided status', () => {
    const ok = validateImportRecord(record(decided));
    expect(ok.ok && ok.row.outcome).toMatchObject({
      finalOutcome: 'confirmed',
      recordedBy: decided.outcome_recorded_by,
    });

    const noRecorder = validateImportRecord(
      record({ ...decided, outcome_recorded_by: '' }),
    );
    expect(noRecorder.ok).toBe(false);
    expect(!noRecorder.ok && noRecorder.error).toContain('outcome_recorded_by');

    const wrongStatus = validateImportRecord(record({ ...decided, status: 'in_review' }));
    expect(!wrongStatus.ok && wrongStatus.error).toContain('"decided" or "closed"');

    const noDate = validateImportRecord(record({ ...decided, decided_on: '' }));
    expect(noDate.ok).toBe(false);

    const orphanNote = validateImportRecord(record({ outcome_note: 'note' }));
    expect(orphanNote.ok).toBe(false);
  });

  it('imports a legacy certificate only from a confirmed recorded outcome', () => {
    const cert = {
      certificate_reference: 'COA-0042',
      certificate_issued_on: '2019-03-10',
    };
    const ok = validateImportRecord(record({ ...decided, ...cert }));
    expect(ok.ok && ok.row.certificate).toMatchObject({
      reference: 'COA-0042',
      revokedAt: null,
    });

    const notConfirmed = validateImportRecord(
      record({ ...decided, outcome: 'not_confirmed', ...cert }),
    );
    expect(!notConfirmed.ok && notConfirmed.error).toContain('confirmed');

    const noOutcome = validateImportRecord(record(cert));
    expect(noOutcome.ok).toBe(false);

    const revokedNoReason = validateImportRecord(
      record({ ...decided, ...cert, certificate_revoked_on: '2020-01-01' }),
    );
    expect(!revokedNoReason.ok && revokedNoReason.error).toContain(
      'certificate_revoked_reason',
    );

    const detailWithoutRef = validateImportRecord(
      record({ ...decided, certificate_issued_on: '2019-03-10' }),
    );
    expect(detailWithoutRef.ok).toBe(false);
  });

  it('rejects bad enums, malformed or future dates, and never echoes cell values', () => {
    const result = validateImportRecord(
      record({
        status: 'approved-by-algorithm',
        submitted_on: '04/03/2019',
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('status');
    expect(result.error).toContain('YYYY-MM-DD');
    expect(result.error).not.toContain('approved-by-algorithm');

    const future = validateImportRecord(record({ closed_on: '2999-01-01' }));
    expect(!future.ok && future.error).toContain('cannot be in the future');
  });
});

describe('dry-run report', () => {
  it('counts importable, already-imported, invalid and in-file duplicates', () => {
    const records = [
      record({ external_reference: 'A' }),
      record({ external_reference: 'B' }),
      record({ external_reference: 'A' }),
      record({ external_reference: 'C', applicant_name: '' }),
      record({
        external_reference: 'D',
        ...decided,
        certificate_reference: 'COA-1',
        certificate_issued_on: '2019-03-10',
      }),
      record({
        external_reference: 'E',
        ...decided,
        certificate_reference: 'COA-EXISTS',
        certificate_issued_on: '2019-03-10',
      }),
    ];
    const report = buildValidationReport(records, {
      externalReferences: new Set(['B']),
      certificateReferences: new Set(['COA-EXISTS']),
    });
    expect(report).toMatchObject({
      total: 6,
      importable: 2,
      duplicates: 1,
      invalid: 3,
      withOutcome: 1,
      withCertificate: 1,
    });
    expect(report.issues.map((i) => i.row)).toEqual([4, 5, 7]);
    expect(report.issues[0]?.error).toContain('appears earlier');
    expect(report.issues[2]?.error).toContain('already exists');
  });

  it('caps the issue list', () => {
    const records = Array.from({ length: IMPORT_MAX_ISSUES + 50 }, (_, i) =>
      record({ external_reference: `X${i}`, applicant_name: '' }),
    );
    const report = buildValidationReport(records, none);
    expect(report.invalid).toBe(IMPORT_MAX_ISSUES + 50);
    expect(report.issues).toHaveLength(IMPORT_MAX_ISSUES);
  });

  it('validates a 5,000-row file quickly', () => {
    const header = 'external_reference,applicant_name,status,submitted_on';
    const lines = Array.from(
      { length: 5_000 },
      (_, i) => `LEG-${i},Applicant ${i},submitted,2020-01-01`,
    );
    const started = performance.now();
    const records = parseImportCsv(`${header}\n${lines.join('\n')}\n`);
    const report = buildValidationReport(records, none);
    expect(report.importable).toBe(5_000);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('import permissions (separation of duties)', () => {
  it('needs intake permissions, plus finalise/sign for outcomes/certificates', () => {
    expect(
      requiredImportPermissions({ includesOutcomes: false, includesCertificates: false }),
    ).toEqual(['application:create', 'application:read-any']);
    expect(
      requiredImportPermissions({ includesOutcomes: true, includesCertificates: true }),
    ).toEqual([
      'application:create',
      'application:read-any',
      'decision:finalise',
      'certificate:sign',
    ]);
  });

  it('detects outcome/certificate content even on invalid rows', () => {
    expect(fileContents([record(), record({ outcome: 'confirmed' })])).toEqual({
      includesOutcomes: true,
      includesCertificates: false,
    });
    expect(fileContents([record({ certificate_reference: 'X' })])).toEqual({
      includesOutcomes: false,
      includesCertificates: true,
    });
  });
});
