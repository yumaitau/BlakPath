import { Readable } from 'node:stream';
import { and, desc, eq, isNull, lt, or, sql, type Column, type SQL } from 'drizzle-orm';
import { applications, certificates, decisions, exportRequests } from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { logger } from '@/lib/observability/logger';
import { EXPORT_TTL_DAYS } from '@/lib/storage/lifecycle';
import { EVIDENCE_BUCKET, objectKey, uploadObjectStream } from '@/lib/storage/s3';
import { toCsvLine, type CsvCell } from './csv';
import { REPORT_COLUMNS, isReportType, type ReportType } from './reports';

/**
 * Export generation (worker side).
 *
 * Runs with an explicit organisation id. Streams the requested report as CSV,
 * page by page, into tenant-namespaced storage (multipart for large exports, so
 * memory stays bounded), and records where it landed. Exporting is sensitive,
 * so the whole thing is audited; a failure marks the request `failed` (never
 * fabricates a partial file, never fails open).
 *
 * Crash safety: a worker claims the row (`processing`, `startedAt`, attempt
 * count) before writing anything. If the worker dies mid-export the row stays
 * `processing`; once the claim is older than `EXPORT_STALE_MS` a retry (BullMQ
 * redelivery or the maintenance sweep) takes it over. Only the attempt that
 * holds the current claim may settle the row, so a slow-but-alive superseded
 * worker cannot overwrite the result.
 */

export const EXPORT_TTL_MS = EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000;

/** A `processing` claim older than this is presumed dead and may be taken over. */
export const EXPORT_STALE_MS = 15 * 60 * 1000;

/** Generation attempts before an export that keeps dying is marked failed. */
export const MAX_EXPORT_ATTEMPTS = 3;

/** Rows fetched per page while streaming a report. */
const PAGE_SIZE = 1_000;

export interface ProcessExportInput {
  organisationId: string;
  exportRequestId: string;
  correlationId: string;
}

type Scope = ReturnType<typeof scopeFor>;

/**
 * Keyset-paginate a report: `fetchPage(afterId)` returns the next page in
 * descending id order. UUIDv7 ids are time-ordered, so this is newest-first,
 * and rows created mid-export (newer ids) never shift later pages.
 */
async function* pagedRows<T extends { id: string }>(
  fetchPage: (afterId: string | null) => Promise<T[]>,
  toRow: (item: T) => CsvCell[],
): AsyncGenerator<CsvCell[]> {
  let afterId: string | null = null;
  for (;;) {
    const page = await fetchPage(afterId);
    for (const item of page) yield toRow(item);
    const last = page.at(-1);
    if (page.length < PAGE_SIZE || !last) return;
    afterId = last.id;
  }
}

/** Data rows for a report type, streamed in pages. */
function reportRows(scope: Scope, type: ReportType): AsyncGenerator<CsvCell[]> {
  const org = scope.organisationId;
  const after = (column: Column, afterId: string | null) =>
    afterId ? lt(column, afterId) : undefined;

  if (type === 'applications') {
    return pagedRows(
      (afterId) =>
        scope.db
          .select()
          .from(applications)
          .where(
            and(
              eq(applications.organisationId, org),
              isNull(applications.deletedAt),
              after(applications.id, afterId),
            ),
          )
          .orderBy(desc(applications.id))
          .limit(PAGE_SIZE),
      (a) => [
        a.reference,
        a.applicantName,
        a.status,
        a.priority,
        a.createdAt,
        a.submittedAt,
        a.decidedAt,
      ],
    );
  }

  if (type === 'decisions') {
    return pagedRows(
      (afterId) =>
        scope.db
          .select()
          .from(decisions)
          .where(
            and(
              eq(decisions.organisationId, org),
              isNull(decisions.deletedAt),
              after(decisions.id, afterId),
            ),
          )
          .orderBy(desc(decisions.id))
          .limit(PAGE_SIZE),
      (d) => [
        d.applicationId,
        d.proposedOutcome,
        d.finalOutcome,
        d.status,
        d.finalisedAt,
      ],
    );
  }

  return pagedRows(
    (afterId) =>
      scope.db
        .select()
        .from(certificates)
        .where(
          and(
            eq(certificates.organisationId, org),
            isNull(certificates.deletedAt),
            after(certificates.id, afterId),
          ),
        )
        .orderBy(desc(certificates.id))
        .limit(PAGE_SIZE),
    (c) => [c.reference, c.status, c.signedAt, c.revokedAt],
  );
}

