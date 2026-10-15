import { z } from 'zod';

/** Input validation for the meetings domain (zod v4). */

/** Schedule a committee meeting. */
export const createMeetingSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    scheduledStart: z.coerce.date(),
    scheduledEnd: z.coerce.date().optional(),
    location: z.string().trim().max(300).optional(),
    notes: z.string().trim().max(5000).optional(),
  })
  .refine((v) => !v.scheduledEnd || v.scheduledEnd > v.scheduledStart, {
    message: 'The meeting must end after it starts.',
    path: ['scheduledEnd'],
  });
export type CreateMeetingInput = z.input<typeof createMeetingSchema>;

/** Add an application to a meeting agenda. */
export const addAgendaItemSchema = z.object({
  applicationId: z.uuid(),
  position: z.coerce.number().int().min(0).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type AddAgendaItemInput = z.input<typeof addAgendaItemSchema>;

/** Declare a conflict of interest against an application (optionally a meeting). */
export const declareConflictSchema = z.object({
  applicationId: z.uuid(),
  meetingId: z.uuid().optional(),
  reason: z.string().trim().max(2000).optional(),
});
export type DeclareConflictInput = z.input<typeof declareConflictSchema>;

/** A person records whether a member was in the room. */
export const recordAttendanceSchema = z.object({
  userId: z.uuid(),
  present: z.boolean(),
  note: z.string().trim().max(2000).optional(),
});
export type RecordAttendanceInput = z.input<typeof recordAttendanceSchema>;

/**
 * A person attests whether quorum was present. `present` is their record,
 * not a count of attendance rows.
 */
export const attestQuorumSchema = z.object({
  present: z.boolean(),
  note: z.string().trim().max(2000).optional(),
});
export type AttestQuorumInput = z.input<typeof attestQuorumSchema>;

/** Minutes text entered by a person. */
export const recordMinutesSchema = z.object({
  minutes: z.string().trim().min(1).max(20000),
});
export type RecordMinutesInput = z.input<typeof recordMinutesSchema>;
