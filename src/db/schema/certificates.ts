import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
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
 * Organisation-authored layout (wording, logo, signatory) lives in immutable
 * `certificate_templates` versions. A re-issue revokes the previous certificate
 * and records the link both ways (`supersedes` / `superseded_by`). Public
 * verification calls that state "superseded" and still returns no applicant
 * detail.
 *
 * PRODUCT INVARIANT: the certificate attests a decision authorised humans made
 * and recorded. Nothing here computes, scores or determines Aboriginality.
 */

/**
 * One published certificate layout for an organisation.
 *
 * Rows are immutable. A change inserts the next `template_version`; it never
 * updates wording in place. Certificates store the version id they were
 * rendered from, so later publishes do not rewrite issued PDFs.
 */
export const certificateTemplates = pgTable(
  'certificate_templates',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** Monotonic per organisation. Version 1 is the first publish. */
    templateVersion: integer('template_version').notNull(),
    /** Organisation-authored body text printed on the certificate. */
    wording: text('wording').notNull(),
    /** Name printed as the organisation's signatory. Authored, not inferred. */
    signatoryName: text('signatory_name').notNull(),
    /** Role printed under the signatory name. */
    signatoryRole: text('signatory_role').notNull(),
    /** Evidence-bucket key of the optional logo. Shared across versions that reuse it. */
    logoObjectKey: text('logo_object_key'),
    /** `image/png` or `image/jpeg` when a logo is set. */
    logoContentType: text('logo_content_type'),
    /** SHA-256 of the logo bytes, so an unchanged logo keeps the same content hash. */
    logoSha256: text('logo_sha256'),
    /** SHA-256 of the canonical wording, signatory and logo hash. */
    contentHash: text('content_hash').notNull(),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('certificate_templates_org_version_unique').on(
      table.organisationId,
      table.templateVersion,
    ),
  ],
);

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
    /** Template version rendered into this PDF. Null on rows from before templates. */
    templateId: refId('template_id').references(() => certificateTemplates.id, {
      onDelete: 'restrict',
    }),
    /**
     * The earlier certificate this one replaces. Set on the new draft at re-issue.
     */
    supersedesCertificateId: refId('supersedes_certificate_id').references(
      (): AnyPgColumn => certificates.id,
      { onDelete: 'set null' },
    ),
    /**
     * The later certificate that replaced this one. Set when this row is revoked
     * by re-issue. Public verify shows "superseded" only when this is present.
     */
    supersededByCertificateId: refId('superseded_by_certificate_id').references(
      (): AnyPgColumn => certificates.id,
      { onDelete: 'set null' },
    ),
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
    uniqueIndex('certificates_one_live_per_decision')
      .on(table.organisationId, table.decisionId)
      .where(sql`${table.deletedAt} IS NULL AND ${table.status} IN ('draft', 'signed')`),
    index('certificates_org_status_idx').on(table.organisationId, table.status),
    index('certificates_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
  ],
);

export const certificateTemplatesRelations = relations(
  certificateTemplates,
  ({ one, many }) => ({
    organisation: one(organisations, {
      fields: [certificateTemplates.organisationId],
      references: [organisations.id],
    }),
    createdBy: one(users, {
      fields: [certificateTemplates.createdByUserId],
      references: [users.id],
    }),
    certificates: many(certificates),
  }),
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
  template: one(certificateTemplates, {
    fields: [certificates.templateId],
    references: [certificateTemplates.id],
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
