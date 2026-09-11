/**
 * Calendar domain — RangerOS parity.
 * schemas: zod validation. recurrence: pure RRULE expand + overlap.
 * service: tenant-scoped CRUD, attendees, reminders, conflict warnings.
 */
export {
  addAttendeeSchema,
  addReminderSchema,
  createCalendarEventSchema,
  updateCalendarEventSchema,
  type AddAttendeeInput,
  type AddReminderInput,
  type CreateCalendarEventInput,
  type UpdateCalendarEventInput,
} from './schemas';
export { expandOccurrences, overlaps, parseRrule } from './recurrence';
export {
  addAttendee,
  addReminder,
  countUpcoming,
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  listOccurrences,
  updateCalendarEvent,
  type CalendarEventRow,
} from './service';
