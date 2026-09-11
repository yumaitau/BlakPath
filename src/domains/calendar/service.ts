import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import {
  calendarEventAttendees,
  calendarEventReminders,
  calendarEvents,
  featureFlags,
} from '@/db/schema';
import { currentScope, scopeFor } from '@/db/tenant-db';
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
import { CalendarConflictError } from './errors';

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
}): Promise<CalendarEventRow[]> {  if (!input.resource) return [];
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

/**
 * Whether this tenant hard-blocks resource double-booking. Tenant override
 * wins; platform default row (null organisation) next; absent = warn-only.
 */
async function resourceHardBlock(): Promise<boolean> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(featureFlags)
    .where(eq(featureFlags.key, 'calendar-resource-hard-block'))
    .limit(10);
  const orgRow = rows.find((r) => r.organisationId === scope.organisationId);
  if (orgRow) return orgRow.enabled;
  const platform = rows.find((r) => r.organisationId === null);
  return platform?.enabled ?? false;
}

function throwIfBlocked(conflicts: CalendarEventRow[], force: boolean | undefined, hardBlock: boolean): void {
  if (conflicts.length > 0 && hardBlock && !force) {
    throw new CalendarConflictError(conflicts);
  }
}

export async function createCalendarEvent(
  raw: CreateCalendarEventInput,
): Promise<{ event: CalendarEventRow; conflicts: CalendarEventRow[] }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'calendar:create');
  const input = createCalendarEventSchema.parse(raw);
  const scope = currentScope();
  // Hard-block check runs BEFORE insert so a rejected booking leaves no row.
  throwIfBlocked(
    await resourceConflicts({
      resource: input.resource ?? null,
      start: input.startAt,
      end: input.endAt ?? null,
    }),
    input.force,
    await resourceHardBlock(),
  );
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
        exdate: input.exdate ?? null,
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
      exdate: event.exdate,
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
  // Hard-block check runs BEFORE update so a rejected move leaves no change.
  throwIfBlocked(
    await resourceConflicts({
      resource: input.resource !== undefined ? input.resource : existing.resource,
      start: input.startAt ?? existing.startAt,
      end: input.endAt !== undefined ? input.endAt : existing.endAt,
      ignoreId: id,
    }),
    input.force,
    await resourceHardBlock(),
  );
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
      ...(input.exdate !== undefined ? { exdate: input.exdate } : {}),
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

/**
 * Email invitations to attendees holding an email address (no app account).
 * Queued through the Email queue (SES in prod) — plain text, no bearer links,
 * reply by signing in. Returns invited count.
 */
export async function inviteAttendees(eventId: string): Promise<{ invited: number }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'calendar:update-any');
  const event = await loadEvent(eventId);
  if (!event) throw new AuthorizationError('POLICY_DENIED');
  const scope = currentScope();
  const attendees = await scope.db
    .select()
    .from(calendarEventAttendees)
    .where(
      scope.where(
        calendarEventAttendees.organisationId,
        eq(calendarEventAttendees.eventId, eventId),
      ),
    )
    .limit(100);
  const { addJob, QueueName } = await import('@/lib/queues');
  let invited = 0;
  for (const a of attendees) {
    if (!a.email || a.userId) continue;
    const when = event.startAt.toISOString();
    await addJob(
      QueueName.Email,
      'event-invite',
      {
        organisationId: scope.organisationId,
        correlationId: ctx.correlationId,
        to: a.email,
        subject: `Invitation: ${event.title}`,
        text: [
          `You are invited: ${event.title}.`,
          `When: ${when}${event.location ? ` at ${event.location}` : ''}.`,
          'Sign in to BlakPath to respond.',
        ].join('\n'),
      },
      { jobId: `event-invite:${a.id}` },
    );
    invited += 1;
  }
  await recordAudit({
    action: 'calendar.updated',
    resourceType: 'calendar_event',
    resourceId: eventId,
    result: 'success',
    reason: `invited ${invited} attendee(s)`,
  });
  return { invited };
}

