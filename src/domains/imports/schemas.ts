import { z } from 'zod';
import { APPLICATION_STATUSES } from '@/domains/applications/workflow';
import type { Permission } from '@/lib/permissions/catalog';
import { CsvParseError, parseCsv } from './csv';

/**
 * Legacy import file format and validation — pure and testable.
 *
 * One CSV row is one legacy matter. Required columns: `external_reference`
 * (the matter's id in the previous system — the idempotency key) and
 * `applicant_name`. Optional columns carry the historical status and dates, a
 * previously RECORDED human outcome (with who recorded it), and a certificate
 * issued before BlakPath. Any `intake.<key>` column lands in the matter's
 * administrative intake fields. Unknown columns reject the file so a typo can
 * never silently drop data.
 *
 * PRODUCT INVARIANT: an outcome column copies a determination authorised humans
 * already made and recorded elsewhere — the file must say who recorded it.
 * Nothing here derives, scores or infers an outcome.
 */

/** Hard ceilings for one upload. Larger migrations split across files. */
export const IMPORT_MAX_ROWS = 10_000;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Cap on stored/returned row issues, so a bad file cannot bloat a job row. */
export const IMPORT_MAX_ISSUES = 1_000;

export const IMPORT_COLUMNS = [
  'external_reference',
  'applicant_name',
  'priority',
  'status',
  'submitted_on',
  'decided_on',
  'withdrawn_on',
  'withdrawn_reason',
  'closed_on',
  'outcome',
  'outcome_recorded_by',
  'outcome_note',
  'certificate_reference',
  'certificate_issued_on',
  'certificate_revoked_on',
  'certificate_revoked_reason',
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

const REQUIRED_COLUMNS: readonly ImportColumn[] = [
  'external_reference',
  'applicant_name',
];
const INTAKE_PREFIX = 'intake.';
const INTAKE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A raw CSV record keyed by (normalised) header. Values are untrimmed strings. */
export type ImportRecord = Record<string, string>;

/** A file-level problem (bad header, malformed CSV, too many rows). */
export class ImportFileError extends Error {
  readonly code = 'IMPORT_FILE_INVALID';
  constructor(readonly problems: readonly string[]) {
    super(problems.join(' '));
    this.name = 'ImportFileError';
  }
}

/**
 * Parse an uploaded CSV into header-keyed records. Throws {@link ImportFileError}
 * for anything that makes the file as a whole unusable.
 */
export function parseImportCsv(text: string): ImportRecord[] {
  if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) {
    throw new ImportFileError([
      `The file is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB. Split it into smaller files.`,
    ]);
  }
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (error) {
    throw new ImportFileError([
      error instanceof CsvParseError ? error.message : 'The file is not valid CSV.',
    ]);
  }
  const [header, ...body] = table;
  if (!header) throw new ImportFileError(['The file is empty.']);

  const columns = header.map((h) => {
    const name = h.trim();
    return name.toLowerCase().startsWith(INTAKE_PREFIX)
      ? `${INTAKE_PREFIX}${name.slice(INTAKE_PREFIX.length)}`
      : name.toLowerCase();
  });
  const problems: string[] = [];
  const known = new Set<string>(IMPORT_COLUMNS);
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column)) problems.push(`Column "${column}" appears more than once.`);
    seen.add(column);
    if (column.startsWith(INTAKE_PREFIX)) {
      if (!INTAKE_KEY.test(column.slice(INTAKE_PREFIX.length))) {
        problems.push(
          `Intake column "${column}" must be "intake." followed by letters, digits or underscores.`,
        );
      }
    } else if (!known.has(column)) {
      problems.push(`Unknown column "${column}".`);
    }
  }
  for (const required of REQUIRED_COLUMNS) {
    if (!seen.has(required)) problems.push(`Missing required column "${required}".`);
  }
  if (body.length === 0) problems.push('The file has a header but no rows.');
  if (body.length > IMPORT_MAX_ROWS) {
    problems.push(
      `The file has ${body.length} rows; the limit is ${IMPORT_MAX_ROWS}. Split it into smaller files.`,
    );
  }
  if (problems.length > 0) throw new ImportFileError(problems);

  return body.map((cells) => {
    const record: ImportRecord = {};
    columns.forEach((column, i) => {
      record[column] = cells[i] ?? '';
    });
    return record;
  });
}

