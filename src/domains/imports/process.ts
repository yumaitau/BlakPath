import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db/client';
import {
  applications,
  applicationStatusHistory,
  certificates,
  decisions,
  importJobs,
} from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { makeApplicationReference } from '@/domains/applications/service';
import { generateVerificationCode } from '@/domains/certificates/status';
import { requireAll, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError, isAuthorizationError } from '@/lib/permissions/errors';
import {
  runWithTenantContext,
  TenantContextError,
  type TenantContext,
} from '@/lib/tenancy/context';
import { resolveTenantContext } from '@/lib/tenancy/resolve';
import {
  IMPORT_MAX_ISSUES,
  requiredImportPermissions,
  rowNumber,
  validateImportRecord,
  type ImportIssue,
  type ImportRecord,
  type LegacyImportRow,
} from './schemas';

/**
 * Legacy import — worker side.
 *
 * Runs the staged rows of one import job in chunks, AS the person who requested
 * it: their membership and permissions are re-verified against the database
 * when the job starts, so a revoked or demoted requester cannot have an import
 * finish on their behalf. Each row commits atomically (matter, status history,
 * recorded outcome, legacy certificate) and is individually audited.
 *
 * Idempotency: matters are keyed on `(organisation_id, external_reference)`.
 * A row whose reference already exists is skipped, so re-running a file — or a
 * BullMQ retry resuming mid-file from `processed_rows` — never duplicates.
 *
 * PRODUCT INVARIANT: imported outcomes and certificates are copies of human acts
 * recorded before BlakPath, flagged as such. Nothing here decides anything.
 */

export const IMPORT_CHUNK_SIZE = 250;

export interface ProcessImportInput {
  organisationId: string;
  correlationId: string;
  importJobId: string;
  /** True on the last BullMQ attempt: a transient failure then fails the job. */
  finalAttempt?: boolean;
  /** Progress callback (0–100), e.g. BullMQ `job.updateProgress`. */
  onProgress?: (percent: number) => Promise<void> | void;
  chunkSize?: number;
}

type ImportJobRow = typeof importJobs.$inferSelect;
type Scope = ReturnType<typeof scopeFor>;

type RowOutcome =
  | { kind: 'created' }
  | { kind: 'skipped' }
  | { kind: 'failed'; issue: ImportIssue };

/** Pull a Postgres error code/constraint out of a (possibly wrapped) error. */
function pgError(error: unknown): { code: string; constraint?: string } | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint_name === 'string'
          ? { constraint: candidate.constraint_name }
          : {}),
      };
    }
    current = candidate.cause;
  }
  return null;
}

/** Insert one legacy matter and its recorded history in a single transaction. */
async function insertLegacyMatter(
  scope: Scope,
  ctx: TenantContext,
  job: ImportJobRow,
  row: LegacyImportRow,
): Promise<{
  applicationId: string;
  reference: string;
  decisionId: string | null;
  certificateId: string | null;
} | null> {
  return db.transaction(async (tx) => {
    const applicationId = uuidv7();
    const reference = makeApplicationReference(applicationId);
    const inserted = await tx
      .insert(applications)
      .values(
        scope.insertValues({
          id: applicationId,
          reference,
          applicantName: row.applicantName,
          status: row.status,
          priority: row.priority,
          intake: row.intake,
          createdByUserId: ctx.userId,
          submittedAt: row.submittedAt,
          decidedAt: row.decidedAt,
          withdrawnAt: row.withdrawnAt,
          withdrawnReason: row.withdrawnReason,
          closedAt: row.closedAt,
          externalReference: row.externalReference,
          importJobId: job.id,
        }),
      )
      .onConflictDoNothing({
        target: [applications.organisationId, applications.externalReference],
      })
      .returning({ id: applications.id });
    if (!inserted[0]) return null;

    await tx.insert(applicationStatusHistory).values(
      scope.insertValues({
        applicationId,
        fromStatus: null,
        toStatus: row.status,
        action: 'legacy_import',
        actorUserId: ctx.userId,
        note: `Imported from legacy record ${row.externalReference}. Status recorded before BlakPath.`,
      }),
    );

    let decisionId: string | null = null;
    if (row.outcome) {
      decisionId = uuidv7();
      await tx.insert(decisions).values(
        scope.insertValues({
          id: decisionId,
          applicationId,
          proposedOutcome: row.outcome.finalOutcome,
          rationale: row.outcome.note,
          status: 'finalised' as const,
          finalOutcome: row.outcome.finalOutcome,
          finalisedAt: row.outcome.decidedAt,
          recordedBeforeBlakpath: true,
          legacyRecordedBy: row.outcome.recordedBy,
        }),
      );
    }

    let certificateId: string | null = null;
    if (row.certificate && decisionId) {
      certificateId = uuidv7();
      await tx.insert(certificates).values(
        scope.insertValues({
          id: certificateId,
          applicationId,
          decisionId,
          reference: row.certificate.reference,
          status: row.certificate.revokedAt ? ('revoked' as const) : ('signed' as const),
          // No canonical payload or seal exists for a pre-BlakPath certificate.
          payloadVersion: 'legacy',
          verificationCode: generateVerificationCode(),
          signedAt: row.certificate.issuedAt,
          revokedAt: row.certificate.revokedAt,
          revokedReason: row.certificate.revokedReason,
          issuedBeforeBlakpath: true,
        }),
      );
    }

    return { applicationId, reference, decisionId, certificateId };
  });
}

