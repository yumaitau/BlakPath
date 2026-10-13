import { expect, test } from '@playwright/test';
import { expectNoWcagViolations } from './helpers/accessibility';
import { signInAndSelectOrganisation } from './helpers/auth';
import { expectNoPageErrors, watchForPageErrors } from './helpers/page-errors';

function icsDate(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function localDateInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function localDateTimeInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${localDateInput(value)}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

test('calendar: create, views, attendees, reminder, reschedule, ICS, conflict', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);
  await page.goto('/meetings');

  await test.step('month navigation', async () => {
    const heading = page.getByRole('heading', { level: 2 }).first();
    const before = await heading.textContent();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(heading).not.toHaveText(before ?? '', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Previous month' }).click();
  });

  const title = `E2E event ${Date.now()}`;
  const start = new Date();
  start.setHours(15, 0, 0, 0);
  const moved = new Date(start);
  moved.setDate(moved.getDate() + 1);

  await test.step('create event', async () => {
    await page.getByLabel('Event title').fill(title);
    await page.getByLabel('Start').fill(localDateTimeInput(start));
    await page.getByRole('button', { name: 'Create event' }).click();
    await expect(page.getByText('Event created. Refresh to see it.')).toBeVisible();
  });

  await page.reload();

  await test.step('week view', async () => {
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(page.getByLabel('Week view')).toBeVisible();
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  });

  await test.step('agenda view', async () => {
    await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Agenda' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Agenda' })).toContainText(title);
  });

  await test.step('reschedule persists across reload', async () => {
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await page.getByLabel('Event').selectOption({ label: title });
    await page.getByLabel('New date').fill(localDateInput(moved));
    await page.getByRole('button', { name: 'Move event' }).click();
    await expect(page.getByText('Event moved. Refresh to see it.')).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Week', exact: true }).click();

    const listed = await page.request.get('/api/calendar/events');
    expect(listed.status()).toBe(200);
    const body = (await listed.json()) as {
      events: { title: string; startAt: string }[];
    };
    const event = body.events.find((item) => item.title === title);
    expect(event).toBeDefined();
    const stored = new Date(event?.startAt ?? '');
    expect(localDateInput(stored)).toBe(localDateInput(moved));
  });

  await test.step('ICS import and export', async () => {
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    const meetingTitle = `E2E recurring ${Date.now()}`;
    const meetingStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const meetingEnd = new Date(meetingStart.getTime() + 60 * 60 * 1000);
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//BlakPath E2E//EN',
      'BEGIN:VEVENT',
      `UID:${Date.now()}@e2e.blakpath`,
      `DTSTART:${icsDate(meetingStart)}`,
      `DTEND:${icsDate(meetingEnd)}`,
      `SUMMARY:${meetingTitle}`,
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'LOCATION:Council chambers',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');

    await page.getByLabel('Upload calendar file').setInputFiles({
      name: 'recurring.ics',
      mimeType: 'text/calendar',
      buffer: Buffer.from(ics),
    });
    await expect(page.getByRole('status')).toHaveText(
      'Imported 1 meeting(s). Refresh to see them.',
    );
    await page.reload();
    await expect(page.getByText(meetingTitle, { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });

    const exported = await page.request.get('/api/calendar/meetings');
    expect(exported.status()).toBe(200);
    expect(await exported.text()).toContain(`SUMMARY:${meetingTitle}`);
  });

  await test.step('recurring RRULE round-trip', async () => {
    const recurStart = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const created = await page.request.post('/api/calendar/events', {
      data: {
        title: `E2E weekly ${Date.now()}`,
        startAt: recurStart.toISOString(),
        endAt: new Date(recurStart.getTime() + 60 * 60 * 1000).toISOString(),
        rrule: 'FREQ=WEEKLY;COUNT=4',
      },
    });
    expect(created.status()).toBe(201);
    const createdBody = (await created.json()) as {
      event: { id: string; rrule: string };
    };
    expect(createdBody.event.rrule).toBe('FREQ=WEEKLY;COUNT=4');

    const listed = await page.request.get('/api/calendar/events');
    expect(listed.status()).toBe(200);
    const body = (await listed.json()) as {
      events: { id: string; rrule: string | null }[];
    };
    expect(body.events.find((event) => event.id === createdBody.event.id)?.rrule).toBe(
      'FREQ=WEEKLY;COUNT=4',
    );
  });

  await test.step('attendee invite and response', async () => {
    const listed = await page.request.get('/api/calendar/events');
    expect(listed.status()).toBe(200);
    const body = (await listed.json()) as { events: { id: string; title: string }[] };
    const event = body.events.find((item) => item.title === title);
    expect(event).toBeDefined();

    const invited = await page.request.post(
      `/api/calendar/events/${event?.id}/attendees`,
      {
        data: { email: 'guest@example.test', displayName: 'E2E Guest' },
      },
    );
    expect(invited.status()).toBe(201);
    const attendeeId = ((await invited.json()) as { attendee: { id: string } }).attendee
      .id;

    const rsvp = await page.request.patch(`/api/calendar/attendees/${attendeeId}`, {
      data: { responseStatus: 'accepted' },
    });
    expect(rsvp.status()).toBe(200);
    expect(
      ((await rsvp.json()) as { attendee: { responseStatus: string } }).attendee
        .responseStatus,
    ).toBe('accepted');
  });

  await test.step('reminder set', async () => {
    const listed = await page.request.get('/api/calendar/events');
    const body = (await listed.json()) as { events: { id: string; title: string }[] };
    const event = body.events.find((item) => item.title === title);
    const reminder = await page.request.post(
      `/api/calendar/events/${event?.id}/reminders`,
      {
        data: { minutesBefore: 30, channel: 'in-app' },
      },
    );
    expect(reminder.status()).toBe(201);
    expect(
      ((await reminder.json()) as { reminder: { minutesBefore: number } }).reminder
        .minutesBefore,
    ).toBe(30);
  });

  await test.step('resource conflict warning', async () => {
    const slot = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    slot.setMinutes(0, 0, 0);
    const resource = `chamber-${Date.now()}`;
    const first = await page.request.post('/api/calendar/events', {
      data: {
        title: `E2E booking A ${Date.now()}`,
        startAt: slot.toISOString(),
        endAt: new Date(slot.getTime() + 60 * 60 * 1000).toISOString(),
        resource,
      },
    });
    expect(first.status()).toBe(201);
    const second = await page.request.post('/api/calendar/events', {
      data: {
        title: `E2E booking B ${Date.now()}`,
        startAt: slot.toISOString(),
        endAt: new Date(slot.getTime() + 60 * 60 * 1000).toISOString(),
        resource,
      },
    });
    expect(second.status()).toBe(201);
    const payload = (await second.json()) as { conflicts: unknown[] };
    expect(payload.conflicts.length).toBeGreaterThan(0);
  });

  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expectNoWcagViolations(page);
  expectNoPageErrors(pageErrors);
});
