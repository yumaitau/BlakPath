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
import { organisations } from './tenancy';
import { meetings } from './meetings';

/**
 * RangerOS-parity calendar events. Tenant-owned, org-leading indexes.
 * Times stored timestamptz (UTC); `timezone` keeps authoring zone for
 * correct recurrence expansion. `rrule` holds RFC 5545 recurrence;
 * occurrences expand in service layer, never materialised infinitely.
 * Optional `meetingId` links committee meetings into calendar views.
 */

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    /** Bookable resource: room, vehicle, equipment name. */
    resource: text('resource'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }),
    allDay: boolean('all_day').notNull().default(false),
    /** RFC 5545 RRULE string, e.g. `FREQ=WEEKLY;COUNT=6`. Null = single. */
    rrule: text('rrule'),
    /** IANA zone where event authored, e.g. `Australia/Sydney`. */
    timezone: text('timezone').notNull().default('Australia/Sydney'),
    /** `scheduled` | `cancelled` | `completed` (app-checked). */
    status: text('status').notNull().default('scheduled'),
    meetingId: refId('meeting_id').references(() => meetings.id, {
      onDelete: 'set null',
    }),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('calendar_events_org_start_idx').on(table.organisationId, table.startAt),
    index('calendar_events_org_status_idx').on(table.organisationId, table.status),
    index('calendar_events_org_resource_idx').on(table.organisationId, table.resource),
    index('calendar_events_org_meeting_idx').on(table.organisationId, table.meetingId),
  ],
);

export const calendarEventAttendees = pgTable(
  'calendar_event_attendees',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    eventId: refId('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    userId: refId('user_id').references(() => users.id, { onDelete: 'set null' }),
    email: text('email'),
    displayName: text('display_name'),
    /** needs-action | accepted | declined | tentative (app-checked). */
    responseStatus: text('response_status').notNull().default('needs-action'),
    ...timestamps,
  },
  (table) => [
    index('calendar_attendees_org_event_idx').on(table.organisationId, table.eventId),
    index('calendar_attendees_org_user_idx').on(table.organisationId, table.userId),
    index('calendar_attendees_org_email_idx').on(table.organisationId, table.email),
  ],
);

export const calendarEventReminders = pgTable(
  'calendar_event_reminders',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    eventId: refId('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    minutesBefore: integer('minutes_before').notNull().default(30),
    /** in-app | email (app-checked). */
    channel: text('channel').notNull().default('in-app'),
    /** When the reminder was dispatched; null = pending. */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('calendar_reminders_org_event_idx').on(table.organisationId, table.eventId),
  ],
);

export const calendarEventsRelations = relations(calendarEvents, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [calendarEvents.organisationId],
    references: [organisations.id],
  }),
  meeting: one(meetings, {
    fields: [calendarEvents.meetingId],
    references: [meetings.id],
  }),
  createdBy: one(users, {
    fields: [calendarEvents.createdByUserId],
    references: [users.id],
  }),
  attendees: many(calendarEventAttendees),
  reminders: many(calendarEventReminders),
}));

export const calendarEventAttendeesRelations = relations(
  calendarEventAttendees,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [calendarEventAttendees.organisationId],
      references: [organisations.id],
    }),
    event: one(calendarEvents, {
      fields: [calendarEventAttendees.eventId],
      references: [calendarEvents.id],
    }),
    user: one(users, {
      fields: [calendarEventAttendees.userId],
      references: [users.id],
    }),
  }),
);

export const calendarEventRemindersRelations = relations(
  calendarEventReminders,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [calendarEventReminders.organisationId],
      references: [organisations.id],
    }),
    event: one(calendarEvents, {
      fields: [calendarEventReminders.eventId],
      references: [calendarEvents.id],
    }),
  }),
);
