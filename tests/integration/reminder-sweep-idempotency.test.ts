import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Crash mid-reminder sweep → no duplicate notifications (and so no duplicate
 * emails) on retry. Real Postgres exercises the unique (organisation_id,
 * dedupe_key) index; the queue is faked with BullMQ's stable-job-id semantics
 * and made to fail once, part-way through the attendee loop.
 */

const queue = vi.hoisted(() => ({
  jobIds: new Set<string>(),
  offers: 0,
  failOnOffer: 2 as number | null,
}));

vi.mock('@/lib/queues', () => ({
  QueueName: { Notification: 'notification' },
  addJob: async (_q: string, _n: string, _p: unknown, options: { jobId: string }) => {
    queue.offers += 1;
    if (queue.failOnOffer === queue.offers) {
      queue.failOnOffer = null;
      throw new Error('simulated worker crash mid-sweep');
    }
    queue.jobIds.add(options.jobId);
    return options.jobId;
  },
}));

const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

integration('reminder sweep idempotency', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await cleanup?.();
  });

  it('re-runs a crashed sweep without duplicating per-user notifications', async () => {
    const [{ db, sqlClient }, schema, calendar, { uuidv7 }, drizzle] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/domains/calendar/service'),
      import('uuidv7'),
      import('drizzle-orm'),
    ]);
    const orgId = uuidv7();
    const userIds = [uuidv7(), uuidv7(), uuidv7()];
    const eventId = uuidv7();
    const reminderId = uuidv7();
    cleanup = async () => {
      await db
        .delete(schema.organisations)
        .where(drizzle.eq(schema.organisations.id, orgId));
      await db.delete(schema.users).where(drizzle.inArray(schema.users.id, userIds));
      await sqlClient.end({ timeout: 5 });
    };

    await db.insert(schema.organisations).values({
      id: orgId,
      legalName: 'Reminder Sweep Test Organisation',
      slug: `reminder-sweep-${orgId}`,
      status: 'active',
    });
    await db.insert(schema.users).values(
      userIds.map((id, i) => ({
        id,
        name: `Reminder Tester ${i}`,
        email: `reminder-${id}@example.test`,
      })),
    );
    // Active members who want email copies, so each notice offers a delivery job.
    await db.insert(schema.memberships).values(
      userIds.map((userId) => ({
        organisationId: orgId,
        userId,
        status: 'active' as const,
        emailNotifications: true,
      })),
    );
    const now = new Date('2026-10-14T22:00:00Z');
    await db.insert(schema.calendarEvents).values({
      id: eventId,
      organisationId: orgId,
      title: 'Case conference',
      startAt: new Date(now.getTime() + 15 * 60_000),
      timezone: 'Australia/Sydney',
    });
    await db
      .insert(schema.calendarEventAttendees)
      .values(userIds.map((userId) => ({ organisationId: orgId, eventId, userId })));
    await db.insert(schema.calendarEventReminders).values({
      id: reminderId,
      organisationId: orgId,
      eventId,
      minutesBefore: 30,
    });

    const input = { organisationId: orgId, correlationId: 'reminder-sweep-test', now };
    await expect(calendar.processReminderSweep(input)).rejects.toThrow(
      'simulated worker crash',
    );
    const [afterCrash] = await db
      .select({ sentAt: schema.calendarEventReminders.sentAt })
      .from(schema.calendarEventReminders)
      .where(drizzle.eq(schema.calendarEventReminders.id, reminderId));
    expect(afterCrash?.sentAt).toBeNull();

    // BullMQ retries the sweep job.
    await calendar.processReminderSweep(input);

    const rows = await db
      .select({
        id: schema.notifications.id,
        userId: schema.notifications.userId,
        body: schema.notifications.body,
      })
      .from(schema.notifications)
      .where(drizzle.eq(schema.notifications.organisationId, orgId));
    expect(rows).toHaveLength(userIds.length);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set(userIds));
    // One delivery job per notification, whatever the number of offers.
    expect(queue.jobIds).toEqual(new Set(rows.map((r) => r.id)));
    // Local time, not raw UTC.
    expect(rows[0]?.body).toContain('9:15 am AEDT');
    expect(rows[0]?.body).not.toContain('T22:15');

    // A third run is a no-op: the reminder is marked sent.
    await expect(calendar.processReminderSweep(input)).resolves.toEqual({ sent: 0 });
  }, 30_000);
});
