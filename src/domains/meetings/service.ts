import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  applications,
  conflictDeclarations,
  evidence,
  meetingAgendaItems,
  meetingAttendance,
  meetings,
  memberships,
  users,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  hasAny,
  hasPermission,
  requireAny,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { transitionApplication } from '@/domains/applications';
import { ApplicationWorkflowError } from '@/domains/applications/workflow';
import { ConcurrencyConflictError } from '@/lib/concurrency/error';
import { logger } from '@/lib/observability/logger';
import { buildIcs, parseIcs, type IcsEvent } from '@/lib/calendar/ics';
import {
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

/**
 * Meetings service — tenant-scoped, permission-checked, audited.
 *
 * Scheduling and agenda management, the confidential meeting pack, and conflict
 * declarations. Also the calendar import/export: meetings serialise to RFC 5545
 * `.ics` and can be created from an uploaded `.ics`. None of this determines an
 * application — meetings only organise the human committee process.
 */

export type MeetingRow = typeof meetings.$inferSelect;
export type AgendaItemRow = typeof meetingAgendaItems.$inferSelect;
export type ConflictRow = typeof conflictDeclarations.$inferSelect;
export type AttendanceRow = typeof meetingAttendance.$inferSelect;

/** Agenda row plus the case reference a person needs in order to run the sitting. */
export interface AgendaEntry extends AgendaItemRow {
  reference: string;
  applicationStatus: string;
}

export interface PackDocument {
  id: string;
  fileName: string;
  status: string;
  classification: string | null;
}

export interface PackAgendaEntry extends AgendaEntry {
  documents: PackDocument[];
}

/** Capabilities that permit reading meetings/agendas. */
const MEETING_READ = [
  'meeting:pack-access',
  'meeting:create',
  'meeting:agenda-manage',
] as const;

/** Who may record quorum and minutes: the people who run the sitting. */
const MEETING_RUN = ['meeting:agenda-manage', 'meeting:create'] as const;

/** A member may attest their own attendance without running the agenda. */
const SELF_ATTENDANCE = [
  'decision:vote',
  'meeting:pack-access',
  'conflict:declare',
] as const;

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${what} to be returned from the database.`);
  }
  return row;
}

async function loadMeeting(id: string): Promise<MeetingRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(meetings)
    .where(
      scope.where(
        meetings.organisationId,
        eq(meetings.id, id),
        isNull(meetings.deletedAt),
      ),
    )
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

async function loadAgendaEntries(meetingId: string): Promise<AgendaEntry[]> {
  const scope = currentScope();
  const rows = await scope.db
    .select({
      item: meetingAgendaItems,
      reference: applications.reference,
      applicationStatus: applications.status,
    })
    .from(meetingAgendaItems)
    .innerJoin(applications, eq(applications.id, meetingAgendaItems.applicationId))
    .where(
      scope.where(
        meetingAgendaItems.organisationId,
        eq(meetingAgendaItems.meetingId, meetingId),
        isNull(applications.deletedAt),
      ),
    )
    .orderBy(asc(meetingAgendaItems.position), asc(meetingAgendaItems.createdAt));

  return rows.map((row) => ({
    ...row.item,
    reference: row.reference,
    applicationStatus: row.applicationStatus,
  }));
}

/** Schedule a committee meeting. */
export async function createMeeting(rawInput: CreateMeetingInput): Promise<MeetingRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:create');

  const input = createMeetingSchema.parse(rawInput);
  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(meetings)
      .values(
        scope.insertValues({
          title: input.title,
          scheduledStart: input.scheduledStart,
          scheduledEnd: input.scheduledEnd ?? null,
          location: input.location ?? null,
          notes: input.notes ?? null,
          createdByUserId: ctx.userId,
          status: 'scheduled',
        }),
      )
      .returning();
    const row = must(inserted[0], 'meeting');

    await recordAudit(
      {
        action: 'meeting.created',
        resourceType: 'meeting',
        resourceId: row.id,
        result: 'success',
        after: { data: { title: row.title }, allow: ['title'] },
      },
      tx,
    );

    return row;
  });
}

/** Cancel a scheduled meeting. */
export async function cancelMeeting(meetingId: string): Promise<MeetingRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:create');

  const existing = await loadMeeting(meetingId);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(meetings)
      .set({ status: 'cancelled' })
      .where(scope.where(meetings.organisationId, eq(meetings.id, meetingId)))
      .returning();
    const row = must(updated[0], 'meeting');

    await recordAudit(
      {
        action: 'meeting.cancelled',
        resourceType: 'meeting',
        resourceId: meetingId,
        result: 'success',
      },
      tx,
    );

    return row;
  });
}

/** One meeting the actor may read. Missing and out-of-tenant look the same. */
export async function getMeeting(meetingId: string): Promise<MeetingRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), MEETING_READ);
  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');
  return meeting;
}

/** List meetings in the tenant (for the calendar view). */
export async function listMeetings(): Promise<MeetingRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), MEETING_READ);

  const scope = currentScope();
  return scope.db
    .select()
    .from(meetings)
    .where(scope.where(meetings.organisationId, isNull(meetings.deletedAt)))
    .orderBy(asc(meetings.scheduledStart));
}

/** Add an application to a meeting's agenda. */
export async function addAgendaItem(
  meetingId: string,
  rawInput: AddAgendaItemInput,
): Promise<AgendaItemRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:agenda-manage');

  const input = addAgendaItemSchema.parse(rawInput);
  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const existing = await scope.db
    .select({ id: meetingAgendaItems.id })
    .from(meetingAgendaItems)
    .where(
      scope.where(
        meetingAgendaItems.organisationId,
        eq(meetingAgendaItems.meetingId, meetingId),
        eq(meetingAgendaItems.applicationId, input.applicationId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw new AuthorizationError('POLICY_DENIED', 'That case is already on the agenda.');
  }

  let position = input.position;
  if (position === undefined) {
    const last = await scope.db
      .select({ position: meetingAgendaItems.position })
      .from(meetingAgendaItems)
      .where(
        scope.where(
          meetingAgendaItems.organisationId,
          eq(meetingAgendaItems.meetingId, meetingId),
        ),
      )
      .orderBy(desc(meetingAgendaItems.position))
      .limit(1);
    position = last[0] ? last[0].position + 1 : 0;
  }


  const row = await scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(meetingAgendaItems)
      .values(
        scope.insertValues({
          meetingId,
          applicationId: input.applicationId,
          position,
          notes: input.notes ?? null,
        }),
      )
      .returning();
    const insertedRow = must(inserted[0], 'agenda item');

    await recordAudit(
      {
        action: 'meeting.agenda_changed',
        resourceType: 'agenda_item',
        resourceId: insertedRow.id,
        result: 'success',
        after: {
          data: { meetingId, applicationId: input.applicationId },
          allow: ['meetingId', 'applicationId'],
        },
      },
      tx,
    );
    return insertedRow;
  });

  // Best-effort: placing a matter on the agenda advances it into the committee
  // stage. Only legal from `ready_for_committee`. A lost race means another
  // request already moved it. Either way the agenda item stays.
  try {
    await transitionApplication(input.applicationId, 'schedule_committee');
  } catch (error) {
    if (
      !(error instanceof ApplicationWorkflowError) &&
      !(error instanceof ConcurrencyConflictError)
    ) {
      throw error;
    }
    logger.debug(
      { applicationId: input.applicationId, meetingId },
      'agenda add: application not in a schedulable state — leaving status unchanged',
    );
  }

  return row;
}

/** Remove an application from a meeting's agenda. */
export async function removeAgendaItem(itemId: string): Promise<void> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:agenda-manage');

  const scope = currentScope();
  await scope.db.transaction(async (tx) => {
    await tx
      .delete(meetingAgendaItems)
      .where(
        scope.where(meetingAgendaItems.organisationId, eq(meetingAgendaItems.id, itemId)),
      );

    await recordAudit(
      {
        action: 'meeting.agenda_changed',
        resourceType: 'agenda_item',
        resourceId: itemId,
        result: 'success',
      },
      tx,
    );
  });
}

/**
 * The confidential meeting pack: the sitting, its ordered agenda, case
 * references, and document names. Evidence bytes stay behind the download
 * permission. Viewing and refusal are both audited.
 */
export async function getMeetingPack(
  meetingId: string,
): Promise<{ meeting: MeetingRow; agenda: PackAgendaEntry[] }> {
  const ctx = requireTenantContext();
  const subject = subjectFromContext(ctx);
  if (!hasPermission(subject, 'meeting:pack-access')) {
    await recordAudit({
      action: 'meeting_pack.viewed',
      resourceType: 'meeting_pack',
      resourceId: meetingId,
      result: 'denied',
    });
    throw new AuthorizationError('PERMISSION_DENIED');
  }

  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');

  const agenda = await loadAgendaEntries(meetingId);
  const applicationIds = agenda.map((item) => item.applicationId);
  const scope = currentScope();
  const documents =
    applicationIds.length === 0
      ? []
      : await scope.db
          .select({
            id: evidence.id,
            applicationId: evidence.applicationId,
            fileName: evidence.fileName,
            status: evidence.status,
            classification: evidence.classification,
          })
          .from(evidence)
          .where(
            scope.where(
              evidence.organisationId,
              inArray(evidence.applicationId, applicationIds),
              isNull(evidence.deletedAt),
            ),
          )
          .orderBy(asc(evidence.createdAt));

  const byApplication = new Map<string, PackDocument[]>();
  for (const document of documents) {
    const list = byApplication.get(document.applicationId) ?? [];
    list.push({
      id: document.id,
      fileName: document.fileName,
      status: document.status,
      classification: document.classification,
    });
    byApplication.set(document.applicationId, list);
  }

  await recordAudit({
    action: 'meeting_pack.viewed',
    resourceType: 'meeting_pack',
    resourceId: meetingId,
    result: 'success',
  });

  return {
    meeting,
    agenda: agenda.map((item) => ({
      ...item,
      documents: byApplication.get(item.applicationId) ?? [],
    })),
  };
}

/** Declare a conflict of interest on an application (optionally a meeting). */
export async function declareConflict(
  rawInput: DeclareConflictInput,
): Promise<ConflictRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'conflict:declare');

  const input = declareConflictSchema.parse(rawInput);
  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(conflictDeclarations)
      .values(
        scope.insertValues({
          applicationId: input.applicationId,
          meetingId: input.meetingId ?? null,
          declaredByUserId: ctx.userId,
          reason: input.reason ?? null,
          status: 'declared',
        }),
      )
      .returning();
    const row = must(inserted[0], 'conflict declaration');

    await recordAudit(
      {
        action: 'conflict.declared',
        resourceType: 'conflict',
        resourceId: row.id,
        result: 'success',
        after: { data: { applicationId: input.applicationId }, allow: ['applicationId'] },
      },
      tx,
    );

    return row;
  });
}

/** Clear a previously declared conflict (agenda managers). */
export async function clearConflict(conflictId: string): Promise<ConflictRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:agenda-manage');

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(conflictDeclarations)
      .set({ status: 'cleared', clearedByUserId: ctx.userId, clearedAt: new Date() })
      .where(
        scope.where(
          conflictDeclarations.organisationId,
          eq(conflictDeclarations.id, conflictId),
        ),
      )
      .returning();
    if (!updated[0]) throw new AuthorizationError('POLICY_DENIED');
    const row = must(updated[0], 'conflict declaration');

    await recordAudit(
      {
        action: 'conflict.cleared',
        resourceType: 'conflict',
        resourceId: conflictId,
        result: 'success',
      },
      tx,
    );

    return row;
  });
}

/* ---------------------------------------------------------------------------
 * Calendar import / export (RFC 5545 .ics)
 * ------------------------------------------------------------------------- */

/** Map a meeting row to a calendar event. */
function meetingToIcsEvent(meeting: MeetingRow): IcsEvent {
  return {
    uid: `${meeting.id}@blakpath`,
    start: meeting.scheduledStart,
    ...(meeting.scheduledEnd ? { end: meeting.scheduledEnd } : {}),
    summary: meeting.title,
    description: meeting.notes,
    location: meeting.location,
    status: meeting.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    categories: ['Committee meeting'],
  };
}

/** Export the tenant's meetings as an RFC 5545 `.ics` document. */
export async function exportMeetingsIcs(now: Date): Promise<string> {
  const rows = await listMeetings(); // enforces read permission
  return buildIcs({
    events: rows.map(meetingToIcsEvent),
    calendarName: 'BlakPath Committee Meetings',
    now,
  });
}

/**
 * Create meetings from an uploaded `.ics`. Each VEVENT with a start becomes a
 * scheduled meeting. Returns the number created. Requires `meeting:create`.
 */
export async function importMeetingsFromIcs(
  icsText: string,
): Promise<{ created: number }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:create');

  const parsed = parseIcs(icsText);
  if (parsed.length === 0) return { created: 0 };

  const scope = currentScope();
  let created = 0;
  for (const event of parsed) {
    await scope.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(meetings)
        .values(
          scope.insertValues({
            title: event.summary || 'Imported meeting',
            scheduledStart: event.start,
            scheduledEnd: event.end ?? null,
            location: event.location ?? null,
            notes: event.description ?? null,
            createdByUserId: ctx.userId,
            status: 'scheduled',
          }),
        )
        .returning();
      const row = must(inserted[0], 'meeting');
      await recordAudit(
        {
          action: 'meeting.created',
          resourceType: 'meeting',
          resourceId: row.id,
          result: 'success',
          reason: 'meeting.imported',
          after: { data: { title: row.title }, allow: ['title'] },
        },
        tx,
      );
    });
    created += 1;
  }

  return { created };
}

/** List a meeting's agenda in sitting order, with case references. */
export async function listAgenda(meetingId: string): Promise<AgendaEntry[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), MEETING_READ);
  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');
  return loadAgendaEntries(meetingId);
}

/** Meetings still on the books whose agenda contains this case. */
export async function listMeetingsForApplication(
  applicationId: string,
): Promise<Array<{ id: string; title: string; scheduledStart: Date }>> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), [
    ...MEETING_READ,
    'decision:propose',
    'decision:vote',
    'decision:finalise',
  ]);
  const scope = currentScope();
  return scope.db
    .select({
      id: meetings.id,
      title: meetings.title,
      scheduledStart: meetings.scheduledStart,
    })
    .from(meetingAgendaItems)
    .innerJoin(meetings, eq(meetings.id, meetingAgendaItems.meetingId))
    .where(
      scope.where(
        meetingAgendaItems.organisationId,
        eq(meetingAgendaItems.applicationId, applicationId),
        isNull(meetings.deletedAt),
        ne(meetings.status, 'cancelled'),
      ),
    )
    .orderBy(asc(meetings.scheduledStart));
}

/** Conflicts that keep someone out of a case on this sitting. */
export async function listMeetingConflicts(meetingId: string): Promise<ConflictRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), MEETING_READ);
  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');

  const agenda = await loadAgendaEntries(meetingId);
  const applicationIds = agenda.map((item) => item.applicationId);
  const scope = currentScope();
  return scope.db
    .select()
    .from(conflictDeclarations)
    .where(
      scope.where(
        conflictDeclarations.organisationId,
        applicationIds.length > 0
          ? inArray(conflictDeclarations.applicationId, applicationIds)
          : eq(conflictDeclarations.meetingId, meetingId),
      ),
    )
    .orderBy(desc(conflictDeclarations.createdAt));
}

/** Active members, so a person can record who was in the room. */
export async function listMeetingRoster(): Promise<
  Array<{ userId: string; name: string }>
> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), MEETING_READ);
  const scope = currentScope();
  return scope.db
    .select({ userId: users.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organisationId, scope.organisationId),
        eq(memberships.status, 'active'),
      ),
    )
    .orderBy(asc(users.name));
}

/** Attendance already attested for this meeting. */
export async function listAttendance(meetingId: string): Promise<AttendanceRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), MEETING_READ);
  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');
  const scope = currentScope();
  return scope.db
    .select()
    .from(meetingAttendance)
    .where(
      scope.where(
        meetingAttendance.organisationId,
        eq(meetingAttendance.meetingId, meetingId),
      ),
    )
    .orderBy(asc(meetingAttendance.createdAt));
}

/**
 * Record that a member was present or absent. Agenda managers may record
 * anyone; a member may attest only themselves. Nothing here is counted into
 * quorum.
 */
export async function recordAttendance(
  meetingId: string,
  rawInput: RecordAttendanceInput,
): Promise<AttendanceRow> {
  const ctx = requireTenantContext();
  const subject = subjectFromContext(ctx);
  const input = recordAttendanceSchema.parse(rawInput);
  const managing = hasAny(subject, MEETING_RUN);
  const self = input.userId === ctx.userId && hasAny(subject, SELF_ATTENDANCE);
  if (!managing && !self) {
    throw new AuthorizationError('PERMISSION_DENIED');
  }

  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const member = await scope.db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.organisationId, scope.organisationId),
        eq(memberships.userId, input.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .limit(1);
  if (!member[0]) throw new AuthorizationError('POLICY_DENIED');

  const saved = await scope.db
    .insert(meetingAttendance)
    .values(
      scope.insertValues({
        meetingId,
        userId: input.userId,
        present: input.present,
        note: input.note ?? null,
        attestedByUserId: ctx.userId,
      }),
    )
    .onConflictDoUpdate({
      target: [meetingAttendance.meetingId, meetingAttendance.userId],
      set: {
        present: input.present,
        note: input.note ?? null,
        attestedByUserId: ctx.userId,
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = must(saved[0], 'attendance');

  await recordAudit({
    action: 'meeting.attendance_recorded',
    resourceType: 'meeting',
    resourceId: meetingId,
    result: 'success',
    after: {
      data: { userId: input.userId, present: input.present },
      allow: ['userId', 'present'],
    },
  });

  return row;
}

/** A person attests whether quorum was present. Not computed from attendance. */
export async function attestQuorum(
  meetingId: string,
  rawInput: AttestQuorumInput,
): Promise<MeetingRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), MEETING_RUN);
  const input = attestQuorumSchema.parse(rawInput);
  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const updated = await scope.db
    .update(meetings)
    .set({
      quorumPresent: input.present,
      quorumNote: input.note ?? null,
      quorumAttestedByUserId: ctx.userId,
      quorumAttestedAt: new Date(),
    })
    .where(scope.where(meetings.organisationId, eq(meetings.id, meetingId)))
    .returning();
  const row = must(updated[0], 'meeting');

  await recordAudit({
    action: 'meeting.quorum_attested',
    resourceType: 'meeting',
    resourceId: meetingId,
    result: 'success',
    after: { data: { present: input.present }, allow: ['present'] },
  });

  return row;
}

/** Store minutes written by a person. Does not close the meeting. */
export async function recordMinutes(
  meetingId: string,
  rawInput: RecordMinutesInput,
): Promise<MeetingRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), MEETING_RUN);
  const input = recordMinutesSchema.parse(rawInput);
  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const updated = await scope.db
    .update(meetings)
    .set({
      minutes: input.minutes,
      minutesRecordedByUserId: ctx.userId,
      minutesRecordedAt: new Date(),
    })
    .where(scope.where(meetings.organisationId, eq(meetings.id, meetingId)))
    .returning();
  const row = must(updated[0], 'meeting');

  await recordAudit({
    action: 'meeting.minutes_recorded',
    resourceType: 'meeting',
    resourceId: meetingId,
    result: 'success',
  });

  return row;
}
