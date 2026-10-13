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

/**
 * APP 5 collection-notice acknowledgements.
 *
 * One row per point of collection (public form response, applicant evidence
 * upload, staff-led intake) recording WHICH notice was shown: its version and
 * the SHA-256 hash of the exact wording (see src/lib/privacy/collection-notice.ts).
 * `method` distinguishes a person acknowledging for themselves from a staff
 * member attesting they gave the notice during intake. The collected record is
 * referenced by `resourceType`/`resourceId` (no FK, so the acknowledgement
 * survives retention disposal of the record it accompanied). Append-only.
 */
export const collectionNoticeAcknowledgements = pgTable(
  'collection_notice_acknowledgements',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** form_response | evidence_upload | application_intake (app-checked). */
    context: text('context').notNull(),
    /** self | staff_attested (app-checked). */
    method: text('method').notNull(),
    noticeVersion: text('notice_version').notNull(),
    /** SHA-256 hex of the notice wording shown. */
    noticeHash: text('notice_hash').notNull(),
    /** Signed-in user who acknowledged or attested; null for a public token. */
    acknowledgedByUserId: refId('acknowledged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Person the information is about, when they hold an account. */
    subjectUserId: refId('subject_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The collected record, e.g. 'form_response' / 'evidence' / 'application'. */
    resourceType: text('resource_type').notNull(),
    resourceId: refId('resource_id').notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Coarse origin for a public submission; not shown in the UI. */
    ipAddress: text('ip_address'),
    ...timestamps,
  },
  (table) => [
    index('notice_ack_org_resource_idx').on(
      table.organisationId,
      table.resourceType,
      table.resourceId,
    ),
    index('notice_ack_org_hash_idx').on(table.organisationId, table.noticeHash),
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

export const collectionNoticeAcknowledgementsRelations = relations(
  collectionNoticeAcknowledgements,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [collectionNoticeAcknowledgements.organisationId],
      references: [organisations.id],
    }),
  }),
);
