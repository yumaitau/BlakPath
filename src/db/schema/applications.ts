import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  rowVersion,
  softDelete,
  timestamps,
} from './_helpers';
import { applicationPriority, applicationStatus, assignmentStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { clients } from './teams';

/**
 * Application tables (Phase 2).
 *
 * An `application` is one person's Confirmation of Aboriginality matter as it
 * moves through the organisation's human workflow. Everything here is
 * tenant-owned: every table carries `organisation_id` and leads its indexes
 * with it, so the tenant-db scope guard (src/db/tenant-db.ts) can constrain
 * every read and write.
 *
 * PRODUCT INVARIANT: nothing in these tables scores, ranks or infers a person's
 * Aboriginality. `status` records where the matter sits in the process; the
 * outcome is recorded by authorised humans (decisions land in Phase 5) and is
 * never computed. `intake` JSONB holds only organisation-defined administrative
 * intake fields — never a machine judgement.
 */

/**
 * A Confirmation of Aboriginality application. `reference` is a human-friendly,
 * per-organisation identifier shown to applicants and staff; the UUID `id`
 * remains the internal key. `currentAssigneeUserId` denormalises the active
 * assignment for fast scoped listings — the authoritative history lives in
 * `applicationAssignments`.
 */
export const applications = pgTable(
  'applications',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** Human-friendly per-organisation reference, e.g. "APP-2026-0007". */
    reference: text('reference').notNull(),
    /**
     * The applicant's account, when they have one. Null while an application is
     * started on someone's behalf before an account is linked.
     */
    applicantUserId: refId('applicant_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The applicant's name as given at intake (no derived judgement). */
    applicantName: text('applicant_name').notNull(),
    status: applicationStatus('status').notNull().default('draft'),
    priority: applicationPriority('priority').notNull().default('normal'),
    /** Denormalised active assignee for scoped listings; history is authoritative. */
    currentAssigneeUserId: refId('current_assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Owning client person record (council tenant model). */
    clientId: refId('client_id').references(() => clients.id, {
      onDelete: 'set null',
    }),
    /** Who started the application (applicant or an intake officer acting for them). */
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * Organisation-defined administrative intake fields (contact, demographic
     * and handling details). Flexible per-tenant config shape only — never
     * relational data other modules join on, and never an eligibility signal.
     */
    intake: jsonb('intake'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnReason: text('withdrawn_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
    ...rowVersion,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('applications_org_reference_unique').on(
      table.organisationId,
      table.reference,
    ),
    index('applications_org_status_idx').on(table.organisationId, table.status),
    index('applications_org_assignee_idx').on(
      table.organisationId,
      table.currentAssigneeUserId,
    ),
    index('applications_org_applicant_idx').on(
      table.organisationId,
      table.applicantUserId,
    ),
  ],
);

/**
 * A worker assignment on an application. History is append-mostly: assigning
 * someone new releases the prior active assignment (`status` = 'released',
 * `releasedAt` set) rather than editing it, so who held the matter and when is
 * always reconstructable alongside the audit trail.
 */
export const applicationAssignments = pgTable(
  'application_assignments',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    assigneeUserId: refId('assignee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedByUserId: refId('assigned_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The capacity the assignee acts in, e.g. 'case-officer' (role slug). */
    roleContext: text('role_context'),
    status: assignmentStatus('status').notNull().default('active'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('application_assignments_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
    index('application_assignments_org_assignee_status_idx').on(
      table.organisationId,
      table.assigneeUserId,
      table.status,
    ),
  ],
);

/**
 * Append-only workflow transition log. One row per status change, recording the
 * from/to states, the workflow action that caused it, the acting human and an
 * optional note. This mirrors — and is corroborated by — the tamper-evident
 * audit trail, but is queryable per application for showing a timeline.
 */
export const applicationStatusHistory = pgTable(
  'application_status_history',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Null for the very first entry (application created). */
    fromStatus: applicationStatus('from_status'),
    toStatus: applicationStatus('to_status').notNull(),
    /** The workflow action name that produced this transition. */
    action: text('action').notNull(),
    actorUserId: refId('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('application_status_history_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
  ],
);

/**
 * A note attached to an application. `visibility` gates whether a note is
 * staff-only or shared with the applicant. Soft-deletable so a removed note
 * still leaves a trace for the record.
 */
export const applicationNotes = pgTable(
  'application_notes',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    authorUserId: refId('author_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    /** 'staff' = internal only; 'shared' = visible to the applicant. */
    visibility: text('visibility').notNull().default('staff'),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('application_notes_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
  ],
);

export const applicationsRelations = relations(applications, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [applications.organisationId],
    references: [organisations.id],
  }),
  applicant: one(users, {
    fields: [applications.applicantUserId],
    references: [users.id],
  }),
  currentAssignee: one(users, {
    fields: [applications.currentAssigneeUserId],
    references: [users.id],
  }),
  assignments: many(applicationAssignments),
  statusHistory: many(applicationStatusHistory),
  notes: many(applicationNotes),
}));

export const applicationAssignmentsRelations = relations(
  applicationAssignments,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [applicationAssignments.organisationId],
      references: [organisations.id],
    }),
    application: one(applications, {
      fields: [applicationAssignments.applicationId],
      references: [applications.id],
    }),
    assignee: one(users, {
      fields: [applicationAssignments.assigneeUserId],
      references: [users.id],
    }),
    assignedBy: one(users, {
      fields: [applicationAssignments.assignedByUserId],
      references: [users.id],
    }),
  }),
);

export const applicationStatusHistoryRelations = relations(
  applicationStatusHistory,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [applicationStatusHistory.organisationId],
      references: [organisations.id],
    }),
    application: one(applications, {
      fields: [applicationStatusHistory.applicationId],
      references: [applications.id],
    }),
    actor: one(users, {
      fields: [applicationStatusHistory.actorUserId],
      references: [users.id],
    }),
  }),
);

export const applicationNotesRelations = relations(applicationNotes, ({ one }) => ({
  organisation: one(organisations, {
    fields: [applicationNotes.organisationId],
    references: [organisations.id],
  }),
  application: one(applications, {
    fields: [applicationNotes.applicationId],
    references: [applications.id],
  }),
  author: one(users, {
    fields: [applicationNotes.authorUserId],
    references: [users.id],
  }),
}));
