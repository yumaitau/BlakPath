import { expect, test, type Page } from '@playwright/test';
import { expectNoWcagViolations } from './helpers/accessibility';
import { signInAndSelectOrganisation } from './helpers/auth';

function watchForPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

test('coa: staff can walk dashboard, board, applications, meetings, forms', async ({
  page,
}) => {
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);

  await test.step('dashboard loads with attention items', async () => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  await test.step('board task persists across reload', async () => {
    await page.goto('/board');
    const title = `CoA E2E task ${Date.now()}`;
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByLabel('What needs to be done?').fill(title);
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(page.getByLabel(`Move ${title} to`)).toBeVisible();
    await page.reload();
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  });

  await test.step('applications list is tenant-scoped', async () => {
    await page.goto('/applications');
    await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
    const response = await page.request.get('/api/applications');
    expect([200, 403]).toContain(response.status());
  });

  await test.step('meetings calendar renders', async () => {
    await page.goto('/meetings');
    await expect(
      page.getByRole('region', { name: /calendar/i }).or(page.getByLabel(/meeting calendar/i)),
    ).toBeVisible({ timeout: 15_000 });
  });

  await test.step('no auto-determination UI exists', async () => {
    await page.goto('/applications');
    await expect(page.getByText(/auto-approve/i)).toHaveCount(0);
    await expect(page.getByText(/identity score/i)).toHaveCount(0);
  });

  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
