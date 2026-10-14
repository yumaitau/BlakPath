import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  applications,
  certificates,
  decisions,
  destructionRegister,
  exportRequests,
} from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { destructionRegisterRows } from '@/domains/retention/register';
import { logger } from '@/lib/observability/logger';
import { openApplicationRows } from '@/lib/encryption/tenant-fields';
import { EVIDENCE_BUCKET, objectKey, putObjectBytes } from '@/lib/storage/s3';
import { toCsv, type CsvCell } from './csv';
import { REPORT_COLUMNS, isReportType, type ReportType } from './reports';

/**
 * Export generation (worker side).
 *
 * Runs with an explicit organisation id. Assembles the requested report as CSV,
 * writes it to tenant-namespaced storage, and records where it landed. Exporting
 * is sensitive, so the whole thing is audited; a failure marks the request
 * `failed` (never fabricates a partial file, never fails open).
 */

const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ProcessExportInput {
  organisationId: string;
  exportRequestId: string;
  correlationId: string;
}

type Scope = ReturnType<typeof scopeFor>;

/** Build the header + data rows for a report type. */
async function buildReport(
  scope: Scope,
  type: ReportType,
): Promise<{ headers: readonly string[]; rows: CsvCell[][] }> {
  const headers = REPORT_COLUMNS[type];

  if (type === 'applications') {
    const items = await scope.db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.organisationId, scope.organisationId),
          isNull(applications.deletedAt),
        ),
      )
      .orderBy(desc(applications.createdAt));
    const opened = await openApplicationRows(scope.organisationId, items);
    return {
      headers,
      rows: opened.map((a) => [
        a.reference,
        a.applicantName,
        a.status,
        a.priority,
        a.createdAt,
        a.submittedAt,
        a.decidedAt,
      ]),
    };
  }

  if (type === 'decisions') {
    const items = await scope.db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.organisationId, scope.organisationId),
          isNull(decisions.deletedAt),
        ),
      )
      .orderBy(desc(decisions.createdAt));
    return {
      headers,
      rows: items.map((d) => [
        d.applicationId,
        d.proposedOutcome,
        d.finalOutcome,
        d.status,
        d.finalisedAt,
      ]),
    };
  }

  if (type === 'certificates') {
    const items = await scope.db
      .select()
      .from(certificates)
      .where(
        and(
          eq(certificates.organisationId, scope.organisationId),
          isNull(certificates.deletedAt),
        ),
      )
      .orderBy(desc(certificates.createdAt));
    return {
      headers,
      rows: items.map((c) => [c.reference, c.status, c.signedAt, c.revokedAt]),
    };
  }

  const items = await scope.db
    .select()
    .from(destructionRegister)
    .where(eq(destructionRegister.organisationId, scope.organisationId))
    .orderBy(desc(destructionRegister.destroyedAt));
  return {
    headers,
    rows: destructionRegisterRows(items),
  };
}

export async function processExport(input: ProcessExportInput): Promise<void> {
  const { organisationId, exportRequestId, correlationId } = input;
  const scope = scopeFor(organisationId);

  const rows = await scope.db
    .select()
    .from(exportRequests)
    .where(
      and(
        eq(exportRequests.organisationId, organisationId),
        eq(exportRequests.id, exportRequestId),
      ),
    )
    .limit(1);
  const request = rows[0];
  if (!request || request.status !== 'pending') return;

  const settle = (patch: Partial<typeof exportRequests.$inferInsert>) =>
    scope.db
      .update(exportRequests)
      .set(patch)
      .where(
        and(
          eq(exportRequests.organisationId, organisationId),
          eq(exportRequests.id, exportRequestId),
        ),
      );

  await settle({ status: 'processing' });

  try {
    if (!isReportType(request.type)) {
      throw new Error(`Unknown report type: ${request.type}`);
    }
    const report = await buildReport(scope, request.type);
    const csv = toCsv(report.headers, report.rows);
    const key = objectKey(organisationId, 'exports', `${exportRequestId}.csv`);
    await putObjectBytes({
      bucket: EVIDENCE_BUCKET,
      key,
      body: Buffer.from(csv, 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      organisationId,
    });

    await settle({
      status: 'ready',
      objectKey: key,
      rowCount: report.rows.length,
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
      completedAt: new Date(),
    });
    await recordAudit({
      action: 'export.generated',
      resourceType: 'export',
      resourceId: exportRequestId,
      result: 'success',
      organisationId,
      actorUserId: null,
      actingRole: 'system',
      sessionId: null,
      correlationId,
      after: {
        data: { type: request.type, rows: report.rows.length },
        allow: ['type', 'rows'],
      },
    });
  } catch (err) {
    await settle({
      status: 'failed',
      error: err instanceof Error ? err.message : 'export failed',
      completedAt: new Date(),
    });
    await recordAudit({
      action: 'export.failed',
      resourceType: 'export',
      resourceId: exportRequestId,
      result: 'failure',
      organisationId,
      actorUserId: null,
      actingRole: 'system',
      sessionId: null,
      correlationId,
    });
    logger.error({ organisationId, exportRequestId, err }, 'export generation failed');
  }
}
