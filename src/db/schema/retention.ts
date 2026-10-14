import { relations } from 'drizzle-orm';
import { boolean, integer, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  softDelete,
  timestamps,
} from './_helpers';
import { retentionAction } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * Retention tables (Phase 7).
 *
 * A retention policy says how long a class of record is kept and what happens
 * when that period passes (purge or anonymise). A legal hold pins a specific
 * record so retention can never touch it while the hold stands. Both are
 * tenant-owned. The append-only audit trail is deliberately NOT a retention
 * target — it is immutable by design.
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
    /** Days a record is kept before the policy acts. */
    retentionDays: integer('retention_days').notNull(),
    action: retentionAction('action').notNull(),
    /**
     * Reference to an approved disposal authority. Without it the sweep will
     * not dispose a decided application, a finalised decision, or an issued
     * certificate. Dual-control approval of the reference is a separate control.
     */
    disposalAuthorityRef: text('disposal_authority_ref'),
    active: boolean('active').notNull().default(true),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('retention_policies_org_idx').on(table.organisationId, table.resourceType),
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
