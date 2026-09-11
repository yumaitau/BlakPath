import { expect, test, type Page } from '@playwright/test';
import { expectNoWcagViolations, expectVisibleFocus } from './helpers/accessibility';
import {
  selectDevelopmentOrganisation,
  signIn,
  signInAndSelectOrganisation,
} from './helpers/auth';

async function auditRoute(page: Page, path: string, heading: string): Promise<void> {
  await test.step(`${path} meets automated WCAG checks`, async () => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
    await expectNoWcagViolations(page);
  });
}

test('public and authentication journeys meet automated WCAG checks', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const routes = [
    ['/', 'A clearer path'],
    ['/accessibility', 'Accessibility'],
    ['/privacy', 'Privacy'],
    ['/support', 'Support'],
    ['/organisations', 'Find an organisation'],
    ['/verify', 'Check a certificate'],
    ['/sign-in', 'Sign in'],
    ['/sign-up', 'BlakPath is invite-only'],
    ['/forgot-password', 'Reset your password'],
  ] as const;

  for (const [path, heading] of routes) await auditRoute(page, path, heading);
});

test('organisation selection and core staff journeys meet automated WCAG checks', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page);
  await expect(
    page.getByRole('heading', { name: 'Choose an organisation' }),
  ).toBeVisible();
  await expectNoWcagViolations(page);

  await selectDevelopmentOrganisation(page);
  await expectNoWcagViolations(page);

  const dashboardCharts = page
    .getByRole('region', { name: 'Organisation stats' })
    .getByRole('img');
  expect(await dashboardCharts.count()).toBeGreaterThan(0);
  for (let index = 0; index < (await dashboardCharts.count()); index += 1) {
    await expect(dashboardCharts.nth(index)).toHaveAccessibleName(/\d/);
  }

  await auditRoute(page, '/applications', 'Applications');
  const applicantName = `Accessibility case ${Date.now()}`;
  await page.getByLabel('Name as provided').fill(applicantName);
  await page.getByRole('button', { name: 'Start application' }).click();
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]+$/);
  await expectNoWcagViolations(page);

  await auditRoute(page, '/board', 'Work board');
  await auditRoute(page, '/forms', 'Forms');
  await auditRoute(page, '/notifications', 'Notifications');

  await page.goto('/dashboard');
  const notifications = page.getByRole('button', { name: /^Notifications,/ });
  await notifications.click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toBeVisible();
  await expectNoWcagViolations(page);
});

test('keyboard users can navigate menus, board work and public forms', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInAndSelectOrganisation(page);

  const organisationMenu = page.getByRole('button', {
    name: /^Switch organisation\./,
  });
  await organisationMenu.focus();
  await expectVisibleFocus(page);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(organisationMenu).toBeFocused();

  await page.getByRole('button', { name: /^Notifications,/ }).focus();
  await expectVisibleFocus(page);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Notifications' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Notifications,/ })).toBeFocused();

  await page.goto('/board');
  const title = `Keyboard task ${Date.now()}`;
  await page.getByRole('button', { name: 'Add task' }).focus();
  await page.keyboard.press('Enter');
  const titleInput = page.getByLabel('What needs to be done?');
  await expect(titleInput).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');

  const moveTask = page.getByLabel(`Move ${title} to`);
  await expect(moveTask).toBeVisible();
  await moveTask.focus();
  await expectVisibleFocus(page);
  await page.keyboard.press('i');
  await expect(page.getByRole('status').filter({ hasText: title })).toContainText(
    `${title} moved to In progress.`,
  );
  await expect(
    page.getByRole('region', { name: 'In progress' }).getByText(title, { exact: true }),
  ).toBeVisible();
  await expectNoWcagViolations(page);

  await page.goto('/forms');

  await page.getByRole('button', { name: 'Create a form' }).focus();
  await page.keyboard.press('Enter');
  const newTitle = page.getByLabel('Form title');
  await expect(newTitle).toBeFocused();
  await page.keyboard.type(`Keyboard form ${Date.now()}`);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/forms\/[0-9a-f-]+$/);

  await page.getByRole('button', { name: 'Add field' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: /^Label/ }).fill('Your response');
  await page.getByRole('checkbox', { name: 'Required' }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Saved.');

  await page.getByRole('button', { name: 'Publish' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Close form' })).toBeVisible();

  await page.getByRole('button', { name: 'Create invitation' }).focus();
  await page.keyboard.press('Enter');
  const invitation = page.getByLabel('Invitation link');
  await expect(invitation).toBeVisible();
  const publicUrl = await invitation.inputValue();
  await expectNoWcagViolations(page);

  await page.goto(publicUrl);
  const response = page.getByLabel('Your response');
  await page.getByRole('button', { name: 'Submit' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Some answers need another look' }),
  ).toBeVisible();
  await expect(response).toBeFocused();
  await expect(response).toHaveAttribute('aria-invalid', 'true');
  await expectNoWcagViolations(page);

  await response.focus();
  await expectVisibleFocus(page);
  await page.keyboard.type('Information provided by the applicant');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Submit' })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirmation = page.getByRole('heading', {
    name: 'Thank you — your response has been recorded.',
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator('..')).toBeFocused();
  await expectNoWcagViolations(page);
});