/** Serialise a header + streamed rows as CSV, counting data rows as they pass. */
export async function* csvStream(
  headers: readonly string[],
  rows: AsyncIterable<ReadonlyArray<CsvCell>>,
  counter: { rows: number },
): AsyncGenerator<string> {
  yield toCsvLine(headers);
  for await (const row of rows) {
    counter.rows += 1;
    yield toCsvLine(row);
  }
}

/**
 * Condition under which a generation attempt may claim an export: it is
 * `pending`, or it is `processing` under a claim older than the stale timeout.
 * Either way the attempt budget must not be exhausted.
 */
export function claimableCondition(now: Date): SQL | undefined {
  return and(
    or(
      eq(exportRequests.status, 'pending'),
      and(
        eq(exportRequests.status, 'processing'),
        lt(exportRequests.startedAt, new Date(now.getTime() - EXPORT_STALE_MS)),
      ),
    ),
    lt(exportRequests.attempts, MAX_EXPORT_ATTEMPTS),
  );
}

export async function processExport(input: ProcessExportInput): Promise<void> {
  const { organisationId, exportRequestId, correlationId } = input;
  const scope = scopeFor(organisationId);
  const thisRow = and(
    eq(exportRequests.organisationId, organisationId),
    eq(exportRequests.id, exportRequestId),
  );

  // Atomic claim: a concurrent duplicate, or a retry while the original is
  // still within its claim window, matches nothing and returns early.
  const claimedAt = new Date();
  const claimed = await scope.db
    .update(exportRequests)
    .set({
      status: 'processing',
      startedAt: claimedAt,
      attempts: sql`${exportRequests.attempts} + 1`,
      error: null,
    })
    .where(and(thisRow, claimableCondition(claimedAt)))
    .returning();
  const request = claimed[0];
  if (!request) return;
  if (request.attempts > 1) {
    logger.warn(
      { organisationId, exportRequestId, attempt: request.attempts },
      'export claim taken over from a stale attempt',
    );
  }

  /** Settle only while this attempt still holds the claim. */
  const settle = async (patch: Partial<typeof exportRequests.$inferInsert>) => {
    const settled = await scope.db
      .update(exportRequests)
      .set(patch)
      .where(
        and(
          thisRow,
          eq(exportRequests.status, 'processing'),
          eq(exportRequests.startedAt, claimedAt),
        ),
      )
      .returning({ id: exportRequests.id });
    return settled.length > 0;
  };

  try {
    if (!isReportType(request.type)) {
      throw new Error(`Unknown report type: ${request.type}`);
    }
    const key = objectKey(organisationId, 'exports', `${exportRequestId}.csv`);
    const counter = { rows: 0 };
    await uploadObjectStream({
      bucket: EVIDENCE_BUCKET,
      key,
      body: Readable.from(
        csvStream(REPORT_COLUMNS[request.type], reportRows(scope, request.type), counter),
      ),
      contentType: 'text/csv; charset=utf-8',
      lifecycle: 'export',
    });

    const won = await settle({
      status: 'ready',
      objectKey: key,
      rowCount: counter.rows,
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
      completedAt: new Date(),
    });
    if (!won) {
      logger.warn(
        { organisationId, exportRequestId },
        'export finished after its claim was superseded — result discarded',
      );
      return;
    }
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
        data: { type: request.type, rows: counter.rows },
        allow: ['type', 'rows'],
      },
    });
  } catch (err) {
    const won = await settle({
      status: 'failed',
      error: err instanceof Error ? err.message : 'export failed',
      completedAt: new Date(),
    });
    logger.error({ organisationId, exportRequestId, err }, 'export generation failed');
    if (!won) return;
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
  }
}
