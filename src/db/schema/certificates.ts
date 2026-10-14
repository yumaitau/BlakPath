import { relations, sql } from 'drizzle-orm';
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
 * A certificate is generated from a FINALISED, confirmed committee decision on
 * a case that has reached `decided`, signed by an authorised human (with
 * step-up), and can later be revoked. One live certificate (not revoked, not
 * soft-deleted) may exist per decision. The PDF bytes live in object storage
 * (tenant-namespaced key); this row carries metadata, the content hash and the
 * public verification code. Tenant-owned and org-leading indexed.
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
    /**
     * Canonical signed payload version.
     * `1` seals reference, parties and outcome. `2` also seals a salted holder-name
     * hash and the PDF SHA-256.
     */
    payloadVersion: text('payload_version').notNull().default('1'),
    /** Random salt for the holder hashes sealed with payload version 2. */
    holderBindingSalt: text('holder_binding_salt'),
    /** Salted hash of the name printed on the certificate. Null until bound. */
    holderNameHash: text('holder_name_hash'),
    /** Salted hash of a date of birth recorded at intake, when there was one. */
    holderDobHash: text('holder_dob_hash'),
    /** SHA-256 hex of the canonical signed payload. */
    payloadHash: text('payload_hash'),
    /** Base64 digital signature over the canonical payload (KMS in prod). */
    signature: text('signature'),
    /** KMS signing algorithm, e.g. RSASSA_PSS_SHA_256. */
    signingAlgorithm: text('signing_algorithm'),
    /**
     * Resolved KMS key ARN that signed (never an alias), or 'local-dev-key'
     * outside prod. Joins `signing_keys` for offline public verification.
     */
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
    // Revoked and soft-deleted rows remain, so a replacement can be issued.
    uniqueIndex('certificates_live_decision_unique')
      .on(table.decisionId)
      .where(sql`${table.deletedAt} is null and ${table.status} <> 'revoked'`),
    index('certificates_org_status_idx').on(table.organisationId, table.status),
    index('certificates_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
  ],
);

/**
 * Public halves of the keys that have sealed certificates.
 *
 * Captured from KMS the first time a key signs and never changed afterwards,
 * so public `/verify` checks a seal offline against the stored SPKI — no KMS
 * call per request, and an alias retarget or a disabled old key never turns
 * earlier certificates into "Not verified". Platform-level, not tenant-owned:
 * one deployment signing key serves every organisation. Holds no secrets.
 */
export const signingKeys = pgTable(
  'signing_keys',
  {
    /** Full KMS key ARN (`arn:aws:kms:<region>:<account>:key/<id>`). */
    keyId: text('key_id').primaryKey(),
    /** KMS key spec, e.g. RSA_2048 or ECC_NIST_P256. */
    keySpec: text('key_spec').notNull(),
    /** Base64 DER SubjectPublicKeyInfo exactly as KMS returned it. */
    publicKeySpki: text('public_key_spki').notNull(),
    /** SHA-256 hex of the SPKI DER bytes. */
    fingerprintSha256: text('fingerprint_sha256').notNull(),
    firstUsedAt: timestamp('first_used_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('signing_keys_fingerprint_unique').on(table.fingerprintSha256)],
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