/** Blank cells mean "not provided". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const text = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.preprocess(
  blankToUndefined,
  z.iso
    .date({ message: 'Dates must be written as YYYY-MM-DD.' })
    .transform((value) => new Date(`${value}T00:00:00.000Z`))
    .optional(),
);
const lowerEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((value) => {
    const v = blankToUndefined(value);
    return typeof v === 'string' ? v.trim().toLowerCase() : v;
  }, z.enum(values).optional());

export const DECISION_OUTCOMES = ['confirmed', 'not_confirmed', 'deferred'] as const;
const OUTCOME_STATUSES = new Set(['decided', 'closed']);

/** One legacy matter row, after validation. */
export const importRowSchema = z
  .object({
    external_reference: requiredText(100),
    applicant_name: requiredText(200),
    priority: lowerEnum(['low', 'normal', 'high'] as const),
    status: lowerEnum(APPLICATION_STATUSES),
    submitted_on: isoDate,
    decided_on: isoDate,
    withdrawn_on: isoDate,
    withdrawn_reason: text(2000),
    closed_on: isoDate,
    outcome: lowerEnum(DECISION_OUTCOMES),
    outcome_recorded_by: text(200),
    outcome_note: text(5000),
    certificate_reference: text(100),
    certificate_issued_on: isoDate,
    certificate_revoked_on: isoDate,
    certificate_revoked_reason: text(2000),
  })
  .superRefine((row, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const status = row.status ?? 'draft';
    const now = Date.now();
    for (const key of [
      'submitted_on',
      'decided_on',
      'withdrawn_on',
      'closed_on',
      'certificate_issued_on',
      'certificate_revoked_on',
    ] as const) {
      const value = row[key];
      if (value && value.getTime() > now) fail(`${key} cannot be in the future.`);
    }

    if (row.outcome) {
      if (!OUTCOME_STATUSES.has(status)) {
        fail('A recorded outcome needs status "decided" or "closed".');
      }
      if (!row.decided_on) fail('A recorded outcome needs decided_on.');
      if (!row.outcome_recorded_by) {
        fail(
          'A recorded outcome needs outcome_recorded_by (who recorded it before BlakPath).',
        );
      }
    } else if (row.outcome_recorded_by || row.outcome_note) {
      fail('outcome_recorded_by and outcome_note need an outcome.');
    }

    const hasCertificateDetail =
      row.certificate_issued_on ||
      row.certificate_revoked_on ||
      row.certificate_revoked_reason;
    if (row.certificate_reference) {
      if (row.outcome !== 'confirmed') {
        fail('A legacy certificate needs a recorded outcome of "confirmed".');
      }
      if (!row.certificate_issued_on)
        fail('A legacy certificate needs certificate_issued_on.');
      if (row.certificate_revoked_on && !row.certificate_revoked_reason) {
        fail('A revoked legacy certificate needs certificate_revoked_reason.');
      }
      if (!row.certificate_revoked_on && row.certificate_revoked_reason) {
        fail('certificate_revoked_reason needs certificate_revoked_on.');
      }
    } else if (hasCertificateDetail) {
      fail('Certificate columns need certificate_reference.');
    }
  });

/** A validated legacy matter, in service-friendly shape. */
export interface LegacyImportRow {
  externalReference: string;
  applicantName: string;
  priority: 'low' | 'normal' | 'high';
  status: (typeof APPLICATION_STATUSES)[number];
  submittedAt: Date | null;
  decidedAt: Date | null;
  withdrawnAt: Date | null;
  withdrawnReason: string | null;
  closedAt: Date | null;
  intake: Record<string, string> | null;
  outcome: {
    finalOutcome: (typeof DECISION_OUTCOMES)[number];
    decidedAt: Date;
    recordedBy: string;
    note: string | null;
  } | null;
  certificate: {
    reference: string;
    issuedAt: Date;
    revokedAt: Date | null;
    revokedReason: string | null;
  } | null;
}

/** Validate one raw record. Returns the typed row or a plain error message. */
export function validateImportRecord(
  record: ImportRecord,
): { ok: true; row: LegacyImportRow } | { ok: false; error: string } {
  const parsed = importRowSchema.safeParse(record);
  if (!parsed.success) {
    // Messages name columns and rules only — never echo the cell values.
    const error = parsed.error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
      )
      .join('; ');
    return { ok: false, error };
  }
  const r = parsed.data;
  const intakeEntries = Object.entries(record)
    .filter(([key, value]) => key.startsWith(INTAKE_PREFIX) && value.trim() !== '')
    .map(([key, value]) => [key.slice(INTAKE_PREFIX.length), value.trim()] as const);
  return {
    ok: true,
    row: {
      externalReference: r.external_reference,
      applicantName: r.applicant_name,
      priority: r.priority ?? 'normal',
      status: r.status ?? 'draft',
      submittedAt: r.submitted_on ?? null,
      decidedAt: r.decided_on ?? null,
      withdrawnAt: r.withdrawn_on ?? null,
      withdrawnReason: r.withdrawn_reason ?? null,
      closedAt: r.closed_on ?? null,
      intake: intakeEntries.length > 0 ? Object.fromEntries(intakeEntries) : null,
      outcome:
        r.outcome && r.decided_on && r.outcome_recorded_by
          ? {
              finalOutcome: r.outcome,
              decidedAt: r.decided_on,
              recordedBy: r.outcome_recorded_by,
              note: r.outcome_note ?? null,
            }
          : null,
      certificate:
        r.certificate_reference && r.certificate_issued_on
          ? {
              reference: r.certificate_reference,
              issuedAt: r.certificate_issued_on,
              revokedAt: r.certificate_revoked_on ?? null,
              revokedReason: r.certificate_revoked_reason ?? null,
            }
          : null,
    },
  };
}

