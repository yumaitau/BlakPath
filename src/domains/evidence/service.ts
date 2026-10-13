import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import { uuidv7 } from 'uuidv7';
import { evidence, evidenceRequests } from '@/db/schema';
import { currentScope, scopeFor } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit } from '@/domains/audit/service';
import { getApplication } from '@/domains/applications';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { addJob, QueueName } from '@/lib/queues';
import { logger } from '@/lib/observability/logger';
import { queueNotification } from '@/domains/notifications';
import {
  deleteObject,
  EVIDENCE_BUCKET,
  getObjectBytes,
  moveQuarantineToEvidence,
  objectKey,
  presignDownload,
  presignUpload,
  QUARANTINE_BUCKET,
  type PresignedUpload,
} from '@/lib/storage/s3';
import { scanBuffer, type ScanVerdict } from '@/lib/scanning/clamav';
import {
  classifyEvidenceSchema,
  requestEvidenceSchema,
  requestUploadSchema,
  type ClassifyEvidenceInput,
  type RequestEvidenceInput,
  type RequestUploadInput,
} from './schemas';
import { contentTypeAcceptable, isServable } from './status';

/**
 * Evidence service — the tenant-scoped, permission-checked, audited path for
 * uploading, scanning, classifying and downloading applicant evidence.
 *
 * The design is fail-secure end to end (docs/evidence-scanning-design.md):
 * bytes land in a quarantine bucket, are scanned out-of-band by the worker, and
 * only a positively-clean object is ever promoted and downloadable. The request
 * path here never sees file bytes — those flow directly to/from S3 via
 * presigned URLs.
 */

export type EvidenceRow = typeof evidence.$inferSelect;
export type EvidenceRequestRow = typeof evidenceRequests.$inferSelect;
type EvidencePatch = Partial<typeof evidence.$inferInsert>;

/** Load a live (non-deleted) evidence row within the active tenant scope. */
async function loadEvidence(id: string): Promise<EvidenceRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(evidence)
    .where(
      scope.where(
        evidence.organisationId,
        eq(evidence.id, id),
        isNull(evidence.deletedAt),
      ),
    )
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

/**
 * Start an upload: create a `pending` evidence record and mint a short-lived
 * presigned PUT into the quarantine bucket. Applicants upload to their OWN
 * application only (`evidence:upload-own`).
 */
export async function requestUpload(
  applicationId: string,
  rawInput: RequestUploadInput,
): Promise<{ evidence: EvidenceRow; upload: PresignedUpload }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'evidence:upload-own');

  const input = requestUploadSchema.parse(rawInput);

  // Enforce that the actor may see the application AND is its applicant. The
  // getApplication call applies the read policy and audits the view.
  const detail = await getApplication(applicationId);
  if (detail.application.applicantUserId !== ctx.userId) {
    throw new AuthorizationError('POLICY_DENIED');
  }

  const scope = currentScope();
  const id = uuidv7();
  const key = objectKey(
    scope.organisationId,
    'applications',
    applicationId,
    'evidence',
    id,
  );

  const inserted = await scope.db
    .insert(evidence)
    .values(
      scope.insertValues({
        id,
        applicationId,
        uploadedByUserId: ctx.userId,
        fulfilsRequestId: input.fulfilsRequestId ?? null,
        fileName: input.fileName,
        declaredContentType: input.contentType,
        sizeBytes: input.sizeBytes,
        status: 'pending',
        quarantineKey: key,
      }),
    )
    .returning();
  const row = expectRow(inserted[0], 'evidence');

  const upload = await presignUpload({
    organisationId: scope.organisationId,
    key,
    contentType: input.contentType,
    contentLength: input.sizeBytes,
  });

  return { evidence: row, upload };
}

/**
 * Confirm the bytes have been PUT. Moves the record to `quarantined` and
 * enqueues the malware scan. The scan job is keyed by the evidence id so a
 * duplicate notification cannot double-schedule work.
 */
export async function completeUpload(evidenceId: string): Promise<EvidenceRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'evidence:upload-own');

  const existing = await loadEvidence(evidenceId);
  if (!existing || existing.uploadedByUserId !== ctx.userId) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  if (existing.status !== 'pending') {
    // Already progressed; return as-is (idempotent).
    return existing;
  }

  const scope = currentScope();
  const updated = await scope.db
    .update(evidence)
    .set({ status: 'quarantined' })
    .where(scope.where(evidence.organisationId, eq(evidence.id, evidenceId)))
    .returning();
  const row = expectRow(updated[0], 'evidence');

  await addJob(
    QueueName.MalwareScan,
    'scan',
    {
      organisationId: scope.organisationId,
      correlationId: ctx.correlationId,
      evidenceId,
    },
    { jobId: evidenceId },
  );

  await recordAudit({
    action: 'evidence.uploaded',
    resourceType: 'evidence',
    resourceId: evidenceId,
    result: 'success',
    after: {
      data: { applicationId: row.applicationId, fileName: row.fileName },
      allow: ['applicationId', 'fileName'],
    },
  });
  await recordAudit({
    action: 'evidence.scan_started',
    resourceType: 'evidence',
    resourceId: evidenceId,
    result: 'success',
  });

  return row;
}

