/**
 * Meetings domain (Phase 5).
 *
 *   - `schemas` — zod v4 input validation.
 *   - `service` — tenant-scoped, permission-checked, audited path: scheduling,
 *     agenda, meeting pack, conflicts, and calendar `.ics` import/export.
 */
export {
  addAgendaItemSchema,
  attestQuorumSchema,
  createMeetingSchema,
  declareConflictSchema,
  recordAttendanceSchema,
  recordMinutesSchema,
  type AddAgendaItemInput,
  type AttestQuorumInput,
  type CreateMeetingInput,
  type DeclareConflictInput,
  type RecordAttendanceInput,
  type RecordMinutesInput,
} from './schemas';

export {
  addAgendaItem,
  attestQuorum,
  cancelMeeting,
  clearConflict,
  createMeeting,
  declareConflict,
  exportMeetingsIcs,
  getMeeting,
  getMeetingPack,
  importMeetingsFromIcs,
  listAgenda,
  listAttendance,
  listMeetingConflicts,
  listMeetingRoster,
  listMeetings,
  listMeetingsForApplication,
  recordAttendance,
  recordMinutes,
  removeAgendaItem,
  type AgendaEntry,
  type AgendaItemRow,
  type AttendanceRow,
  type ConflictRow,
  type MeetingRow,
  type PackAgendaEntry,
  type PackDocument,
} from './service';
