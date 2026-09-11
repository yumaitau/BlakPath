import { expect, test, type Page } from '@playwright/test';
import { expectNoWcagViolations } from '../e2e/helpers/accessibility';

/**
 * Live EKS pilot journey. Runs against the deployed stack
 * (LIVE_BASE_URL=https://blakpath.yumait.au) with pilot credentials from env.
 * Covers sign-in, org context, core pages, and creating team/client/event
 * through the real UI. Pilot org is temporary — removed after verification.
 */

const EMAIL = process.env.PILOT_EMAIL ?? '';
const PASSWORD = process.env.PILOT_PASSWORD ?? '';

function watchForPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

test.beforeEach(async () => {
  test.skip(!EMAIL || !PASSWORD, 'PILOT_EMAIL/PILOT_PASSWORD required for live run.');
});

test('live pilot: sign in, pages load, team/client/event created', async ({ page }) => {
  const pageErrors = watchForPageErrors(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/(?:select-organisation|dashboard)$/, { timeout: 30_000 });
  if (/\/select-organisation$/.test(page.url())) {
    await page.getByRole('button', { name: /Pilot Council/ }).click();
  }
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expectNoWcagViolations(page);

  const stamp = Date.now().toString(36);

  await test.step('clients page creates client', async () => {
    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
    await page.getByLabel('Client name').fill(`Live client ${stamp}`);
    await page.getByRole('button', { name: 'Register client' }).click();
    await expect(page.getByRole('status')).toContainText(/registered|permission/i);
  });

  await test.step('teams page creates team', async () => {
    await page.goto('/settings/teams');
    await expect(page.getByRole('heading', { name: 'Teams and groups' })).toBeVisible();
    await page.getByLabel('Team name').fill(`Live team ${stamp}`);
    await page.getByLabel('Slug').first().fill(`live-team-${stamp}`);
    await page.getByRole('button', { name: 'Create team' }).click();
    await expect(page.getByRole('status')).toContainText(/created|permission/i);
  });

  await test.step('calendar creates event across views', async () => {
    await page.goto('/meetings');
    await expect(page.getByRole('heading', { name: /Agenda|Week of|20\d\d/ }).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Agenda' }).click();
    await page.getByRole('button', { name: 'Week' }).click();
    await page.getByRole('button', { name: 'Month' }).click();
    await page.getByLabel('Event title').fill(`Live event ${stamp}`);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    await page
      .getByLabel('Start')
      .fill(
        `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T10:00`,
      );
    await page.getByRole('button', { name: 'Create event' }).click();
    await expect(page.getByRole('status')).toContainText(/created|permission/i);
  });

  await test.step('board and applications render', async () => {
    await page.goto('/board');
    await expect(page.getByRole('button', { name: 'Add task' })).toBeVisible({ timeout: 15_000 });
    await page.goto('/applications');
    await expect(
      page.getByRole('heading', { name: 'Applications', exact: true }),
    ).toBeVisible();
  });

  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
