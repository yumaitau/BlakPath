import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organisationId as organisationIdCol, primaryId, timestamps } from './_helpers';
import { keyCustodyMode, organisationKeyStatus } from './enums';
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
 * `active` means the application must fail closed for that tenant.
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
    status: organisationKeyStatus('status').notNull().default('active'),
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
