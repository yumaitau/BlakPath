import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  rowVersion,
  softDelete,
  timestamps,
} from './_helpers';
import { certificateStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { applications } from './applications';
import { decisions } from './decisions';

/**
 * Certificate tables (Phase 6).
 *
 * A certificate is generated from a FINALISED, confirmed committee decision,
 * signed by an authorised human (with step-up), and can later be revoked. The
 * PDF bytes live in object storage (tenant-namespaced key); this row carries
 * metadata, the content hash and the public verification code. Tenant-owned and
 * org-leading indexed.
 *
 * PRODUCT INVARIANT: the certificate attests a decision authorised humans made
 * and recorded. Nothing here computes, scores or determines Aboriginality.
 */
export const certificates = pgTable(
  'certificates',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The finalised decision this certificate is issued from. */
    decisionId: refId('decision_id')
      .notNull()
      .references(() => decisions.id, { onDelete: 'cascade' }),
    /** Human-friendly per-organisation certificate reference (e.g. "CERT-2026-000123"). */
    reference: text('reference').notNull(),
    status: certificateStatus('status').notNull().default('draft'),
    /** Object key of the rendered PDF in the evidence bucket (null until rendered). */
    pdfObjectKey: text('pdf_object_key'),
    /** SHA-256 of the rendered PDF bytes, for tamper-evidence. */
    sha256: text('sha256'),
    /** Canonical signed payload version (v1 schema below). */
    payloadVersion: text('payload_version').notNull().default('1'),
    /** SHA-256 hex of the canonical signed payload. */
    payloadHash: text('payload_hash'),
    /** Base64 digital signature over the canonical payload (KMS in prod). */
    signature: text('signature'),
    /** KMS signing algorithm, e.g. RSASSA_PSS_SHA_256. */
    signingAlgorithm: text('signing_algorithm'),
    /** KMS key id/alias that signed, or 'local-dev-key' outside prod. */
    signingKeyId: text('signing_key_id'),
    /** Public, unguessable code used to verify authenticity without sign-in. */
    verificationCode: text('verification_code').notNull(),
    signedByUserId: refId('signed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    revokedByUserId: refId('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    ...timestamps,
    ...rowVersion,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('certificates_org_reference_unique').on(
      table.organisationId,
      table.reference,
    ),
    uniqueIndex('certificates_verification_code_unique').on(table.verificationCode),
    index('certificates_org_status_idx').on(table.organisationId, table.status),
    index('certificates_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
  ],
);

export const certificatesRelations = relations(certificates, ({ one }) => ({
  organisation: one(organisations, {
    fields: [certificates.organisationId],
    references: [organisations.id],
  }),
  application: one(applications, {
    fields: [certificates.applicationId],
    references: [applications.id],
  }),
  decision: one(decisions, {
    fields: [certificates.decisionId],
    references: [decisions.id],
  }),
  signedBy: one(users, {
    fields: [certificates.signedByUserId],
    references: [users.id],
  }),
  revokedBy: one(users, {
    fields: [certificates.revokedByUserId],
    references: [users.id],
  }),
}));
