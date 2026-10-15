/**
 * Which meeting a decision is tied to.
 *
 * Pure policy: the caller supplies the meetings whose agenda contains the
 * case. This does not infer an outcome, a quorum, or which meeting "must" be
 * the one — a person chooses. It only refuses to finalise in silence when the
 * case is already on an agenda and nobody has named the meeting.
 */

export type MeetingLinkFailure = 'meeting_required' | 'not_on_agenda' | 'meeting_changed';

export type MeetingLinkResult =
  { ok: true; meetingId: string | null } | { ok: false; reason: MeetingLinkFailure };

export function resolveMeetingLink(input: {
  requestedMeetingId?: string | null | undefined;
  existingMeetingId?: string | null | undefined;
  agendaMeetingIds: readonly string[];
}): MeetingLinkResult {
  const requested = input.requestedMeetingId ?? null;
  const existing = input.existingMeetingId ?? null;

  if (requested && existing && requested !== existing) {
    return { ok: false, reason: 'meeting_changed' };
  }

  const linked = requested ?? existing;
  if (!linked) {
    if (input.agendaMeetingIds.length > 0) {
      return { ok: false, reason: 'meeting_required' };
    }
    return { ok: true, meetingId: null };
  }

  const onAgenda = input.agendaMeetingIds.includes(linked);
  // A meeting already stored on the decision stays, even if that sitting was
  // later cancelled and dropped from the open agenda list.
  if (!onAgenda && linked !== existing) {
    return { ok: false, reason: 'not_on_agenda' };
  }

  return { ok: true, meetingId: linked };
}