/**
 * Mint a short-lived download URL for a piece of evidence. Only CLEAN,
 * promoted objects are ever servable, and only to a caller with
 * `evidence:download` who may read the parent application.
 */
export async function getDownloadUrl(
  evidenceId: string,
): Promise<{ url: string; expiresIn: number }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'evidence:download');

  const row = await loadEvidence(evidenceId);
  if (!row) throw new AuthorizationError('POLICY_DENIED');

  // Enforce readability of the parent application (audits the view).
  await getApplication(row.applicationId);

  if (!isServable(row.status) || !row.evidenceKey) {
    // Never reveal that an infected/unscanned object exists.
    await recordAudit({
      action: 'evidence.downloaded',
      resourceType: 'evidence',
      resourceId: evidenceId,
      result: 'denied',
      reason: 'evidence not clean or not promoted',
    });
    throw new AuthorizationError('POLICY_DENIED');
  }

  const signed = await presignDownload({
    organisationId: ctx.organisationId,
    key: row.evidenceKey,
    fileName: row.fileName,
  });

  await recordAudit({
    action: 'evidence.downloaded',
    resourceType: 'evidence',
    resourceId: evidenceId,
    result: 'success',
  });

  return signed;
}

/** List the evidence attached to an application the actor may read. */
export async function listForApplication(applicationId: string): Promise<EvidenceRow[]> {
  // Enforces the application read policy (own/assigned/any) and audits the view.
  await getApplication(applicationId);

  const scope = currentScope();
  return scope.db
    .select()
    .from(evidence)
    .where(
      scope.where(
        evidence.organisationId,
        eq(evidence.applicationId, applicationId),
        isNull(evidence.deletedAt),
      ),
    )
    .orderBy(desc(evidence.createdAt));
}

/** List staff requests for evidence on an application the actor may read. */
export async function listRequestsForApplication(
  applicationId: string,
): Promise<EvidenceRequestRow[]> {
  await getApplication(applicationId);
  const scope = currentScope();
  return scope.db
    .select()
    .from(evidenceRequests)
    .where(
      scope.where(
        evidenceRequests.organisationId,
        eq(evidenceRequests.applicationId, applicationId),
      ),
    )
    .orderBy(desc(evidenceRequests.createdAt));
}

/** Record an administrative classification on a piece of evidence. */
export async function classifyEvidence(
  evidenceId: string,
  rawInput: ClassifyEvidenceInput,
): Promise<EvidenceRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'evidence:classify');

  const input = classifyEvidenceSchema.parse(rawInput);
  const existing = await loadEvidence(evidenceId);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const updated = await scope.db
    .update(evidence)
    .set({
      classification: input.classification,
      classifiedByUserId: ctx.userId,
      classifiedAt: new Date(),
    })
    .where(scope.where(evidence.organisationId, eq(evidence.id, evidenceId)))
    .returning();
  const row = expectRow(updated[0], 'evidence');

  await recordAudit({
    action: 'evidence.classified',
    resourceType: 'evidence',
    resourceId: evidenceId,
    result: 'success',
    before: {
      data: { classification: existing.classification },
      allow: ['classification'],
    },
    after: { data: { classification: row.classification }, allow: ['classification'] },
  });

  return row;
}

/** Ask an applicant to supply further evidence on an application. */
export async function requestFurtherEvidence(
  applicationId: string,
  rawInput: RequestEvidenceInput,
): Promise<EvidenceRequestRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'evidence:request');

  const input = requestEvidenceSchema.parse(rawInput);
  // Enforce readability of the application (audits the view).
  await getApplication(applicationId);

  const scope = currentScope();
  const inserted = await scope.db
    .insert(evidenceRequests)
    .values(
      scope.insertValues({
        applicationId,
        requestedByUserId: ctx.userId,
        description: input.description,
        dueAt: input.dueAt ?? null,
        status: 'open',
      }),
    )
    .returning();
  const row = expectRow(inserted[0], 'evidence request');

  await recordAudit({
    action: 'evidence.requested',
    resourceType: 'evidence',
    resourceId: row.id,
    result: 'success',
    after: { data: { applicationId }, allow: ['applicationId'] },
  });

  return row;
}

/* ---------------------------------------------------------------------------
 * Worker path — malware scan lifecycle.
 * ------------------------------------------------------------------------- */

export interface ProcessScanInput {
  readonly organisationId: string;
  readonly evidenceId: string;
  readonly correlationId: string;
}

/** Audit helper for the worker: no ambient context, so attribute to 'system'. */
function systemAudit(
  organisationId: string,
  correlationId: string,
  fields: Parameters<typeof recordAudit>[0],
) {
  return recordAudit({
    ...fields,
    organisationId,
    actorUserId: null,
    actingRole: 'system',
    sessionId: null,
    correlationId,
  });
}

