import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  timestamps,
} from './_helpers';
import { importStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * Legacy import jobs.
 *
 * A permitted staff member uploads a CSV from the organisation's previous
 * system; the request validates it, stages the rows here and enqueues a worker
 * job, which imports them in chunks and records progress. Rows are matched on
 * the legacy `external_reference`, so re-running a file never duplicates a
 * matter. Tenant-owned and org-leading indexed.
 *
 * `stagedRows` holds the raw CSV records only while the job is in flight; it is
 * cleared when the job settles so applicant details never outlive the import.
 * `issues` holds row numbers, legacy references and plain error messages only.
 *
 * PRODUCT INVARIANT: an import copies outcomes and certificates that authorised
 * humans already recorded elsewhere. It never computes, infers or decides one.
 */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    requestedByUserId: refId('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Session the request came from, carried through for audit attribution. */
    requestedSessionId: refId('requested_session_id').notNull(),
    /** What is being imported (currently only 'applications'). */
    kind: text('kind').notNull().default('applications'),
    fileName: text('file_name'),
    /** SHA-256 of the uploaded file, to collapse accidental double submissions. */
    fileSha256: text('file_sha256').notNull(),
    status: importStatus('status').notNull().default('pending'),
    totalRows: integer('total_rows').notNull(),
    /** Resume cursor: rows fully processed so far. */
    processedRows: integer('processed_rows').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    /** Rows skipped because their external reference was already imported. */
    skippedCount: integer('skipped_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    includesOutcomes: boolean('includes_outcomes').notNull().default(false),
    includesCertificates: boolean('includes_certificates').notNull().default(false),
    /** Raw CSV records awaiting import; null once the job settles. */
    stagedRows: jsonb('staged_rows'),
    /** Row-level problems: `{ row, externalReference?, error }[]` (capped). */
    issues: jsonb('issues').notNull().default([]),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('import_jobs_org_created_idx').on(table.organisationId, table.createdAt),
    index('import_jobs_org_status_idx').on(table.organisationId, table.status),
  ],
);

export const importJobsRelations = relations(importJobs, ({ one }) => ({
  organisation: one(organisations, {
    fields: [importJobs.organisationId],
    references: [organisations.id],
  }),
  requestedBy: one(users, {
    fields: [importJobs.requestedByUserId],
    references: [users.id],
  }),
}));
