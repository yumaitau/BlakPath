import type { Page } from '@playwright/test';
import { expect, test } from './helpers/page';
import { expectNoWcagViolations } from './helpers/accessibility';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  isolateSignInClient,
  selectDevelopmentOrganisation,
  signInAndSelectOrganisation,
} from './helpers/auth';
import { expectNoPageErrors, watchForPageErrors } from './helpers/page-errors';

const STAFF_EMAIL = 'staff@blakpath.local';
const STAFF_PASSWORD = 'blakpath-dev-staff-2026';

async function signInAs(page: Page, email: string, password: string): Promise<void> {
  await isolateSignInClient(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/select-organisation$/, { timeout: 30_000 });
}

test('invite acceptance, role changes and revocation remain tenant-bound', async ({
  browser,
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);
  const currentAccess = await page.request.get('/api/memberships');
  expect(currentAccess.status()).toBe(200);
  const currentMembers = (await currentAccess.json()) as {
    members: Array<{ id: string; email: string; status: string }>;
  };
  const existingStaff = currentMembers.members.find(
    (member) => member.email === STAFF_EMAIL && member.status !== 'revoked',
  );
  if (existingStaff) {
    const resetAccess = await page.request.patch(`/api/memberships/${existingStaff.id}`, {
      data: { operation: 'status', status: 'revoked' },
    });
    expect(resetAccess.status()).toBe(200);
  }
  await page.goto('/settings/people');
  await expectNoWcagViolations(page);
  await page.getByLabel('Email address').fill(STAFF_EMAIL);
  await page.getByLabel('Initial role').selectOption({ label: 'Committee Chair' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation created.')).toBeVisible();
  const firstInvitationUrl = await page.getByLabel('Latest invitation link').inputValue();
  let invitation = page.getByRole('listitem').filter({ hasText: STAFF_EMAIL }).first();
  await expect(invitation).toContainText('Pending');

  await invitation.getByRole('button', { name: 'Resend' }).click();
  await expect(page.getByText('A new invitation link was created.')).toBeVisible();
  const invitationUrl = await page.getByLabel('Latest invitation link').inputValue();
  expect(invitationUrl).not.toBe(firstInvitationUrl);

  const staffContext = await browser.newContext({
    extraHTTPHeaders: { Origin: baseURL ?? 'http://localhost:3000' },
  });
  const staffPage = await staffContext.newPage();
  const staffErrors = watchForPageErrors(staffPage);
  try {
    await test.step('invite accept', async () => {
      await isolateSignInClient(staffPage);
      await staffPage.goto(firstInvitationUrl);
      await expect(
        staffPage.getByText('This invitation is no longer available'),
      ).toBeVisible();

      await staffPage.goto(invitationUrl);
      await expect(
        staffPage.getByRole('heading', {
          name: 'Join BlakPath Development Organisation',
        }),
      ).toBeVisible();
      await staffPage.getByRole('link', { name: 'Sign in' }).click();
      await staffPage.getByLabel('Email').fill(STAFF_EMAIL);
      await staffPage.getByLabel('Password').fill(STAFF_PASSWORD);
      await staffPage.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(staffPage).toHaveURL(invitationUrl, { timeout: 30_000 });
      await staffPage
        .getByRole('button', { name: 'Join BlakPath Development Organisation' })
        .click();
      await expect(staffPage).toHaveURL(/\/dashboard$/);
    });

    await page.reload();
    invitation = page.getByRole('listitem').filter({ hasText: STAFF_EMAIL }).first();
    await expect(invitation).toContainText('Accepted');
    let member = page.getByRole('listitem').filter({ hasText: STAFF_EMAIL }).last();
    await expect(member).toContainText('Committee Chair');

    await staffPage.goto('/meetings');
    await expect(
      staffPage.getByRole('heading', { name: 'Committee meetings' }),
    ).toBeVisible();
    await expect(
      staffPage.getByRole('button', { name: 'Add calendar file' }),
    ).toBeVisible();

    await staffPage.goto('/settings/people');
    await expect(
      staffPage.getByText('Only organisation administrators can manage staff access.'),
    ).toBeVisible();
    expect((await staffPage.request.get('/api/memberships')).status()).toBe(403);

    const deniedInvite = await staffPage.request.post('/api/membership-invitations', {
      data: {
        email: 'outside@example.test',
        roleId: '00000000-0000-4000-8000-000000000001',
      },
    });
    expect(deniedInvite.status()).toBe(403);

    await page.goto('/settings/people');
    member = page.getByRole('listitem').filter({ hasText: STAFF_EMAIL }).last();
    await member.getByLabel('Assigned role').selectOption({ label: 'Intake Officer' });
    await member.getByRole('button', { name: 'Change role' }).click();
    await expect(page.getByText('Role changed.')).toBeVisible();
    await expect(member).toContainText('Intake Officer');
    expect((await staffPage.request.get('/api/calendar/meetings')).status()).toBe(403);
    expect((await staffPage.request.get('/api/applications')).status()).toBe(200);

    member = page.getByRole('listitem').filter({ hasText: STAFF_EMAIL }).last();
    await member.getByRole('button', { name: 'Suspend' }).click();
    await expect(member).toContainText('suspended');
    expect((await staffPage.request.get('/api/applications')).status()).toBe(403);

    member = page.getByRole('listitem').filter({ hasText: STAFF_EMAIL }).last();
    await member.getByRole('button', { name: 'Restore' }).click();
    await expect(member).toContainText('active');
    expect((await staffPage.request.get('/api/applications')).status()).toBe(200);

    member = page.getByRole('listitem').filter({ hasText: STAFF_EMAIL }).last();
    await member.getByRole('button', { name: 'Remove access' }).click();
    await member.getByRole('button', { name: 'Confirm removal' }).click();
    await expect(member).toContainText('revoked');
    expect((await staffPage.request.get('/api/applications')).status()).toBe(403);
    expectNoPageErrors(staffErrors);
  } finally {
    await staffContext.close();
  }
  expectNoPageErrors(pageErrors);
});

test('the bootstrap administrator identity remains stable', async ({ page }) => {
  const pageErrors = watchForPageErrors(page);
  await signInAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await selectDevelopmentOrganisation(page);
  await page.goto('/settings/people');
  await expect(page.getByRole('listitem').filter({ hasText: ADMIN_EMAIL })).toContainText(
    'Organisation Administrator',
  );
  await expectNoWcagViolations(page);
  expectNoPageErrors(pageErrors);
});
