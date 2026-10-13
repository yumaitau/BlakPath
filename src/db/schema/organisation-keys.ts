import { relations } from 'drizzle-orm';
import {
  boolean,
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
 * `active` means the application must fail closed for that tenant.
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
    /** True when an escrow copy of the key material is held under dual control. */
    escrow: boolean('escrow').notNull().default(false),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('organisation_keys_org_unique').on(table.organisationId)],
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