/** Import one staged record. Throws only for transient (retryable) faults. */
async function importRecord(
  scope: Scope,
  ctx: TenantContext,
  job: ImportJobRow,
  record: ImportRecord,
  index: number,
  firstIndexByReference: ReadonlyMap<string, number>,
): Promise<RowOutcome> {
  const row = rowNumber(index);
  const validated = validateImportRecord(record);
  if (!validated.ok) {
    const ref = record.external_reference?.trim();
    return {
      kind: 'failed',
      issue: { row, ...(ref ? { externalReference: ref } : {}), error: validated.error },
    };
  }
  const legacy = validated.row;
  const externalReference = legacy.externalReference;
  if (firstIndexByReference.get(externalReference) !== index) {
    return {
      kind: 'failed',
      issue: {
        row,
        externalReference,
        error: 'external_reference appears earlier in this file.',
      },
    };
  }

  let created: Awaited<ReturnType<typeof insertLegacyMatter>> = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      created = await insertLegacyMatter(scope, ctx, job, legacy);
      break;
    } catch (error) {
      const pg = pgError(error);
      // A generated BlakPath reference can collide; mint another and retry.
      if (pg?.constraint === 'applications_org_reference_unique' && attempt < 3) continue;
      if (pg?.constraint === 'certificates_org_reference_unique') {
        return {
          kind: 'failed',
          issue: {
            row,
            externalReference,
            error: 'certificate_reference already exists in this organisation.',
          },
        };
      }
      // Data/integrity errors are deterministic: fail the row, not the job.
      if (pg && (pg.code.startsWith('22') || pg.code.startsWith('23'))) {
        return {
          kind: 'failed',
          issue: { row, externalReference, error: 'The row could not be saved.' },
        };
      }
      throw error;
    }
  }

  if (!created) {
    // Already present. If THIS job created it (a retry resuming mid-chunk), it
    // still counts as created; otherwise it was imported before — skip it.
    const [existing] = await scope.db
      .select({ importJobId: applications.importJobId })
      .from(applications)
      .where(
        scope.where(
          applications.organisationId,
          eq(applications.externalReference, externalReference),
        ),
      )
      .limit(1);
    return existing?.importJobId === job.id ? { kind: 'created' } : { kind: 'skipped' };
  }

  await recordAudit({
    action: 'application.imported',
    resourceType: 'application',
    resourceId: created.applicationId,
    result: 'success',
    reason: 'migrated from legacy system',
    after: {
      data: {
        reference: created.reference,
        externalReference,
        status: legacy.status,
        importJobId: job.id,
      },
      allow: ['reference', 'externalReference', 'status', 'importJobId'],
    },
  });
  if (created.decisionId && legacy.outcome) {
    await recordAudit({
      action: 'decision.imported',
      resourceType: 'decision',
      resourceId: created.decisionId,
      result: 'success',
      reason: 'outcome recorded by authorised humans before BlakPath',
      after: {
        data: {
          applicationId: created.applicationId,
          finalOutcome: legacy.outcome.finalOutcome,
          recordedBeforeBlakpath: true,
        },
        allow: ['applicationId', 'finalOutcome', 'recordedBeforeBlakpath'],
      },
    });
  }
  if (created.certificateId && legacy.certificate) {
    await recordAudit({
      action: 'certificate.imported',
      resourceType: 'certificate',
      resourceId: created.certificateId,
      result: 'success',
      reason: 'certificate issued before BlakPath',
      after: {
        data: {
          reference: legacy.certificate.reference,
          status: legacy.certificate.revokedAt ? 'revoked' : 'signed',
          issuedBeforeBlakpath: true,
        },
        allow: ['reference', 'status', 'issuedBeforeBlakpath'],
      },
    });
  }
  return { kind: 'created' };
}