/** One row-level problem. `row` is the spreadsheet row number (header = 1). */
export interface ImportIssue {
  row: number;
  externalReference?: string;
  error: string;
}

/** Spreadsheet row number for a zero-based data record index. */
export function rowNumber(index: number): number {
  return index + 2;
}

/** Dry-run validation report for a file, before anything is written. */
export interface ImportValidationReport {
  total: number;
  /** Rows that would create a new matter. */
  importable: number;
  /** Rows whose external reference is already in BlakPath (skipped on import). */
  duplicates: number;
  invalid: number;
  withOutcome: number;
  withCertificate: number;
  issues: ImportIssue[];
  /** Permissions the requester lacks for the contents of this file. */
  missingPermissions: string[];
}

/**
 * Classify every record for a dry run. Pure: the caller supplies the external
 * and certificate references already present in the organisation.
 */
export function buildValidationReport(
  records: readonly ImportRecord[],
  existing: {
    externalReferences: ReadonlySet<string>;
    certificateReferences: ReadonlySet<string>;
  },
): Omit<ImportValidationReport, 'missingPermissions'> {
  const issues: ImportIssue[] = [];
  const seenRefs = new Set<string>();
  const seenCerts = new Set<string>();
  let importable = 0;
  let duplicates = 0;
  let invalid = 0;
  let withOutcome = 0;
  let withCertificate = 0;

  const addIssue = (issue: ImportIssue) => {
    if (issues.length < IMPORT_MAX_ISSUES) issues.push(issue);
  };

  records.forEach((record, index) => {
    const row = rowNumber(index);
    const result = validateImportRecord(record);
    if (!result.ok) {
      invalid += 1;
      const ref = record.external_reference?.trim();
      addIssue({ row, ...(ref ? { externalReference: ref } : {}), error: result.error });
      return;
    }
    const { externalReference, certificate, outcome } = result.row;
    if (seenRefs.has(externalReference)) {
      invalid += 1;
      addIssue({
        row,
        externalReference,
        error: 'external_reference appears earlier in this file.',
      });
      return;
    }
    seenRefs.add(externalReference);
    if (existing.externalReferences.has(externalReference)) {
      // Counted, not listed: re-checking a re-run file would otherwise drown
      // the real problems in thousands of "already imported" lines.
      duplicates += 1;
      return;
    }
    if (certificate) {
      if (seenCerts.has(certificate.reference)) {
        invalid += 1;
        addIssue({
          row,
          externalReference,
          error: 'certificate_reference appears earlier in this file.',
        });
        return;
      }
      seenCerts.add(certificate.reference);
      if (existing.certificateReferences.has(certificate.reference)) {
        invalid += 1;
        addIssue({
          row,
          externalReference,
          error: 'certificate_reference already exists in this organisation.',
        });
        return;
      }
    }
    importable += 1;
    if (outcome) withOutcome += 1;
    if (certificate) withCertificate += 1;
  });

  return {
    total: records.length,
    importable,
    duplicates,
    invalid,
    withOutcome,
    withCertificate,
    issues,
  };
}

/** Does any record (valid or not) carry an outcome / certificate column value? */
export function fileContents(records: readonly ImportRecord[]): {
  includesOutcomes: boolean;
  includesCertificates: boolean;
} {
  const has = (key: ImportColumn) => records.some((r) => (r[key] ?? '').trim() !== '');
  return {
    includesOutcomes: has('outcome'),
    includesCertificates: has('certificate_reference'),
  };
}

/** Request body for the import endpoint. */
export const importRequestSchema = z.object({
  csv: z.string().min(1),
  fileName: z.string().trim().max(255).optional(),
  dryRun: z.boolean().optional(),
});
export type ImportRequestInput = z.input<typeof importRequestSchema>;

/**
 * Permissions an import needs, by what the file carries. Bringing in matters is
 * intake work (and reveals every imported matter, hence read-any). Copying a
 * previously recorded outcome or certificate is authority-bearing, so it needs
 * the same permission as recording or signing one in BlakPath — separation of
 * duties holds for migrations too.
 */
export function requiredImportPermissions(contents: {
  includesOutcomes: boolean;
  includesCertificates: boolean;
}): Permission[] {
  const keys: Permission[] = ['application:create', 'application:read-any'];
  if (contents.includesOutcomes) keys.push('decision:finalise');
  if (contents.includesCertificates) keys.push('certificate:sign');
  return keys;
}
