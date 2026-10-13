import { relations } from 'drizzle-orm';
import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  rowVersion,
  softDelete,
  timestamps,
} from './_helpers';
import { evidenceRequestStatus, evidenceStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { applications } from './applications';
import { tenantIsolationPolicy } from './_rls';

/**
 * Evidence tables (Phase 3).
 *
 * Evidence is the most sensitive data an applicant shares, so uploads are
 * treated as untrusted until proven clean (see docs/evidence-scanning-design.md).
 * The bytes never live in these rows — they live in object storage
 * (quarantine → evidence bucket, tenant-namespaced keys). These rows carry only
 * metadata and the scan lifecycle. Everything is tenant-owned and org-leading
 * indexed.
 *
 * PRODUCT INVARIANT: nothing here scores or infers Aboriginality. `classification`
 * records the administrative TYPE of a document (e.g. "birth certificate"), set
 * by an authorised human — never a judgement about the person.
 */

/**
 * A request from staff asking an applicant to supply further evidence. Defined
 * before `evidence` because an uploaded item may link back to the request it
 * fulfils.
 */
export const evidenceRequests = pgTable(
  'evidence_requests',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    requestedByUserId: refId('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Plain-English description of what is being asked for. */
    description: text('description').notNull(),
    status: evidenceRequestStatus('status').notNull().default('open'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('evidence_requests_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
    tenantIsolationPolicy(),
  ],
).enableRLS();

/**
 * A single uploaded file attached to an application. `status` drives the
 * fail-secure lifecycle: pending → quarantined → (clean | infected | rejected).
 * Only `clean` items expose an `evidenceKey` and may ever be downloaded.
 */
export const evidence = pgTable(
  'evidence',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    uploadedByUserId: refId('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The upload that fulfils a specific staff request, when applicable. */
    fulfilsRequestId: refId('fulfils_request_id').references(() => evidenceRequests.id, {
      onDelete: 'set null',
    }),
    fileName: text('file_name').notNull(),
    /** Content type the client declared at upload time (untrusted). */
    declaredContentType: text('declared_content_type').notNull(),
    /** Content type detected from magic bytes by the scanner (trusted). */
    detectedContentType: text('detected_content_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    status: evidenceStatus('status').notNull().default('pending'),
    /** Object key in the quarantine bucket while unscanned. */
    quarantineKey: text('quarantine_key'),
    /** Object key in the evidence bucket after a clean scan (servable). */
    evidenceKey: text('evidence_key'),
    /** SHA-256 of the file contents, computed by the scanner. */
    sha256: text('sha256'),
    /** Coarse scan outcome / reason (e.g. 'clean', 'infected', 'rejected:spoof'). */
    scanResult: text('scan_result'),
    /** Malware signature name when infected. */
    scanSignature: text('scan_signature'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    /** Administrative document type set by an authorised human (never a judgement). */
    classification: text('classification'),
    classifiedByUserId: refId('classified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    classifiedAt: timestamp('classified_at', { withTimezone: true }),
    ...timestamps,
    ...rowVersion,
    ...softDelete,
  },
  (table) => [
    index('evidence_org_application_idx').on(table.organisationId, table.applicationId),
    index('evidence_org_status_idx').on(table.organisationId, table.status),
    tenantIsolationPolicy(),
  ],
).enableRLS();

export const evidenceRequestsRelations = relations(evidenceRequests, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [evidenceRequests.organisationId],
    references: [organisations.id],
  }),
  application: one(applications, {
    fields: [evidenceRequests.applicationId],
    references: [applications.id],
  }),
  requestedBy: one(users, {
    fields: [evidenceRequests.requestedByUserId],
    references: [users.id],
  }),
  fulfilments: many(evidence),
}));

export const evidenceRelations = relations(evidence, ({ one }) => ({
  organisation: one(organisations, {
    fields: [evidence.organisationId],
    references: [organisations.id],
  }),
  application: one(applications, {
    fields: [evidence.applicationId],
    references: [applications.id],
  }),
  uploadedBy: one(users, {
    fields: [evidence.uploadedByUserId],
    references: [users.id],
  }),
  fulfilsRequest: one(evidenceRequests, {
    fields: [evidence.fulfilsRequestId],
    references: [evidenceRequests.id],
  }),
  classifiedBy: one(users, {
    fields: [evidence.classifiedByUserId],
    references: [users.id],
  }),
}));
