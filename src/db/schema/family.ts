import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  rowVersion,
  softDelete,
  timestamps,
} from './_helpers';
import { familyLinkStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { applications } from './applications';
import { tenantIsolationPolicy } from './_rls';

/**
 * Family-link tables (Phase 4).
 *
 * A family link records a specific family connection relevant to an application
 * (e.g. "maternal grandmother, Aunty X, of Y community"). Tenant-owned,
 * org-leading indexed.
 *
 * PRODUCT INVARIANT: recording or approving a family link is NOT a determination
 * of Aboriginality. `approved` means an authorised human confirmed THIS
 * relationship after records and cultural checks — separation of duties is
 * enforced so the approver is never the requester (see the service layer).
 */
export const familyLinks = pgTable(
  'family_links',
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
    /** How the relative connects to the applicant, e.g. "grandmother". */
    relationship: text('relationship').notNull(),
    /** The relative's name as recorded (no derived judgement). */
    relativeName: text('relative_name').notNull(),
    /** Community / nation / language group as recorded, if given. */
    community: text('community'),
    notes: text('notes'),
    status: familyLinkStatus('status').notNull().default('requested'),
    /** The authorised human who approved or disputed the link (never the requester). */
    decidedByUserId: refId('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    ...timestamps,
    ...rowVersion,
    ...softDelete,
  },
  (table) => [
    index('family_links_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
    index('family_links_org_status_idx').on(table.organisationId, table.status),
    tenantIsolationPolicy(),
  ],
).enableRLS();

export const familyLinksRelations = relations(familyLinks, ({ one }) => ({
  organisation: one(organisations, {
    fields: [familyLinks.organisationId],
    references: [organisations.id],
  }),
  application: one(applications, {
    fields: [familyLinks.applicationId],
    references: [applications.id],
  }),
  requestedBy: one(users, {
    fields: [familyLinks.requestedByUserId],
    references: [users.id],
  }),
  decidedBy: one(users, {
    fields: [familyLinks.decidedByUserId],
    references: [users.id],
  }),
}));