export async function addReminder(eventId: string, raw: AddReminderInput) {  const ctx = requireTenantContext();
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

/** RSVP to an event as attendee. Member updates own row; editors update any. */export async function respondAttendee(
  attendeeId: string,
  responseStatus: 'accepted' | 'declined' | 'tentative' | 'needs-action',
) {
  const ctx = requireTenantContext();
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(calendarEventAttendees)
    .where(
      scope.where(calendarEventAttendees.organisationId, eq(calendarEventAttendees.id, attendeeId)),
    )
    .limit(1);
  const row = scope.assertOwned(rows[0]);
  if (!row) throw new AuthorizationError('POLICY_DENIED');
  const subject = subjectFromContext(ctx);
  const canEditAny = (() => {
    try {
      requirePermission(subject, 'calendar:update-any');
      return true;
    } catch {
      return false;
    }
  })();
  if (!canEditAny && row.userId !== ctx.userId) {
    try {
      requireAny(subject, CALENDAR_READ);
    } catch {
      throw new AuthorizationError('POLICY_DENIED');
    }
    if (row.userId !== ctx.userId) throw new AuthorizationError('POLICY_DENIED');
  }
  const updated = await scope.db
    .update(calendarEventAttendees)
    .set({ responseStatus })
    .where(
      scope.where(calendarEventAttendees.organisationId, eq(calendarEventAttendees.id, attendeeId)),
    )
    .returning();
  const updatedRow = must(updated[0], 'attendee');
  await recordAudit({
    action: 'calendar.updated',
    resourceType: 'calendar_event',
    resourceId: row.eventId,
    result: 'success',
    reason: `rsvp ${responseStatus}`,
  });
  return updatedRow;
}

/**
 * Dispatch due reminders for one tenant. Runs in the worker (explicit scope,
 * no ambient context). A reminder is due when its event starts within
 * [now, now + 24h] and the notify time (start − minutesBefore) has passed.
 * Each pending reminder notifies every attendee holding a user account via
 * the notification system (which also queues the email copy), then marks the
 * reminder sent so it fires once.
 */
export async function processReminderSweep(input: {
  organisationId: string;
  correlationId: string;
  now?: Date;
}): Promise<{ sent: number }> {
  const { organisationId, correlationId, now: nowRaw } = input;
  const now = nowRaw ?? new Date();
  const horizon = new Date(now.getTime() + 24 * 3_600_000);
  const scope = scopeFor(organisationId);

  const pending = await scope.db
    .select({
      reminderId: calendarEventReminders.id,
      minutesBefore: calendarEventReminders.minutesBefore,
      eventId: calendarEvents.id,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      location: calendarEvents.location,
    })
    .from(calendarEventReminders)
    .innerJoin(calendarEvents, eq(calendarEventReminders.eventId, calendarEvents.id))
    .where(
      and(
        eq(calendarEventReminders.organisationId, organisationId),
        isNull(calendarEventReminders.sentAt),
        eq(calendarEvents.organisationId, organisationId),
        eq(calendarEvents.status, 'scheduled'),
        isNull(calendarEvents.deletedAt),
        gte(calendarEvents.startAt, new Date(now.getTime() - 2 * 3_600_000)),
        lte(calendarEvents.startAt, horizon),
      ),
    )
    .limit(200);

  const { createNotification } = await import('@/domains/notifications/service');
  let sent = 0;
  for (const item of pending) {
    const notifyAt = item.startAt.getTime() - item.minutesBefore * 60_000;
    if (notifyAt > now.getTime()) continue;
    const attendees = await scope.db
      .select()
      .from(calendarEventAttendees)
      .where(
        and(
          eq(calendarEventAttendees.organisationId, organisationId),
          eq(calendarEventAttendees.eventId, item.eventId),
        ),
      )
      .limit(100);
    const userIds = [...new Set(attendees.map((a) => a.userId).filter((u): u is string => !!u))];
    for (const userId of userIds) {
      await createNotification(
        {
          organisationId,
          userId,
          type: 'calendar-reminder',
          title: `Reminder: ${item.title}`,
          body: `Starts ${item.startAt.toISOString()}${item.location ? ` at ${item.location}` : ''}.`,
          resourceType: 'calendar_event',
          resourceId: item.eventId,
        },
        correlationId,
      );
      sent += 1;
    }
    await scope.db
      .update(calendarEventReminders)
      .set({ sentAt: now })
      .where(
        and(
          eq(calendarEventReminders.organisationId, organisationId),
          eq(calendarEventReminders.id, item.reminderId),
        ),
      );
  }
  return { sent };
}