/**
 * Scan a quarantined evidence object and settle its lifecycle. FAIL-SECURE:
 *   - scanner unavailable / error  → audit + THROW (BullMQ retries; stays quarantined);
 *   - content-type spoofed         → reject (delete, status `rejected`);
 *   - malware found                → reject (delete, status `infected`);
 *   - clean                        → promote to the evidence bucket, status `clean`.
 *
 * Runs with an explicit organisation id (no ambient tenant context); all data
 * access goes through `scopeFor(organisationId)` and audit is attributed to the
 * system actor.
 */
export async function processEvidenceScan(input: ProcessScanInput): Promise<void> {
  const { organisationId, evidenceId, correlationId } = input;
  const scope = scopeFor(organisationId);

  const rows = await scope.db
    .select()
    .from(evidence)
    .where(
      and(
        eq(evidence.organisationId, organisationId),
        eq(evidence.id, evidenceId),
        isNull(evidence.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];

  if (!row) {
    logger.warn({ organisationId, evidenceId }, 'scan: evidence not found — skipping');
    return;
  }
  if (row.status !== 'quarantined' || !row.quarantineKey) {
    logger.info(
      { organisationId, evidenceId, status: row.status },
      'scan: evidence not in quarantined state — skipping (idempotent)',
    );
    return;
  }

  const key = row.quarantineKey;

  await systemAudit(organisationId, correlationId, {
    action: 'evidence.scan_started',
    resourceType: 'evidence',
    resourceId: evidenceId,
    result: 'success',
  });

  const settle = async (patch: EvidencePatch) => {
    await scope.db
      .update(evidence)
      .set(patch)
      .where(
        and(eq(evidence.organisationId, organisationId), eq(evidence.id, evidenceId)),
      );
  };

  // Read the bytes; a storage error here should retry, so let it throw.
  const buffer = await getObjectBytes({ bucket: QUARANTINE_BUCKET, key });

  // Verify the REAL content type from magic bytes before scanning.
  const detected = (await fileTypeFromBuffer(buffer))?.mime;
  if (!contentTypeAcceptable(row.declaredContentType, detected)) {
    await deleteObject({ bucket: QUARANTINE_BUCKET, key });
    await settle({
      status: 'rejected',
      detectedContentType: detected ?? null,
      scanResult: 'rejected:content-type',
      scannedAt: new Date(),
    });
    await systemAudit(organisationId, correlationId, {
      action: 'evidence.rejected',
      resourceType: 'evidence',
      resourceId: evidenceId,
      result: 'failure',
      reason: `declared ${row.declaredContentType}, detected ${detected ?? 'unknown'}`,
    });
    return;
  }

  // Scan. Any scanner unavailability MUST fail (retry) — never promote.
  let verdict: ScanVerdict;
  try {
    verdict = await scanBuffer(buffer);
  } catch (err) {
    await systemAudit(organisationId, correlationId, {
      action: 'evidence.scan_failed',
      resourceType: 'evidence',
      resourceId: evidenceId,
      result: 'failure',
      reason: 'scanner unavailable',
    });
    // Stays quarantined. Rethrow so BullMQ retries with backoff.
    throw err;
  }

  if (!verdict.clean) {
    await deleteObject({ bucket: QUARANTINE_BUCKET, key });
    await settle({
      status: 'infected',
      detectedContentType: detected ?? null,
      scanSignature: verdict.signature ?? 'unknown',
      scanResult: 'infected',
      scannedAt: new Date(),
    });
    await systemAudit(organisationId, correlationId, {
      action: 'evidence.scan_infected',
      resourceType: 'evidence',
      resourceId: evidenceId,
      result: 'failure',
      reason: verdict.signature ?? 'malware detected',
    });

    // Let the uploader know, calmly and without file details. Best-effort: a
    // notification failure must never change the fail-secure scan outcome.
    if (row.uploadedByUserId) {
      try {
        await queueNotification(
          {
            organisationId,
            userId: row.uploadedByUserId,
            type: 'evidence.infected',
            title: 'An upload could not be accepted',
            body: 'One of your uploads did not pass our safety checks and was not stored. Please try uploading a different copy of the file.',
            resourceType: 'evidence',
            resourceId: evidenceId,
          },
          correlationId,
        );
      } catch (err) {
        logger.error(
          { organisationId, evidenceId, err },
          'failed to queue infected-evidence notification',
        );
      }
    }
    return;
  }

  // Clean: hash, promote to the evidence bucket, mark servable.
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  await moveQuarantineToEvidence({ organisationId, key });
  await settle({
    status: 'clean',
    evidenceKey: key,
    detectedContentType: detected ?? null,
    sha256,
    scanResult: 'clean',
    scannedAt: new Date(),
  });
  await systemAudit(organisationId, correlationId, {
    action: 'evidence.scan_clean',
    resourceType: 'evidence',
    resourceId: evidenceId,
    result: 'success',
  });
  logger.debug(
    { organisationId, evidenceId, bucket: EVIDENCE_BUCKET },
    'evidence promoted',
  );
}
