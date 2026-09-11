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
export { expandOccurrences, formatExdates, overlaps, parseExdates, parseRrule } from './recurrence';
export { CalendarConflictError } from './errors';
export {
  addAttendee,
  addReminder,
  countUpcoming,
  createCalendarEvent,
  deleteCalendarEvent,
  inviteAttendees,
  listCalendarEvents,
  listOccurrences,
  processReminderSweep,
  respondAttendee,
  updateCalendarEvent,
  type CalendarEventRow,
} from './service';
