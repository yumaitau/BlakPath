import { desc, eq } from 'drizzle-orm';
import { exportRequests } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  requireAny,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { addJob, QueueName } from '@/lib/queues';
import { EVIDENCE_BUCKET, presignDownload } from '@/lib/storage/s3';
import { requestExportSchema, type RequestExportInput } from './schemas';

/**
 * Reporting/exports service — tenant-scoped, permission-checked, audited.
 *
 * Requesting an export needs `report:export` (a sensitive action). The heavy
 * work runs in the Export worker; this layer records the request, enqueues it,
 * lists requests, and mints a short-lived download URL for a ready file.
 */

export type ExportRequestRow = typeof exportRequests.$inferSelect;

/** Request an export. Requires `report:export`. */
export async function requestExport(
  rawInput: RequestExportInput,
): Promise<ExportRequestRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'report:export');

  const input = requestExportSchema.parse(rawInput);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(exportRequests)
    .values(
      scope.insertValues({
        requestedByUserId: ctx.userId,
        type: input.type,
        status: 'pending',
      }),
    )
    .returning();
  const row = expectRow(inserted[0], 'export request');

  await addJob(
    QueueName.Export,
    'generate',
    {
      organisationId: scope.organisationId,
      correlationId: ctx.correlationId,
      exportRequestId: row.id,
    },
    { jobId: row.id },
  );

  await recordAudit({
    action: 'export.requested',
    resourceType: 'export',
    resourceId: row.id,
    result: 'success',
    after: { data: { type: input.type }, allow: ['type'] },
  });
  return row;
}

/** List export requests (viewers and exporters may see them). */
export async function listExports(): Promise<ExportRequestRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), ['report:view', 'report:export']);
  const scope = currentScope();
  return scope.db
    .select()
    .from(exportRequests)
    .where(scope.where(exportRequests.organisationId))
    .orderBy(desc(exportRequests.createdAt));
}

/** Mint a short-lived download URL for a ready export. Requires `report:export`. */
export async function getExportDownloadUrl(
  id: string,
): Promise<{ url: string; expiresIn: number }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'report:export');

  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(exportRequests)
    .where(scope.where(exportRequests.organisationId, eq(exportRequests.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== 'ready' || !row.objectKey) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new AuthorizationError('POLICY_DENIED', 'This export has expired.');
  }

  const signed = await presignDownload({
    organisationId: ctx.organisationId,
    key: row.objectKey,
    fileName: `${row.type}-${row.id}.csv`,
  });

  await recordAudit({
    action: 'export.downloaded',
    resourceType: 'export',
    resourceId: id,
    result: 'success',
  });
  return signed;
}

/** Re-export so callers can namespace the export bucket if needed. */
export { EVIDENCE_BUCKET };
