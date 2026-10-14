import { expect, test } from '@playwright/test';
import { isolateSignInClient } from './helpers/auth';

const PENDING_EMAIL = 'mfa-pending@blakpath.local';
const PENDING_PASSWORD = 'blakpath-dev-mfa-2026';

test('staff without a verified factor is sent to enrolment', async ({ page }) => {
  await isolateSignInClient(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(PENDING_EMAIL);
  await page.getByLabel('Password').fill(PENDING_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page).toHaveURL(/\/(?:select-organisation|mfa\/enrol)$/, {
    timeout: 30_000,
  });
  if (/\/select-organisation$/.test(page.url())) {
    await page.getByRole('button', { name: /BlakPath Development Organisation/ }).click();
  }

  await expect(page).toHaveURL(/\/mfa\/enrol$/);
  await expect(
    page.getByRole('heading', { name: 'Enrol a second factor' }),
  ).toBeVisible();

  const denied = await page.request.get('/api/notifications');
  expect(denied.status()).toBe(403);
  await expect(denied.json()).resolves.toMatchObject({ code: 'STAFF_MFA_REQUIRED' });
});
