import { Readable } from 'node:stream';
import {
  and,
  desc,
  eq,
  gte,
  isNull,
  lt,
  lte,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
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
import { EXPORT_TTL_DAYS } from '@/lib/storage/lifecycle';
import { EVIDENCE_BUCKET, objectKey, uploadObjectStream } from '@/lib/storage/s3';
import { toCsvLine, type CsvCell } from './csv';
import { REPORT_COLUMNS, isReportType, type ReportType } from './reports';
import {
  exportRange,
  readStoredExportFilters,
  type StoredExportFilters,
} from './schemas';

/**
 * Export generation (worker side).
 *
 * Runs with an explicit organisation id. Streams the requested report as CSV,
 * page by page, into tenant-namespaced storage (multipart for large exports, so
 * memory stays bounded), sealed with the tenant key, and records where it
 * landed. Exporting is sensitive, so the whole thing is audited; a failure
 * marks the request `failed` (never fabricates a partial file, never fails
 * open).
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

/** Inclusive created-at bounds. Undefined ends are left open. */
function ranged(column: AnyColumn, filters: StoredExportFilters): SQL[] {
  const { start, end } = exportRange(filters);
  const predicates: SQL[] = [];
  if (start) predicates.push(gte(column, start));
  if (end) predicates.push(lte(column, end));
  return predicates;
}

function whereLive(...predicates: Array<SQL | undefined>): SQL {
  const defined = predicates.filter(
    (predicate): predicate is SQL => predicate !== undefined,
  );
  return and(...defined) as SQL;
}

/**
 * Keyset-paginate a report: `fetchPage(afterId)` returns the next page in
 * descending id order. UUIDv7 ids are time-ordered, so this is newest-first,
 * and rows created mid-export (newer ids) never shift later pages. `toRows`
 * maps a whole page so sealed fields can be opened in one batch.
 */
async function* pagedRows<T extends { id: string }>(
  fetchPage: (afterId: string | null) => Promise<T[]>,
  toRows: (page: T[]) => Promise<CsvCell[][]> | CsvCell[][],
): AsyncGenerator<CsvCell[]> {
  let afterId: string | null = null;
  for (;;) {
    const page = await fetchPage(afterId);
    for (const row of await toRows(page)) yield row;
    const last = page.at(-1);
    if (page.length < PAGE_SIZE || !last) return;
    afterId = last.id;
  }
}

/** Data rows for a report type, streamed in pages. */
function reportRows(
  scope: Scope,
  type: ReportType,
  filters: StoredExportFilters,
): AsyncGenerator<CsvCell[]> {
  const org = scope.organisationId;
  const after = (column: AnyColumn, afterId: string | null) =>
    afterId ? lt(column, afterId) : undefined;

  if (type === 'applications') {
    return pagedRows(
      (afterId) =>
        scope.db
          .select()
          .from(applications)
          .where(
            whereLive(
              eq(applications.organisationId, org),
              isNull(applications.deletedAt),
              filters.status ? eq(applications.status, filters.status) : undefined,
              ...ranged(applications.createdAt, filters),
              after(applications.id, afterId),
            ),
          )
          .orderBy(desc(applications.id))
          .limit(PAGE_SIZE),
      async (page) =>
        (await openApplicationRows(org, page)).map((a) => [
          a.reference,
          a.applicantName,
          a.status,
          a.priority,
          a.createdAt,
          a.submittedAt,
          a.decidedAt,
        ]),
    );
  }

  if (type === 'decisions') {
    return pagedRows(
      (afterId) =>
        scope.db
          .select()
          .from(decisions)
          .where(
            whereLive(
              eq(decisions.organisationId, org),
              isNull(decisions.deletedAt),
              ...ranged(decisions.createdAt, filters),
              after(decisions.id, afterId),
            ),
          )
          .orderBy(desc(decisions.id))
          .limit(PAGE_SIZE),
      (page) =>
        page.map((d) => [
          d.applicationId,
          d.proposedOutcome,
          d.finalOutcome,
          d.status,
          d.finalisedAt,
        ]),
    );
  }

  if (type === 'certificates') {
    return pagedRows(
      (afterId) =>
        scope.db
          .select()
          .from(certificates)
          .where(
            whereLive(
              eq(certificates.organisationId, org),
              isNull(certificates.deletedAt),
              ...ranged(certificates.createdAt, filters),
              after(certificates.id, afterId),
            ),
          )
          .orderBy(desc(certificates.id))
          .limit(PAGE_SIZE),
      (page) => page.map((c) => [c.reference, c.status, c.signedAt, c.revokedAt]),
    );
  }

  return pagedRows(
    (afterId) =>
      scope.db
        .select()
        .from(destructionRegister)
        .where(
          whereLive(
            eq(destructionRegister.organisationId, org),
            ...ranged(destructionRegister.destroyedAt, filters),
            after(destructionRegister.id, afterId),
          ),
        )
        .orderBy(desc(destructionRegister.id))
        .limit(PAGE_SIZE),
    (page) => destructionRegisterRows(page),
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

  /**
   * Settle only while this attempt still holds the claim. The row update and
   * its audit event commit together; a lost claim writes neither.
   */
  const settle = (
    patch: Partial<typeof exportRequests.$inferInsert>,
    audit: Omit<Parameters<typeof recordAudit>[0], 'resourceType' | 'resourceId'>,
  ): Promise<boolean> =>
    scope.db.transaction(async (tx) => {
      const settled = await tx
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
      if (settled.length === 0) return false;
      await recordAudit(
        { ...audit, resourceType: 'export', resourceId: exportRequestId },
        tx,
      );
      return true;
    });

  const systemActor = {
    organisationId,
    actorUserId: null,
    actingRole: 'system',
    sessionId: null,
    correlationId,
  } as const;

  try {
    if (!isReportType(request.type)) {
      throw new Error(`Unknown report type: ${request.type}`);
    }
    const filters = readStoredExportFilters(request.params);
    const key = objectKey(organisationId, 'exports', `${exportRequestId}.csv`);
    const counter = { rows: 0 };
    await uploadObjectStream({
      bucket: EVIDENCE_BUCKET,
      key,
      body: Readable.from(
        csvStream(
          REPORT_COLUMNS[request.type],
          reportRows(scope, request.type, filters),
          counter,
        ),
      ),
      contentType: 'text/csv; charset=utf-8',
      organisationId,
      lifecycle: 'export',
    });

    const won = await settle(
      {
        status: 'ready',
        objectKey: key,
        rowCount: counter.rows,
        expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
        completedAt: new Date(),
      },
      {
        ...systemActor,
        action: 'export.generated',
        result: 'success',
        after: {
          data: {
            type: request.type,
            rows: counter.rows,
            status: filters.status ?? null,
            from: filters.from ?? null,
            to: filters.to ?? null,
          },
          allow: ['type', 'rows', 'status', 'from', 'to'],
        },
      },
    );
    if (!won) {
      logger.warn(
        { organisationId, exportRequestId },
        'export finished after its claim was superseded — result discarded',
      );
    }
  } catch (err) {
    await settle(
      {
        status: 'failed',
        error: err instanceof Error ? err.message : 'export failed',
        completedAt: new Date(),
      },
      { ...systemActor, action: 'export.failed', result: 'failure' },
    );
    logger.error({ organisationId, exportRequestId, err }, 'export generation failed');
  }
}
