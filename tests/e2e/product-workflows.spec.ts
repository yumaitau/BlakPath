import { expect, test, type Page } from '@playwright/test';
import { expectNoWcagViolations } from './helpers/accessibility';
import { ADMIN_PASSWORD, signInAndSelectOrganisation } from './helpers/auth';

function watchForPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

test('task changes persist and are reflected on the dashboard', async ({ page }) => {
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);
  await page.goto('/board');

  const title = `Persistent E2E task ${Date.now()}`;
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByLabel('What needs to be done?').fill(title);
  await page.getByRole('button', { name: 'Add task', exact: true }).click();

  const moveControl = page.getByLabel(`Move ${title} to`);
  await expect(moveControl).toBeVisible();
  await moveControl.selectOption('done');
  await expect(page.getByText(`${title} moved to Done.`, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Done' }).getByText(title, { exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Done' }).getByText(title, { exact: true }),
  ).toBeVisible();

  await page.goto('/dashboard');
  await expect(
    page.getByRole('img', { name: /Tasks by board column.*Done \d/i }),
  ).toBeVisible();
  await expectNoWcagViolations(page);
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});

test('staff can import, view and export a committee meeting', async ({ page }) => {
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);
  await page.goto('/meetings');

  const title = `E2E committee meeting ${Date.now()}`;
  const scheduled = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const scheduledEnd = new Date(scheduled.getTime() + 60 * 60 * 1000);
  const toIcsDate = (value: Date) =>
    value
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BlakPath E2E//EN',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@e2e.blakpath`,
    `DTSTART:${toIcsDate(scheduled)}`,
    `DTEND:${toIcsDate(scheduledEnd)}`,
    `SUMMARY:${title}`,
    'LOCATION:Community meeting room',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  await page.locator('input[type="file"]').setInputFiles({
    name: 'committee-meeting.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(ics),
  });
  await expect(page.getByRole('status')).toHaveText(
    'Imported 1 meeting(s). Refresh to see them.',
  );

  await page.reload();
  await expect(page.getByText(title, { exact: false })).toBeVisible();

  const exported = await page.request.get('/api/calendar/meetings');
  expect(exported.status()).toBe(200);
  expect(exported.headers()['content-type']).toContain('text/calendar');
  expect(exported.headers()['content-disposition']).toContain(
    'attachment; filename="blakpath-meetings.ics"',
  );
  expect(await exported.text()).toContain(`SUMMARY:${title}`);

  await page.goto('/dashboard');
  await expect(page.getByText('scheduled ahead').first()).toBeVisible();
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});

test('a form can be authored, completed once, reviewed and revoked', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);
  await page.goto('/forms');

  const stamp = Date.now();
  const title = `E2E information form ${stamp}`;
  await page.getByRole('button', { name: 'Create a form' }).click();
  await page.getByLabel('Form title').fill(title);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/forms\/[0-9a-f-]+$/);
  const editorUrl = page.url();

  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByRole('textbox', { name: /^Label/ }).fill('Community response');
  await page.getByRole('checkbox', { name: 'Required' }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('button', { name: 'Close form' })).toBeVisible();

  await page.getByLabel('Recipient name').fill('E2E recipient');
  await page.getByLabel('Recipient email').fill(`recipient-${stamp}@example.test`);
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const firstInvitation = page.getByLabel('Invitation link');
  await expect(firstInvitation).toBeVisible();
  const publicUrl = await firstInvitation.inputValue();

  await page.goto(publicUrl);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(
    page.getByText('Please read and confirm the collection notice before submitting.'),
  ).toBeVisible();
  await expect(page.getByLabel('I have read this collection notice')).toBeFocused();
  await page.getByLabel('I have read this collection notice').check();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(
    page.getByText(
      'Some answers need another look. Please check the form and try again.',
    ),
  ).toBeVisible();
  const answer = `Response recorded at ${stamp}`;
  await page.getByLabel('Community response').fill(answer);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Thank you — your response has been recorded.',
    }),
  ).toBeVisible();

  await page.goto(publicUrl);
  await expect(
    page.getByRole('heading', { name: 'This link is no longer valid' }),
  ).toBeVisible();

  await page.goto(editorUrl);
  await expect(page.getByRole('heading', { name: 'Responses (1)' })).toBeVisible();
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await expect(page.getByText('Completed', { exact: false })).toBeVisible();

  await page.getByLabel('Recipient name').fill('Revoked recipient');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.getByLabel('Invitation link')).not.toHaveValue(publicUrl);
  const revokedUrl = await page.getByLabel('Invitation link').inputValue();
  const revokedItem = page.getByRole('listitem').filter({ hasText: 'Revoked recipient' });
  const [revokeResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().includes('/api/forms/invitations/'),
    ),
    revokedItem.getByRole('button', { name: 'Revoke' }).click(),
  ]);
  expect(revokeResponse.status()).toBe(200);
  await expect(revokedItem.getByRole('button', { name: 'Revoke' })).toBeDisabled();

  await page.goto(revokedUrl);
  await expect(
    page.getByRole('heading', { name: 'This link is no longer valid' }),
  ).toBeVisible();
  await expectNoWcagViolations(page);
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});

test('account security fails safely and sign-out ends the session', async ({ page }) => {
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);
  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
  await expect(page.getByText('You don’t have any passkeys yet.')).toBeVisible();

  await page
    .getByLabel('Confirm your password to continue')
    .fill(`${ADMIN_PASSWORD}-incorrect`);
  await page.getByRole('button', { name: 'Set up two-step verification' }).click();
  await expect(
    page.getByRole('region', { name: 'Account security' }).getByRole('alert'),
  ).toContainText('We couldn’t start two-step verification.');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  const protectedResponse = await page.request.get('/api/notifications');
  expect(protectedResponse.status()).toBe(401);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