/** Process an import job end to end (or resume it). Safe to call repeatedly. */
export async function processApplicationImport(input: ProcessImportInput): Promise<void> {
  const { organisationId, correlationId, importJobId } = input;
  const chunkSize = input.chunkSize ?? IMPORT_CHUNK_SIZE;
  const scope = scopeFor(organisationId);

  const [job] = await scope.db
    .select()
    .from(importJobs)
    .where(scope.where(importJobs.organisationId, eq(importJobs.id, importJobId)))
    .limit(1);
  if (!job || job.status === 'completed' || job.status === 'failed') return;

  const settle = (patch: Partial<typeof importJobs.$inferInsert>) =>
    scope.db
      .update(importJobs)
      .set(patch)
      .where(
        and(
          eq(importJobs.organisationId, organisationId),
          eq(importJobs.id, importJobId),
        ),
      );

  const systemAudit = {
    organisationId,
    actorUserId: job.requestedByUserId,
    actingRole: 'system',
    sessionId: null,
    correlationId,
  } as const;

  if (job.status === 'pending') {
    await settle({ status: 'processing', startedAt: new Date() });
  }

  try {
    const records = Array.isArray(job.stagedRows)
      ? (job.stagedRows as ImportRecord[])
      : null;
    if (!records) throw new AuthorizationError('POLICY_DENIED', 'No staged rows.');
    if (!job.requestedByUserId) {
      throw new AuthorizationError('POLICY_DENIED', 'The requester no longer exists.');
    }
    const ctx = await resolveTenantContext({
      userId: job.requestedByUserId,
      sessionId: job.requestedSessionId,
      organisationId,
      correlationId,
      requestId: randomUUID(),
    });

    await runWithTenantContext(ctx, async () => {
      requireAll(
        subjectFromContext(ctx),
        requiredImportPermissions({
          includesOutcomes: job.includesOutcomes,
          includesCertificates: job.includesCertificates,
        }),
      );

      const firstIndexByReference = new Map<string, number>();
      records.forEach((record, index) => {
        const ref = (record.external_reference ?? '').trim();
        if (ref && !firstIndexByReference.has(ref)) firstIndexByReference.set(ref, index);
      });

      let { processedRows, createdCount, skippedCount, failedCount } = job;
      const issues: ImportIssue[] = Array.isArray(job.issues)
        ? [...(job.issues as ImportIssue[])]
        : [];

      while (processedRows < records.length) {
        const end = Math.min(processedRows + chunkSize, records.length);
        for (let index = processedRows; index < end; index += 1) {
          const outcome = await importRecord(
            scope,
            ctx,
            job,
            records[index]!,
            index,
            firstIndexByReference,
          );
          if (outcome.kind === 'created') createdCount += 1;
          else if (outcome.kind === 'skipped') skippedCount += 1;
          else {
            failedCount += 1;
            if (issues.length < IMPORT_MAX_ISSUES) issues.push(outcome.issue);
          }
        }
        processedRows = end;
        await settle({ processedRows, createdCount, skippedCount, failedCount, issues });
        await input.onProgress?.(Math.floor((processedRows / records.length) * 100));
      }

      await settle({ status: 'completed', stagedRows: null, completedAt: new Date() });
      await recordAudit({
        action: 'import.completed',
        resourceType: 'import',
        resourceId: importJobId,
        result: failedCount > 0 ? 'failure' : 'success',
        reason: `import: ${createdCount} created, ${skippedCount} already imported, ${failedCount} failed of ${records.length}`,
        after: {
          data: { total: records.length, createdCount, skippedCount, failedCount },
          allow: ['total', 'createdCount', 'skippedCount', 'failedCount'],
        },
      });
    });
  } catch (error) {
    const terminal = isAuthorizationError(error) || error instanceof TenantContextError;
    if (terminal || input.finalAttempt) {
      await settle({
        status: 'failed',
        stagedRows: null,
        completedAt: new Date(),
        error: terminal
          ? 'The requester no longer holds the access this import needs.'
          : 'The import stopped after repeated errors. Rows already imported are kept; re-run the same file to finish.',
      });
      await recordAudit({
        action: 'import.failed',
        resourceType: 'import',
        resourceId: importJobId,
        result: terminal ? 'denied' : 'failure',
        ...systemAudit,
      });
      if (terminal) return;
    }
    throw error;
  }
}
