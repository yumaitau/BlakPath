import { describe, expect, it } from 'vitest';
import { resolveMeetingLink } from '@/domains/decisions/meeting-link';

const MEETING = '018f5b3a-0000-7000-8000-000000000001';
const OTHER = '018f5b3a-0000-7000-8000-000000000002';

describe('resolveMeetingLink', () => {
  it('allows a decision with no meeting when the case is not on an agenda', () => {
    expect(
      resolveMeetingLink({
        agendaMeetingIds: [],
        requestedMeetingId: null,
        existingMeetingId: null,
      }),
    ).toEqual({ ok: true, meetingId: null });
  });

  it('requires a meeting once the case is on an agenda', () => {
    expect(resolveMeetingLink({ agendaMeetingIds: [MEETING] })).toEqual({
      ok: false,
      reason: 'meeting_required',
    });
  });

  it('records the meeting a person named when it is on the agenda', () => {
    expect(
      resolveMeetingLink({
        agendaMeetingIds: [MEETING, OTHER],
        requestedMeetingId: OTHER,
      }),
    ).toEqual({ ok: true, meetingId: OTHER });
  });

  it('rejects a meeting that is not on the agenda', () => {
    expect(
      resolveMeetingLink({
        agendaMeetingIds: [MEETING],
        requestedMeetingId: OTHER,
      }),
    ).toEqual({ ok: false, reason: 'not_on_agenda' });
  });

  it('keeps a meeting already stored on the decision', () => {
    expect(
      resolveMeetingLink({
        agendaMeetingIds: [MEETING],
        existingMeetingId: OTHER,
      }),
    ).toEqual({ ok: true, meetingId: OTHER });
  });

  it('does not move a decision onto a different meeting', () => {
    expect(
      resolveMeetingLink({
        agendaMeetingIds: [MEETING, OTHER],
        existingMeetingId: MEETING,
        requestedMeetingId: OTHER,
      }),
    ).toEqual({ ok: false, reason: 'meeting_changed' });
  });
});
