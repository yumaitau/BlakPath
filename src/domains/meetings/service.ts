import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { conflictDeclarations, meetingAgendaItems, meetings } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  requireAny,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { transitionApplication } from '@/domains/applications';
import { ApplicationWorkflowError } from '@/domains/applications/workflow';
import { logger } from '@/lib/observability/logger';
import { buildIcs, parseIcs, type IcsEvent } from '@/lib/calendar/ics';
import {
  addAgendaItemSchema,
  createMeetingSchema,
  declareConflictSchema,
  type AddAgendaItemInput,
  type CreateMeetingInput,
  type DeclareConflictInput,
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

/** Capabilities that permit reading meetings/agendas. */
const MEETING_READ = [
  'meeting:pack-access',
  'meeting:create',
  'meeting:agenda-manage',
] as const;

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

/** Schedule a committee meeting. */
export async function createMeeting(rawInput: CreateMeetingInput): Promise<MeetingRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:create');

  const input = createMeetingSchema.parse(rawInput);
  const scope = currentScope();
  const inserted = await scope.db
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
  const row = expectRow(inserted[0], 'meeting');

  await recordAudit({
    action: 'meeting.created',
    resourceType: 'meeting',
    resourceId: row.id,
    result: 'success',
    after: { data: { title: row.title }, allow: ['title'] },
  });

  return row;
}

/** Cancel a scheduled meeting. */
export async function cancelMeeting(meetingId: string): Promise<MeetingRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:create');

  const existing = await loadMeeting(meetingId);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const updated = await scope.db
    .update(meetings)
    .set({ status: 'cancelled' })
    .where(scope.where(meetings.organisationId, eq(meetings.id, meetingId)))
    .returning();
  const row = expectRow(updated[0], 'meeting');

  await recordAudit({
    action: 'meeting.cancelled',
    resourceType: 'meeting',
    resourceId: meetingId,
    result: 'success',
  });

  return row;
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
  const inserted = await scope.db
    .insert(meetingAgendaItems)
    .values(
      scope.insertValues({
        meetingId,
        applicationId: input.applicationId,
        position: input.position ?? 0,
        notes: input.notes ?? null,
      }),
    )
    .returning();
  const row = expectRow(inserted[0], 'agenda item');

  await recordAudit({
    action: 'meeting.agenda_changed',
    resourceType: 'agenda_item',
    resourceId: row.id,
    result: 'success',
    after: {
      data: { meetingId, applicationId: input.applicationId },
      allow: ['meetingId', 'applicationId'],
    },
  });

  // Best-effort: placing a matter on the agenda advances it into the committee
  // stage. Only legal from `ready_for_committee`; an application in any other
  // state simply stays put (agenda management must not fail because of it).
  try {
    await transitionApplication(input.applicationId, 'schedule_committee');
  } catch (error) {
    if (!(error instanceof ApplicationWorkflowError)) throw error;
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
  await scope.db
    .delete(meetingAgendaItems)
    .where(
      scope.where(meetingAgendaItems.organisationId, eq(meetingAgendaItems.id, itemId)),
    );

  await recordAudit({
    action: 'meeting.agenda_changed',
    resourceType: 'agenda_item',
    resourceId: itemId,
    result: 'success',
  });
}

/** The confidential meeting pack: the meeting plus its ordered agenda. */
export async function getMeetingPack(
  meetingId: string,
): Promise<{ meeting: MeetingRow; agenda: AgendaItemRow[] }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:pack-access');

  const meeting = await loadMeeting(meetingId);
  if (!meeting) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const agenda = await scope.db
    .select()
    .from(meetingAgendaItems)
    .where(
      scope.where(
        meetingAgendaItems.organisationId,
        eq(meetingAgendaItems.meetingId, meetingId),
      ),
    )
    .orderBy(asc(meetingAgendaItems.position));

  await recordAudit({
    action: 'meeting_pack.viewed',
    resourceType: 'meeting_pack',
    resourceId: meetingId,
    result: 'success',
  });

  return { meeting, agenda };
}

/** Declare a conflict of interest on an application (optionally a meeting). */
export async function declareConflict(
  rawInput: DeclareConflictInput,
): Promise<ConflictRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'conflict:declare');

  const input = declareConflictSchema.parse(rawInput);
  const scope = currentScope();
  const inserted = await scope.db
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
  const row = expectRow(inserted[0], 'conflict declaration');

  await recordAudit({
    action: 'conflict.declared',
    resourceType: 'conflict',
    resourceId: row.id,
    result: 'success',
    after: { data: { applicationId: input.applicationId }, allow: ['applicationId'] },
  });

  return row;
}

/** Clear a previously declared conflict (agenda managers). */
export async function clearConflict(conflictId: string): Promise<ConflictRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'meeting:agenda-manage');

  const scope = currentScope();
  const updated = await scope.db
    .update(conflictDeclarations)
    .set({ status: 'cleared', clearedByUserId: ctx.userId, clearedAt: new Date() })
    .where(
      scope.where(
        conflictDeclarations.organisationId,
        eq(conflictDeclarations.id, conflictId),
      ),
    )
    .returning();
  const row = expectRow(updated[0], 'conflict declaration');

  await recordAudit({
    action: 'conflict.cleared',
    resourceType: 'conflict',
    resourceId: conflictId,
    result: 'success',
  });

  return row;
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
    const inserted = await scope.db
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
    const row = expectRow(inserted[0], 'meeting');
    created += 1;
    await recordAudit({
      action: 'meeting.created',
      resourceType: 'meeting',
      resourceId: row.id,
      result: 'success',
      reason: 'imported from .ics',
      after: { data: { title: row.title }, allow: ['title'] },
    });
  }

  return { created };
}

/** List a meeting's agenda (unused import guard for `and`/`desc` symmetry). */
export async function listAgenda(meetingId: string): Promise<AgendaItemRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), MEETING_READ);
  const scope = currentScope();
  return scope.db
    .select()
    .from(meetingAgendaItems)
    .where(
      and(
        eq(meetingAgendaItems.organisationId, scope.organisationId),
        eq(meetingAgendaItems.meetingId, meetingId),
      ),
    )
    .orderBy(desc(meetingAgendaItems.position));
}
