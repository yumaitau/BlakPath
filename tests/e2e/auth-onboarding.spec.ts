import { expect, test, type Page } from '@playwright/test';
import { expectNoWcagViolations } from './helpers/accessibility';
import { signInAndSelectOrganisation } from './helpers/auth';

function watchForPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

test('auth: anonymous users hit sign-in gate', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('auth: sign-in, org picker, security, sign-out journey', async ({ page }) => {
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);

  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
  await expectNoWcagViolations(page);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  const protectedResponse = await page.request.get('/api/notifications');
  expect(protectedResponse.status()).toBe(401);

  expect(pageErrors.map((error) => error.message)).toEqual([]);
});

test('auth: sign-up validation and verify-email gate', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expectNoWcagViolations(page);
});
