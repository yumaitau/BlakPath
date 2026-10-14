import { relations } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organisationId as organisationIdCol, primaryId } from './_helpers';
import { organisations } from './tenancy';
import { tenantIsolationPolicy } from './_rls';

/**
 * Progress of one tenant's field-encryption backfill.
 *
 * `cursor` is `table:rowId` and contains no field contents. `lastError` is a
 * short operational message, also without row contents.
 */
export const encryptionBackfillRuns = pgTable(
  'encryption_backfill_runs',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** running | completed | failed */
    status: text('status').notNull().default('running'),
    cursor: text('cursor'),
    rowsEncrypted: integer('rows_encrypted').notNull().default(0),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('encryption_backfill_runs_org_idx').on(table.organisationId),
    tenantIsolationPolicy(),
  ],
).enableRLS();

export const encryptionBackfillRunsRelations = relations(
  encryptionBackfillRuns,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [encryptionBackfillRuns.organisationId],
      references: [organisations.id],
    }),
  }),
);
