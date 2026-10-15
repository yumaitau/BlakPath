import { relations } from 'drizzle-orm';
import {
  bigint,
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
import { exportStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * Export request tables (Phase 7).
 *
 * A member with `report:export` requests a dataset; the worker assembles a CSV,
 * writes it to tenant-namespaced storage, and records where it landed. Exporting
 * is a sensitive action — it is permission-checked and every step is audited.
 * Files are short-lived (`expiresAt`), only ever presigned to the owning
 * tenant, and removed by the export maintenance sweep (row → `expired`) with an
 * S3 lifecycle rule as backstop. Tenant-owned.
 */
export const exportRequests = pgTable(
  'export_requests',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    requestedByUserId: refId('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Which report this export produces (e.g. 'applications'). */
    type: text('type').notNull(),
    /** Optional report parameters/filters (report-defined). */
    params: jsonb('params'),
    status: exportStatus('status').notNull().default('pending'),
    /**
     * When the current generation attempt claimed the row. Doubles as the
     * claim token: only the attempt that set it may settle the row, and a
     * `processing` row whose claim is older than the stale timeout may be
     * taken over by a retry (the original worker is presumed dead).
     */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** Generation attempts claimed so far; bounds takeover of a poison export. */
    attempts: integer('attempts').notNull().default(0),
    /** Object key of the generated CSV once ready. */
    objectKey: text('object_key'),
    rowCount: bigint('row_count', { mode: 'number' }),
    error: text('error'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('export_requests_org_status_idx').on(table.organisationId, table.status),
  ],
);

export const exportRequestsRelations = relations(exportRequests, ({ one }) => ({
  organisation: one(organisations, {
    fields: [exportRequests.organisationId],
    references: [organisations.id],
  }),
  requestedBy: one(users, {
    fields: [exportRequests.requestedByUserId],
    references: [users.id],
  }),
}));
