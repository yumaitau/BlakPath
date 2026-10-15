import { relations } from 'drizzle-orm';
import {
  boolean,
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
    /**
     * Minutes written by a person. The software stores the text; it does not
     * draft, summarise or approve it.
     */
    minutes: text('minutes'),
    minutesRecordedByUserId: refId('minutes_recorded_by_user_id').references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    minutesRecordedAt: timestamp('minutes_recorded_at', { withTimezone: true }),
    /**
     * Quorum attestation. Null until a person records it. Never derived from
     * a headcount — presence of quorum is a human act.
     */
    quorumPresent: boolean('quorum_present'),
    quorumNote: text('quorum_note'),
    quorumAttestedByUserId: refId('quorum_attested_by_user_id').references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    quorumAttestedAt: timestamp('quorum_attested_at', { withTimezone: true }),
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
  ],
);

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
  ],
);

/**
 * A person's attestation that a member was present or absent. This is not a
 * calculated roll: someone records it.
 */
export const meetingAttendance = pgTable(
  'meeting_attendance',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    meetingId: refId('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    userId: refId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    present: boolean('present').notNull(),
    note: text('note'),
    attestedByUserId: refId('attested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    index('meeting_attendance_org_meeting_idx').on(table.organisationId, table.meetingId),
    uniqueIndex('meeting_attendance_meeting_user_unique').on(
      table.meetingId,
      table.userId,
    ),
  ],
);

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
  ],
);

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
  attendance: many(meetingAttendance),
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

export const meetingAttendanceRelations = relations(meetingAttendance, ({ one }) => ({
  organisation: one(organisations, {
    fields: [meetingAttendance.organisationId],
    references: [organisations.id],
  }),
  meeting: one(meetings, {
    fields: [meetingAttendance.meetingId],
    references: [meetings.id],
  }),
  user: one(users, {
    fields: [meetingAttendance.userId],
    references: [users.id],
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
