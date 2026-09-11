import { expect, test, type Page } from '@playwright/test';
import { expectNoWcagViolations } from './helpers/accessibility';
import { signInAndSelectOrganisation } from './helpers/auth';

function watchForPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

function icsDate(value: Date): string {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

test('calendar: month navigation, ICS import/export, recurring survives', async ({
  page,
}) => {
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);
  await page.goto('/meetings');

  await test.step('month grid navigates', async () => {
    const heading = page.getByRole('heading', { level: 2 }).first();
    const before = await heading.textContent();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(heading).not.toHaveText(before ?? '', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Previous month' }).click();
  });

  await test.step('recurring ICS imports and exports with RRULE', async () => {
    const title = `E2E recurring ${Date.now()}`;
    const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//BlakPath E2E//EN',
      'BEGIN:VEVENT',
      `UID:${Date.now()}@e2e.blakpath`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${title}`,
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'LOCATION:Council chambers',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');

    await page.locator('input[type="file"]').setInputFiles({
      name: 'recurring.ics',
      mimeType: 'text/calendar',
      buffer: Buffer.from(ics),
    });
    await expect(page.getByRole('status')).toHaveText(
      'Imported 1 meeting(s). Refresh to see them.',
    );
    await page.reload();
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });

    const exported = await page.request.get('/api/calendar/meetings');
    expect(exported.status()).toBe(200);
    expect(await exported.text()).toContain(`SUMMARY:${title}`);
  });

  await expectNoWcagViolations(page);
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
