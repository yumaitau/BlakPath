import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import {
  calendarEventAttendees,
  calendarEventReminders,
  calendarEvents,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  requireAny,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import {
  addAttendeeSchema,
  addReminderSchema,
  createCalendarEventSchema,
  updateCalendarEventSchema,
  type AddAttendeeInput,
  type AddReminderInput,
  type CreateCalendarEventInput,
  type UpdateCalendarEventInput,
} from './schemas';
import { expandOccurrences, overlaps } from './recurrence';

/**
 * Calendar service — tenant-scoped, permission-checked, audited.
 * General events (not only committee meetings). Recurrence stored as master
 * RRULE, expanded per query range. Never determines Aboriginality.
 */

export type CalendarEventRow = typeof calendarEvents.$inferSelect;

const CALENDAR_READ = ['calendar:read-any', 'meeting:pack-access'] as const;

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} from database.`);
  return row;
}

async function loadEvent(id: string): Promise<CalendarEventRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(calendarEvents)
    .where(
      scope.where(
        calendarEvents.organisationId,
        eq(calendarEvents.id, id),
        isNull(calendarEvents.deletedAt),
      ),
    )
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

/** Warn when same resource overlaps another scheduled event. */
async function resourceConflicts(input: {
  resource?: string | null;
  start: Date;
  end: Date | null;
  ignoreId?: string;
}): Promise<CalendarEventRow[]> {
  if (!input.resource) return [];
  const ctx = requireTenantContext();
  void ctx;
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(calendarEvents)
    .where(
      scope.where(
        calendarEvents.organisationId,
        eq(calendarEvents.resource, input.resource),
        eq(calendarEvents.status, 'scheduled'),
        isNull(calendarEvents.deletedAt),
      ),
    )
    .limit(50);
  return rows.filter(
    (r) =>
      r.id !== input.ignoreId &&
      overlaps(input.start, input.end, r.startAt, r.endAt),
  );
}

export async function createCalendarEvent(
  raw: CreateCalendarEventInput,
): Promise<{ event: CalendarEventRow; conflicts: CalendarEventRow[] }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'calendar:create');
  const input = createCalendarEventSchema.parse(raw);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(calendarEvents)
    .values(
      scope.insertValues({
        title: input.title,
        description: input.description ?? null,
        location: input.location ?? null,
        resource: input.resource ?? null,
        startAt: input.startAt,
        endAt: input.endAt ?? null,
        allDay: input.allDay ?? false,
        rrule: input.rrule ?? null,
        timezone: input.timezone ?? 'Australia/Sydney',
        meetingId: input.meetingId ?? null,
        createdByUserId: ctx.userId,
        status: 'scheduled',
      }),
    )
    .returning();
  const event = must(inserted[0], 'calendar event');
  const conflicts = await resourceConflicts({
    resource: event.resource,
    start: event.startAt,
    end: event.endAt,
    ignoreId: event.id,
  });
  await recordAudit({
    action: 'calendar.created',
    resourceType: 'calendar_event',
    resourceId: event.id,
    result: 'success',
    after: { data: { title: event.title }, allow: ['title'] },
  });
  return { event, conflicts };
}

export async function listCalendarEvents(range?: {
  from?: Date;
  to?: Date;
}): Promise<CalendarEventRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CALENDAR_READ);
  const scope = currentScope();
  const from = range?.from;
  const to = range?.to;
  const conditions = [isNull(calendarEvents.deletedAt)];
  if (from) conditions.push(gte(calendarEvents.startAt, from));
  if (to) conditions.push(lte(calendarEvents.startAt, to));
  return scope.db
    .select()
    .from(calendarEvents)
    .where(scope.where(calendarEvents.organisationId, ...conditions))
    .orderBy(asc(calendarEvents.startAt))
    .limit(500);
}

/** Expand recurring masters into occurrences for agenda/week views. */
export async function listOccurrences(range: { from: Date; to: Date }): Promise<
  { event: CalendarEventRow; start: Date; end: Date | null }[]
> {
  const events = await listCalendarEvents();
  return events.flatMap((event) =>
    expandOccurrences({
      start: event.startAt,
      end: event.endAt,
      rrule: event.rrule,
      from: range.from,
      to: range.to,
    }).map((o) => ({ event, start: o.start, end: o.end })),
  );
}

export async function updateCalendarEvent(
  id: string,
  raw: UpdateCalendarEventInput,
): Promise<{ event: CalendarEventRow; conflicts: CalendarEventRow[] }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'calendar:update-any');
  const input = updateCalendarEventSchema.parse(raw);
  const existing = await loadEvent(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');
  const scope = currentScope();
  const updated = await scope.db
    .update(calendarEvents)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
      ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
      ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      ...(input.rrule !== undefined ? { rrule: input.rrule } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    })
    .where(scope.where(calendarEvents.organisationId, eq(calendarEvents.id, id)))
    .returning();
  const event = must(updated[0], 'calendar event');
  const conflicts = await resourceConflicts({
    resource: event.resource,
    start: event.startAt,
    end: event.endAt,
    ignoreId: event.id,
  });
  await recordAudit({
    action: 'calendar.updated',
    resourceType: 'calendar_event',
    resourceId: id,
    result: 'success',
  });
  return { event, conflicts };
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'calendar:delete-any');
  const existing = await loadEvent(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');
  const scope = currentScope();
  await scope.db
    .update(calendarEvents)
    .set({ deletedAt: new Date() })
    .where(scope.where(calendarEvents.organisationId, eq(calendarEvents.id, id)));
  await recordAudit({
    action: 'calendar.deleted',
    resourceType: 'calendar_event',
    resourceId: id,
    result: 'success',
  });
}

export async function addAttendee(eventId: string, raw: AddAttendeeInput) {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'calendar:update-any');
  const input = addAttendeeSchema.parse(raw);
  const event = await loadEvent(eventId);
  if (!event) throw new AuthorizationError('POLICY_DENIED');
  const scope = currentScope();
  const inserted = await scope.db
    .insert(calendarEventAttendees)
    .values(
      scope.insertValues({
        eventId,
        userId: input.userId ?? null,
        email: input.email ?? null,
        displayName: input.displayName ?? null,
        responseStatus: 'needs-action',
      }),
    )
    .returning();
  return must(inserted[0], 'attendee');
}

export async function addReminder(eventId: string, raw: AddReminderInput) {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'calendar:update-any');
  const input = addReminderSchema.parse(raw);
  const event = await loadEvent(eventId);
  if (!event) throw new AuthorizationError('POLICY_DENIED');
  const scope = currentScope();
  const inserted = await scope.db
    .insert(calendarEventReminders)
    .values(
      scope.insertValues({
        eventId,
        minutesBefore: input.minutesBefore,
        channel: input.channel ?? 'in-app',
      }),
    )
    .returning();
  return must(inserted[0], 'reminder');
}

/** Keep `and` import used for future scoped filters. */
export async function countUpcoming(): Promise<number> {
  const rows = await listCalendarEvents({ from: new Date() });
  void and;
  return rows.length;
}
