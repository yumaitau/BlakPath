import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organisationId as organisationIdCol, primaryId, timestamps } from './_helpers';
import {
  keyCustodyMode,
  organisationKeyStatus,
  organisationKeyValidationStatus,
} from './enums';
import { organisations } from './tenancy';

/**
 * Current key-encryption key for one organisation.
 *
 * One row per organisation. The ARN is a KMS CMK, including a key whose origin
 * is an external key store (XKS). Cross-account ARNs are valid. Ciphertext
 * stores this ARN plus `keyVersion` as its key id. Historical ciphertext wrapped
 * by a replaced ARN stays unreadable until a later re-wrap (rotation history is
 * not stored here).
 *
 * Status changes are appended to the platform audit chain. A status other than
 * `active` means the application must fail closed for that tenant. A row stays
 * `pending_validation` until the handshake passes. `canaryCiphertext` is the
 * wrapped data key from that handshake (never the plaintext) and is what the
 * health job decrypts.
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
     * Wrapped HMAC key for reference and name lookup. Purpose `blind-index`.
     * Null until the first search or sealed write claims it.
     */
    blindIndexWrappedDek: text('blind_index_wrapped_dek'),
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
