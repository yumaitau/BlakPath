import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  timestamps,
} from './_helpers';
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * Consent records — the missing consent domain.
 *
 * A consent record captures a person's agreement (or withdrawal) for a stated
 * purpose: representative access, evidence handling, communications. Time-boxed
 * via `expiresAt`, revocable via `revokedAt`. `representative_authorisations`
 * links here through `consentRecordId`. Nothing is inferred; every grant is an
 * explicit recorded act, permission-checked and audited.
 */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** Person the consent is about. */
    subjectUserId: refId('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who recorded it (staff intake or the subject themselves). */
    recordedByUserId: refId('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Purpose key, e.g. 'representative-access', 'evidence-handling'. */
    purpose: text('purpose').notNull(),
    /** granted | withdrawn (app-checked). */
    status: text('status').notNull().default('granted'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps,
  },
  (table) => [
    index('consent_org_subject_idx').on(table.organisationId, table.subjectUserId),
    index('consent_org_purpose_idx').on(table.organisationId, table.purpose),
  ],
);

export const consentRecordsRelations = relations(consentRecords, ({ one }) => ({
  organisation: one(organisations, {
    fields: [consentRecords.organisationId],
    references: [organisations.id],
  }),
  subject: one(users, {
    fields: [consentRecords.subjectUserId],
    references: [users.id],
  }),
  recordedBy: one(users, {
    fields: [consentRecords.recordedByUserId],
    references: [users.id],
  }),
}));
