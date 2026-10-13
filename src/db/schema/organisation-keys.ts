import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organisationId as organisationIdCol, primaryId, timestamps } from './_helpers';
import {
  keyCustodyMode,
  organisationKeyRewrapStatus,
  organisationKeyStatus,
  organisationKeyValidationStatus,
} from './enums';
import { organisations } from './tenancy';

/**
 * Current key-encryption key for one organisation.
 *
 * One row per organisation. The ARN is a KMS CMK, including a key whose origin
 * is an external key store (XKS). Cross-account ARNs are valid. Ciphertext
 * stores this ARN plus `keyVersion` as its key id. KMS automatic rotation keeps
 * the ARN, so it does not write `previousKmsKeyArn`. A replacement CMK does:
 * older wraps stay readable under `previousKmsKeyArn` until the re-wrap job
 * finishes and clears it.
 *
 * Status changes are appended to the platform audit chain. A status other than
 * `active` means the application must fail closed for that tenant. A row stays
 * `pending_validation` until the handshake passes. `canaryCiphertext` is the
 * wrapped data key from that handshake (never the plaintext) and is what the
 * health job decrypts.
 *
 * Escrow is opt-in. `escrow` may only be true with a signed consent reference
 * and the digest of the deposited escrow package (see
 * docs/key-escrow-runbook.md). A rotation clears the flag and the digest,
 * because the package belongs to the replaced key material.
 */
export const organisationKeys = pgTable(
  'organisation_keys',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    custodyMode: keyCustodyMode('custody_mode').notNull(),
    /** CMK or XKS key ARN. Not secret material. */
    kmsKeyArn: text('kms_key_arn').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    /**
     * CMK being replaced. Null when no re-wrap is in progress. Decrypt accepts
     * this ARN until the re-wrap job clears it.
     */
    previousKmsKeyArn: text('previous_kms_key_arn'),
    previousKeyVersion: integer('previous_key_version'),
    status: organisationKeyStatus('status').notNull().default('active'),
    validationStatus: organisationKeyValidationStatus('validation_status')
      .notNull()
      .default('pending'),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    /** Short failure code from the handshake. Not a KMS message and not key material. */
    validationFailure: text('validation_failure'),
    /** Base64 KMS ciphertext blob from the passing handshake. Not a plaintext DEK. */
    canaryCiphertext: text('canary_ciphertext'),
    lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
    /** Last DescribeKey state, or a decrypt failure name. Not key material. */
    lastHealthState: text('last_health_state'),
    /** True when an escrow copy of the key material is held under dual control. */
    escrow: boolean('escrow').notNull().default(false),
    /**
     * Reference to the signed escrow consent held under the escrow agreement
     * (contract or e-signature envelope id). Not the document itself.
     */
    escrowConsentReference: text('escrow_consent_reference'),
    /** When the client's authorised signatories signed the escrow consent. */
    escrowConsentedAt: timestamp('escrow_consented_at', { withTimezone: true }),
    /** SHA-256 (hex) of the deposited `escrow-package.json` manifest. */
    escrowPackageDigest: text('escrow_package_digest'),
    /**
     * Wrapped HMAC key for reference and name lookup. Purpose `blind-index`.
     * Null until the first search or sealed write claims it.
     */
    blindIndexWrappedDek: text('blind_index_wrapped_dek'),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('organisation_keys_org_unique').on(table.organisationId),
    check(
      'organisation_keys_escrow_consent',
      sql`${table.escrow} = false OR (${table.escrowConsentReference} IS NOT NULL AND ${table.escrowConsentedAt} IS NOT NULL AND ${table.escrowPackageDigest} IS NOT NULL)`,
    ),
  ],
);

export const organisationKeysRelations = relations(organisationKeys, ({ one }) => ({
  organisation: one(organisations, {
    fields: [organisationKeys.organisationId],
    references: [organisations.id],
  }),
}));

/**
 * One running replacement per organisation. Counters and cursors are the
 * progress report. `lastError` is an error name, never a message or payload.
 */
export const organisationKeyRewraps = pgTable(
  'organisation_key_rewraps',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    fromKmsKeyArn: text('from_kms_key_arn').notNull(),
    fromKeyVersion: integer('from_key_version').notNull(),
    toKmsKeyArn: text('to_kms_key_arn').notNull(),
    toKeyVersion: integer('to_key_version').notNull(),
    status: organisationKeyRewrapStatus('status').notNull().default('running'),
    /** `fields`, then `objects`, then `done`. */
    phase: text('phase').notNull().default('fields'),
    fieldsDone: integer('fields_done').notNull().default(0),
    fieldsTotal: integer('fields_total'),
    objectsDone: integer('objects_done').notNull().default(0),
    objectsTotal: integer('objects_total'),
    fieldCursor: text('field_cursor'),
    objectCursor: text('object_cursor'),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('organisation_key_rewraps_org_status_idx').on(
      table.organisationId,
      table.status,
    ),
  ],
);

/**
 * Version-2 envelopes the re-wrap job can find. Writers (field encryption)
 * upsert a binding here. The envelope is ciphertext. This table does not hold
 * a second plaintext copy.
 */
export const tenantEncryptedFields = pgTable(
  'tenant_encrypted_fields',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    tableName: text('table_name').notNull(),
    columnName: text('column_name').notNull(),
    rowId: text('row_id').notNull(),
    envelope: jsonb('envelope').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('tenant_encrypted_fields_binding_unique').on(
      table.organisationId,
      table.tableName,
      table.columnName,
      table.rowId,
    ),
    index('tenant_encrypted_fields_org_id_idx').on(table.organisationId, table.id),
  ],
);

/**
 * Destruction certificate. No foreign key: it has to outlive the tenant key
 * and may outlive the organisation row. Residual JSON is counts and column
 * names, not personal information, and it is not wrapped by the tenant CMK.
 */
export const destructionCertificates = pgTable(
  'destruction_certificates',
  {
    id: primaryId(),
    organisationId: uuid('organisation_id').notNull(),
    kmsKeyArn: text('kms_key_arn').notNull(),
    keyVersion: integer('key_version').notNull(),
    certificate: jsonb('certificate').notNull(),
    ...timestamps,
  },
  (table) => [index('destruction_certificates_org_idx').on(table.organisationId)],
);

export const organisationKeyRewrapsRelations = relations(
  organisationKeyRewraps,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [organisationKeyRewraps.organisationId],
      references: [organisations.id],
    }),
  }),
);

export const tenantEncryptedFieldsRelations = relations(
  tenantEncryptedFields,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [tenantEncryptedFields.organisationId],
      references: [organisations.id],
    }),
  }),
);
