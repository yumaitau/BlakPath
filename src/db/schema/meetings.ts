import { relations } from 'drizzle-orm';
import {
  integer,
  index,
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
import { conflictStatus, meetingStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { applications } from './applications';
import { tenantIsolationPolicy } from './_rls';

/**
 * Meeting tables (Phase 5).
 *
 * A meeting is a scheduled committee sitting. Its agenda lists the applications
 * to be considered; the confidential "pack" is the agenda plus the supporting
 * material, access to which is permission-gated and audited. Conflicts of
 * interest are declared against a meeting item so a conflicted member is kept
 * out of the corresponding vote/decision. All tenant-owned, org-leading indexed.
 */
export const meetings = pgTable(
  'meetings',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    scheduledStart: timestamp('scheduled_start', { withTimezone: true }).notNull(),
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }),
    location: text('location'),
    status: meetingStatus('status').notNull().default('scheduled'),
    notes: text('notes'),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
    ...rowVersion,
    ...softDelete,
  },
  (table) => [
    index('meetings_org_start_idx').on(table.organisationId, table.scheduledStart),
    index('meetings_org_status_idx').on(table.organisationId, table.status),
    tenantIsolationPolicy(),
  ],
).enableRLS();

/** An application placed on a meeting's agenda, in a given position. */
export const meetingAgendaItems = pgTable(
  'meeting_agenda_items',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    meetingId: refId('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    notes: text('notes'),
    ...timestamps,
  },
  (table) => [
    index('meeting_agenda_items_org_meeting_idx').on(
      table.organisationId,
      table.meetingId,
    ),
    uniqueIndex('meeting_agenda_items_meeting_application_unique').on(
      table.meetingId,
      table.applicationId,
    ),
    tenantIsolationPolicy(),
  ],
).enableRLS();

/**
 * A declared conflict of interest. Tied to an application (and optionally a
 * specific meeting), it keeps the declaring member out of that application's
 * vote and decision until cleared.
 */
export const conflictDeclarations = pgTable(
  'conflict_declarations',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    meetingId: refId('meeting_id').references(() => meetings.id, {
      onDelete: 'set null',
    }),
    declaredByUserId: refId('declared_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: conflictStatus('status').notNull().default('declared'),
    reason: text('reason'),
    clearedByUserId: refId('cleared_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('conflict_declarations_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
    index('conflict_declarations_org_meeting_idx').on(
      table.organisationId,
      table.meetingId,
    ),
    tenantIsolationPolicy(),
  ],
).enableRLS();

export const meetingsRelations = relations(meetings, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [meetings.organisationId],
    references: [organisations.id],
  }),
  createdBy: one(users, {
    fields: [meetings.createdByUserId],
    references: [users.id],
  }),
  agendaItems: many(meetingAgendaItems),
}));

export const meetingAgendaItemsRelations = relations(meetingAgendaItems, ({ one }) => ({
  organisation: one(organisations, {
    fields: [meetingAgendaItems.organisationId],
    references: [organisations.id],
  }),
  meeting: one(meetings, {
    fields: [meetingAgendaItems.meetingId],
    references: [meetings.id],
  }),
  application: one(applications, {
    fields: [meetingAgendaItems.applicationId],
    references: [applications.id],
  }),
}));

export const conflictDeclarationsRelations = relations(
  conflictDeclarations,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [conflictDeclarations.organisationId],
      references: [organisations.id],
    }),
    application: one(applications, {
      fields: [conflictDeclarations.applicationId],
      references: [applications.id],
    }),
    meeting: one(meetings, {
      fields: [conflictDeclarations.meetingId],
      references: [meetings.id],
    }),
    declaredBy: one(users, {
      fields: [conflictDeclarations.declaredByUserId],
      references: [users.id],
    }),
  }),
);
