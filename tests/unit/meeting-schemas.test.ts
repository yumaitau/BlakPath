import { describe, expect, it } from 'vitest';
import {
  addAgendaItemSchema,
  attestQuorumSchema,
  createMeetingSchema,
  declareConflictSchema,
  recordAttendanceSchema,
  recordMinutesSchema,
} from '@/domains/meetings/schemas';
import {
  finaliseDecisionSchema,
  proposeDecisionSchema,
} from '@/domains/decisions/schemas';

const UUID = '018f5b3a-0000-7000-8000-000000000000';

describe('createMeetingSchema', () => {
  it('requires a title and start, coercing dates', () => {
    const parsed = createMeetingSchema.parse({
      title: 'August sitting',
      scheduledStart: '2026-08-01T09:00:00.000Z',
    });
    expect(parsed.scheduledStart).toBeInstanceOf(Date);
    expect(createMeetingSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects an end that is not after the start', () => {
    expect(
      createMeetingSchema.safeParse({
        title: 'x',
        scheduledStart: '2026-08-01T10:00:00.000Z',
        scheduledEnd: '2026-08-01T09:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('addAgendaItemSchema / declareConflictSchema', () => {
  it('agenda item requires a uuid application id', () => {
    expect(addAgendaItemSchema.safeParse({ applicationId: 'nope' }).success).toBe(false);
    expect(addAgendaItemSchema.safeParse({ applicationId: UUID }).success).toBe(true);
  });

  it('conflict declaration requires a uuid application id', () => {
    expect(declareConflictSchema.safeParse({ applicationId: UUID }).success).toBe(true);
    expect(
      declareConflictSchema.safeParse({ applicationId: UUID, meetingId: 'bad' }).success,
    ).toBe(false);
  });
});

describe('attendance, quorum and minutes', () => {
  it('attendance is an explicit present/absent record for a member', () => {
    expect(
      recordAttendanceSchema.safeParse({ userId: UUID, present: true }).success,
    ).toBe(true);
    expect(
      recordAttendanceSchema.safeParse({ userId: UUID, present: 'yes' }).success,
    ).toBe(false);
  });

  it('quorum is a boolean attestation, not a headcount', () => {
    expect(attestQuorumSchema.safeParse({ present: false }).success).toBe(true);
    expect(attestQuorumSchema.safeParse({ present: 3 }).success).toBe(false);
  });

  it('minutes must contain text a person wrote', () => {
    expect(recordMinutesSchema.safeParse({ minutes: '  ' }).success).toBe(false);
    expect(recordMinutesSchema.safeParse({ minutes: 'The committee sat.' }).success).toBe(
      true,
    );
  });
});

describe('decision meeting link inputs', () => {
  it('accepts an optional meeting id on propose and finalise', () => {
    expect(
      proposeDecisionSchema.safeParse({ outcome: 'deferred', meetingId: UUID }).success,
    ).toBe(true);
    expect(
      finaliseDecisionSchema.safeParse({ outcome: 'confirmed', meetingId: 'nope' })
        .success,
    ).toBe(false);
    expect(finaliseDecisionSchema.safeParse({ outcome: 'confirmed' }).success).toBe(true);
  });
});
