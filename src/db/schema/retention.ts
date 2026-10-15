import { relations } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  softDelete,
  timestamps,
} from './_helpers';
import { users } from './auth';
import { retentionAction } from './enums';
import { organisations } from './tenancy';

/**
 * Retention tables (Phase 7, disposal controls in issue #44).
 *
 * A retention policy says how long a class of record is kept and what happens
 * when that period passes (purge, anonymise, or retain forever). It is drafted
 * by one person and stays inactive until a different person activates it. A
 * purge also stores the disposal-authority reference a records manager signed.
 *
 * A legal hold pins a specific record so retention can never touch it while
 * the hold stands. The destruction register records purges that committed.
 * The append-only audit trail is deliberately NOT a retention target.
 */
export const retentionPolicies = pgTable(
  'retention_policies',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** The record class this policy governs, e.g. 'application' | 'evidence'. */
    resourceType: text('resource_type').notNull(),
    /** Catalogue class for that resource type, copied at draft time. */
    disposalClass: text('disposal_class'),
    /** Jurisdiction whose signed authority this policy cites. */
    jurisdiction: text('jurisdiction'),
    /**
     * Days a record is kept before the policy acts. Null means permanent
     * (`action = retain`) — the sweep never treats the record as due.
     */
    retentionDays: integer('retention_days'),
    action: retentionAction('action').notNull(),
    /**
     * Disposal authority instrument the records manager cited. A purge, and
     * any disposal of an official record (decided application, finalised
     * decision, issued certificate), runs only when this matches a current
     * records-manager sign-off and a second person has activated the policy.
     */
    disposalAuthorityRef: text('disposal_authority_ref'),
    /** False until a different person from the drafter activates the policy. */
    active: boolean('active').notNull().default(false),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedByUserId: refId('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('retention_policies_org_idx').on(table.organisationId, table.resourceType),
  ],
);

/**
 * A records manager's sign-off that a disposal class, in one jurisdiction, is
 * kept under a named authority. This is a human act. The software does not
 * choose the authority or the period. A later sign-off supersedes the earlier
 * one; superseded rows stay as history.
 */
export const disposalAuthoritySignoffs = pgTable(
  'disposal_authority_signoffs',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    jurisdiction: text('jurisdiction').notNull(),
    disposalClass: text('disposal_class').notNull(),
    /** Catalogue version the manager reviewed. A newer catalogue does not inherit it. */
    catalogueVersion: text('catalogue_version').notNull(),
    authorityReference: text('authority_reference').notNull(),
    /** Manager's declaration that this class is kept permanently. */
    permanent: boolean('permanent').notNull().default(false),
    /**
     * Optional minimum keep period the manager recorded from the authority.
     * Not a period the software invented. Null when the class is permanent.
     */
    minimumRetentionDays: integer('minimum_retention_days'),
    notes: text('notes'),
    signedOffByUserId: refId('signed_off_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    signedOffAt: timestamp('signed_off_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('disposal_authority_signoffs_org_class_idx').on(
      table.organisationId,
      table.jurisdiction,
      table.disposalClass,
    ),
  ],
);

/**
 * Destruction register. One row per record a purge commit removed.
 * Append-only in the application: there is no update or delete path.
 */
export const destructionRegister = pgTable(
  'destruction_register',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    disposalClass: text('disposal_class').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    authorityReference: text('authority_reference').notNull(),
    policyId: refId('policy_id')
      .notNull()
      .references(() => retentionPolicies.id, { onDelete: 'no action' }),
    destroyedAt: timestamp('destroyed_at', { withTimezone: true }).notNull(),
    correlationId: text('correlation_id').notNull(),
    ...timestamps,
  },
  (table) => [
    index('destruction_register_org_destroyed_idx').on(
      table.organisationId,
      table.destroyedAt,
    ),
  ],
);

/** A legal hold that shields one record from retention until released. */
export const legalHolds = pgTable(
  'legal_holds',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    reason: text('reason').notNull(),
    placedByUserId: refId('placed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    releasedByUserId: refId('released_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('legal_holds_org_resource_idx').on(
      table.organisationId,
      table.resourceType,
      table.resourceId,
    ),
  ],
);

export const retentionPoliciesRelations = relations(retentionPolicies, ({ one }) => ({
  organisation: one(organisations, {
    fields: [retentionPolicies.organisationId],
    references: [organisations.id],
  }),
  createdBy: one(users, {
    fields: [retentionPolicies.createdByUserId],
    references: [users.id],
    relationName: 'retentionPolicyCreatedBy',
  }),
  approvedBy: one(users, {
    fields: [retentionPolicies.approvedByUserId],
    references: [users.id],
    relationName: 'retentionPolicyApprovedBy',
  }),
}));

export const disposalAuthoritySignoffsRelations = relations(
  disposalAuthoritySignoffs,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [disposalAuthoritySignoffs.organisationId],
      references: [organisations.id],
    }),
    signedOffBy: one(users, {
      fields: [disposalAuthoritySignoffs.signedOffByUserId],
      references: [users.id],
    }),
  }),
);

export const destructionRegisterRelations = relations(destructionRegister, ({ one }) => ({
  organisation: one(organisations, {
    fields: [destructionRegister.organisationId],
    references: [organisations.id],
  }),
  policy: one(retentionPolicies, {
    fields: [destructionRegister.policyId],
    references: [retentionPolicies.id],
  }),
}));

export const legalHoldsRelations = relations(legalHolds, ({ one }) => ({
  organisation: one(organisations, {
    fields: [legalHolds.organisationId],
    references: [organisations.id],
  }),
  placedBy: one(users, {
    fields: [legalHolds.placedByUserId],
    references: [users.id],
  }),
}));
