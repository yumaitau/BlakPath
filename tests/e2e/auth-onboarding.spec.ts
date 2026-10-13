import { expect, test } from '@playwright/test';
import { expectNoWcagViolations } from './helpers/accessibility';
import { signInAndSelectOrganisation } from './helpers/auth';
import { expectNoPageErrors, watchForPageErrors } from './helpers/page-errors';

test('auth: anonymous users hit sign-in gate', async ({ page }) => {
  const pageErrors = watchForPageErrors(page);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/sign-in$/);
  expectNoPageErrors(pageErrors);
});

test('auth: sign-in, org picker, security, sign-out journey', async ({ page }) => {
  const pageErrors = watchForPageErrors(page);
  await test.step('sign-in and org picker', async () => {
    await signInAndSelectOrganisation(page);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
  await expectNoWcagViolations(page);

  await test.step('sign-out session end', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    const protectedResponse = await page.request.get('/api/notifications');
    expect(protectedResponse.status()).toBe(401);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  expectNoPageErrors(pageErrors);
});

test('auth: open sign-up stays closed and explains invite-only', async ({
  page,
  request,
}) => {
  const pageErrors = watchForPageErrors(page);
  await test.step('sign-up stays invite-only', async () => {
    await page.goto('/sign-up');
    await expect(
      page.getByRole('heading', { name: 'BlakPath is invite-only' }),
    ).toBeVisible();
  });

  await test.step('verify-email gate', async () => {
    await page.goto('/verify-email');
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    await expect(page.getByText('Sign in first')).toBeVisible();
  });
  await expectNoWcagViolations(page);

  // Framework registration endpoint refuses direct signups.
  const direct = await request.post('/api/auth/sign-up/email', {
    data: {
      email: `nobody-${Date.now()}@example.test`,
      password: 'long-enough-password-123',
      name: 'Nobody',
    },
  });
  expect(direct.status()).toBe(400);
  expectNoPageErrors(pageErrors);
});
