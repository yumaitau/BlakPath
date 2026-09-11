import { z } from 'zod';

/** Input validation for calendar domain (zod v4). */

const exdateSchema = z
  .string()
  .trim()
  .max(2000)
  .regex(/^(\d{8}T\d{6}Z)(,\d{8}T\d{6}Z)*$/, {
    message: 'Exceptions must be comma-separated UTC timestamps.',
  });

export const createCalendarEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).optional(),
    location: z.string().trim().max(300).optional(),
    resource: z.string().trim().max(200).optional(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date().optional(),
    allDay: z.boolean().optional(),
    rrule: z
      .string()
      .trim()
      .max(300)
      .regex(/^FREQ=(DAILY|WEEKLY);(COUNT=\d{1,3}|UNTIL=\d{8}T\d{6}Z)$/, {
        message: 'Recurrence must be FREQ=DAILY|WEEKLY with COUNT or UNTIL.',
      })
      .optional(),
    timezone: z.string().trim().max(100).optional(),
    meetingId: z.uuid().optional(),
    exdate: exdateSchema.optional(),
    /** Acknowledge resource conflicts and save anyway (warn-only tenants). */
    force: z.boolean().optional(),
  })
  .refine((v) => !v.endAt || v.endAt > v.startAt, {
    message: 'Event must end after it starts.',
    path: ['endAt'],
  });
export type CreateCalendarEventInput = z.input<typeof createCalendarEventSchema>;

export const updateCalendarEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    location: z.string().trim().max(300).nullable().optional(),
    resource: z.string().trim().max(200).nullable().optional(),
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().nullable().optional(),
    allDay: z.boolean().optional(),
    rrule: z
      .string()
      .trim()
      .max(300)
      .regex(/^FREQ=(DAILY|WEEKLY);(COUNT=\d{1,3}|UNTIL=\d{8}T\d{6}Z)$/)
      .nullable()
      .optional(),
    status: z.enum(['scheduled', 'cancelled', 'completed']).optional(),
    exdate: exdateSchema.nullable().optional(),
    /** Acknowledge resource conflicts and save anyway (warn-only tenants). */
    force: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.startAt !== undefined || v.status !== undefined || v.location !== undefined || v.description !== undefined || v.resource !== undefined || v.endAt !== undefined || v.allDay !== undefined || v.rrule !== undefined || v.exdate !== undefined, {
    message: 'At least one field must change.',
  });
export type UpdateCalendarEventInput = z.input<typeof updateCalendarEventSchema>;

export const addAttendeeSchema = z.object({
  userId: z.uuid().optional(),
  email: z.email().max(320).optional(),
  displayName: z.string().trim().max(200).optional(),
});
export type AddAttendeeInput = z.input<typeof addAttendeeSchema>;

export const addReminderSchema = z.object({
  minutesBefore: z.coerce.number().int().min(0).max(10080),
  channel: z.enum(['in-app', 'email']).optional(),
});
export type AddReminderInput = z.input<typeof addReminderSchema>;
