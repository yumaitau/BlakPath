import { createHash } from 'node:crypto';
import { desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { applications, certificates, importJobs } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { hasPermission, requireAll, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { addJob, QueueName } from '@/lib/queues';
import {
  buildValidationReport,
  fileContents,
  importRequestSchema,
  parseImportCsv,
  requiredImportPermissions,
  type ImportIssue,
  type ImportRecord,
  type ImportValidationReport,
} from './schemas';

/**
 * Legacy import — request side (tenant-scoped, permission-checked, audited).
 *
 * `validateImport` is the dry run: it parses and validates the whole file,
 * checks which legacy references are already in BlakPath, and reports — it
 * writes nothing but an audit event. `requestImport` stages the file and
 * enqueues the Import worker job, which does the writes in chunks with
 * progress (see process.ts). Re-submitting the same file while a job for it is
 * still running returns that job instead of starting another.
 */

/** Import job as shown to staff — never includes the staged applicant rows. */
export interface ImportJobView {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  fileName: string | null;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  skippedCount: number;
  failedCount: number;
  includesOutcomes: boolean;
  includesCertificates: boolean;
  issues: ImportIssue[];
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

const jobViewColumns = {
  id: importJobs.id,
  status: importJobs.status,
  fileName: importJobs.fileName,
  totalRows: importJobs.totalRows,
  processedRows: importJobs.processedRows,
  createdCount: importJobs.createdCount,
  skippedCount: importJobs.skippedCount,
  failedCount: importJobs.failedCount,
  includesOutcomes: importJobs.includesOutcomes,
  includesCertificates: importJobs.includesCertificates,
  issues: importJobs.issues,
  error: importJobs.error,
  createdAt: importJobs.createdAt,
  startedAt: importJobs.startedAt,
  completedAt: importJobs.completedAt,
};

type JobViewRow = Omit<ImportJobView, 'issues'> & { issues: unknown };

function toView(row: JobViewRow): ImportJobView {
  return {
    ...row,
    issues: Array.isArray(row.issues) ? (row.issues as ImportIssue[]) : [],
  };
}

/** Base gate for any import screen: intake staff who may see every matter. */
const IMPORT_BASE_PERMISSIONS = requiredImportPermissions({
  includesOutcomes: false,
  includesCertificates: false,
});

/** Look up which of these references already exist in the organisation. */
async function existingReferences(records: readonly ImportRecord[]): Promise<{
  externalReferences: Set<string>;
  certificateReferences: Set<string>;
}> {
  const scope = currentScope();
  const refs = [
    ...new Set(records.map((r) => (r.external_reference ?? '').trim()).filter(Boolean)),
  ];
  const certRefs = [
    ...new Set(
      records.map((r) => (r.certificate_reference ?? '').trim()).filter(Boolean),
    ),
  ];
  const externalReferences = new Set<string>();
  const certificateReferences = new Set<string>();
  const CHUNK = 1_000;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const rows = await scope.db
      .select({ ref: applications.externalReference })
      .from(applications)
      .where(
        scope.where(
          applications.organisationId,
          isNotNull(applications.externalReference),
          inArray(applications.externalReference, refs.slice(i, i + CHUNK)),
        ),
      );
    for (const row of rows) if (row.ref) externalReferences.add(row.ref);
  }
  for (let i = 0; i < certRefs.length; i += CHUNK) {
    const rows = await scope.db
      .select({ ref: certificates.reference })
      .from(certificates)
      .where(
        scope.where(
          certificates.organisationId,
          inArray(certificates.reference, certRefs.slice(i, i + CHUNK)),
        ),
      );
    for (const row of rows) certificateReferences.add(row.ref);
  }
  return { externalReferences, certificateReferences };
}

/**
 * Dry run: validate the whole file and report what an import would do. Writes
 * nothing except an audit event. Throws `ImportFileError` for a file that is
 * unusable as a whole (bad header, malformed CSV, too many rows).
 */
export async function validateImport(raw: unknown): Promise<ImportValidationReport> {
  const ctx = requireTenantContext();
  const subject = subjectFromContext(ctx);
  requireAll(subject, IMPORT_BASE_PERMISSIONS);

  const input = importRequestSchema.parse(raw);
  const records = parseImportCsv(input.csv);
  const report = buildValidationReport(records, await existingReferences(records));
  const missingPermissions = requiredImportPermissions(fileContents(records)).filter(
    (key) => !hasPermission(subject, key),
  );

  await recordAudit({
    action: 'import.validated',
    resourceType: 'import',
    resourceId: null,
    result: 'success',
    after: {
      data: {
        total: report.total,
        importable: report.importable,
        duplicates: report.duplicates,
        invalid: report.invalid,
      },
      allow: ['total', 'importable', 'duplicates', 'invalid'],
    },
  });

  return { ...report, missingPermissions };
}

/**
 * Commit: stage the file and enqueue the Import worker job. Requires the
 * permissions the file's contents call for (see `requiredImportPermissions`);
 * the worker re-checks them against the requester's live membership.
 */
export async function requestImport(raw: unknown): Promise<ImportJobView> {
  const ctx = requireTenantContext();
  const subject = subjectFromContext(ctx);
  requireAll(subject, IMPORT_BASE_PERMISSIONS);

  const input = importRequestSchema.parse(raw);
  const records = parseImportCsv(input.csv);
  const contents = fileContents(records);
  try {
    requireAll(subject, requiredImportPermissions(contents));
  } catch (error) {
    await recordAudit({
      action: 'import.requested',
      resourceType: 'import',
      resourceId: null,
      result: 'denied',
      reason: 'file carries outcomes or certificates the requester may not record',
    });
    throw error;
  }

  const scope = currentScope();
  const fileSha256 = createHash('sha256').update(input.csv, 'utf8').digest('hex');

  // A double-submitted file joins the job already running for it.
  const [inFlight] = await scope.db
    .select(jobViewColumns)
    .from(importJobs)
    .where(
      scope.where(
        importJobs.organisationId,
        eq(importJobs.fileSha256, fileSha256),
        inArray(importJobs.status, ['pending', 'processing']),
      ),
    )
    .limit(1);
  if (inFlight) return toView(inFlight);

  const [job] = await scope.db
    .insert(importJobs)
    .values(
      scope.insertValues({
        requestedByUserId: ctx.userId,
        requestedSessionId: ctx.sessionId,
        kind: 'applications',
        fileName: input.fileName ?? null,
        fileSha256,
        status: 'pending' as const,
        totalRows: records.length,
        includesOutcomes: contents.includesOutcomes,
        includesCertificates: contents.includesCertificates,
        stagedRows: records,
      }),
    )
    .returning(jobViewColumns);
  if (!job) throw new Error('Expected import job to be returned.');

  await addJob(
    QueueName.Import,
    'import-applications',
    {
      organisationId: scope.organisationId,
      correlationId: ctx.correlationId,
      importJobId: job.id,
    },
    { jobId: job.id },
  );

  await recordAudit({
    action: 'import.requested',
    resourceType: 'import',
    resourceId: job.id,
    result: 'success',
    after: {
      data: { totalRows: records.length, ...contents },
      allow: ['totalRows', 'includesOutcomes', 'includesCertificates'],
    },
  });

  return toView(job);
}

/** Recent import jobs for the organisation (newest first). */
export async function listImports(limit = 20): Promise<ImportJobView[]> {
  const ctx = requireTenantContext();
  requireAll(subjectFromContext(ctx), IMPORT_BASE_PERMISSIONS);
  const scope = currentScope();
  const rows = await scope.db
    .select(jobViewColumns)
    .from(importJobs)
    .where(scope.where(importJobs.organisationId))
    .orderBy(desc(importJobs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(toView);
}

/** One import job's progress and report. */
export async function getImport(id: string): Promise<ImportJobView> {
  const ctx = requireTenantContext();
  requireAll(subjectFromContext(ctx), IMPORT_BASE_PERMISSIONS);
  const importId = z.uuid().parse(id);
  const scope = currentScope();
  const [row] = await scope.db
    .select(jobViewColumns)
    .from(importJobs)
    .where(scope.where(importJobs.organisationId, eq(importJobs.id, importId)))
    .limit(1);
  if (!row) throw new AuthorizationError('POLICY_DENIED');
  return toView(row);
}
