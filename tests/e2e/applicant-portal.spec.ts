import { expect, test } from '@playwright/test';
import { expectNoWcagViolations, expectVisibleFocus } from './helpers/accessibility';
import { signInAsPortalApplicant } from './helpers/auth';

test('public directory lists opted-in organisations and blocks a closed start', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/organisations');
  await expect(page.getByRole('heading', { name: 'Find an organisation' })).toBeVisible();
  const startLink = page.getByRole('link', {
    name: 'Start an application with BlakPath Development Organisation',
  });
  await expect(startLink).toBeVisible();
  await expect(page.getByText('Closed Directory Organisation')).toHaveCount(0);
  await expect(page.getByText('The list is not a recommendation.')).toBeVisible();
  await startLink.focus();
  await expectVisibleFocus(page);
  await expectNoWcagViolations(page);

  await page.goto('/organisations/closed-org/apply');
  await expect(
    page.getByRole('heading', { name: 'Applications are not open' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'This organisation is not taking applications through BlakPath at the moment.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Closed Directory Organisation')).toHaveCount(0);
  await expectNoWcagViolations(page);

  await page.goto('/organisations/not-a-real-org/apply');
  await expect(
    page.getByRole('heading', { name: 'Applications are not open' }),
  ).toBeVisible();
  await expectNoWcagViolations(page);

  await page.goto('/organisations/dev-org/apply');
  await expect(page.getByRole('heading', { name: 'Start an application' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to start' })).toBeVisible();
  const signIn = page.getByRole('link', { name: 'Sign in to start' });
  await expect(signIn).toHaveAttribute(
    'href',
    /returnTo=%2Forganisations%2Fdev-org%2Fapply/,
  );
  await signIn.focus();
  await expectVisibleFocus(page);
  await expectNoWcagViolations(page);
});

test('an applicant sees only their own case and never the staff shell', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signInAsPortalApplicant(page);

  for (const path of ['/dashboard', '/applications', '/settings/people']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/portal$/);
    await expect(
      page.getByRole('navigation', { name: 'Primary navigation' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Your application' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Dashboard', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Applications', exact: true }),
    ).toHaveCount(0);
  }

  await expect(page.getByRole('heading', { name: 'Your applications' })).toBeVisible();
  await expect(page.getByRole('link', { name: /APP-OWN-CASE/ })).toBeVisible();
  await expect(page.getByText('APP-OTHER-CASE')).toHaveCount(0);
  await expect(page.getByText('Someone Else')).toHaveCount(0);
  await expect(page.getByText(/likelihood|progress score|% complete/i)).toHaveCount(0);
  await expectNoWcagViolations(page);

  await page.getByRole('link', { name: /APP-OWN-CASE/ }).click();
  await expect(page).toHaveURL(/\/portal\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'APP-OWN-CASE' })).toBeVisible();
  await expect(
    page.getByText('Please bring a birth certificate if you have one.'),
  ).toBeVisible();
  await expect(
    page.getByText('Internal staffing note not for the applicant.'),
  ).toHaveCount(0);
  await expect(
    page.getByText('A photo of a birth certificate, if you have one.'),
  ).toBeVisible();
  await expect(
    page.getByText('The organisation asked for more information'),
  ).toBeVisible();
  await expect(page.getByText(/likelihood|progress score|% complete/i)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(
    0,
  );

  await page.getByLabel('Upload supporting evidence').focus();
  await expectVisibleFocus(page);
  await page
    .getByRole('checkbox', { name: 'I want to withdraw this application' })
    .focus();
  await expectVisibleFocus(page);
  await page.keyboard.press('Space');
  const withdraw = page.getByRole('button', { name: 'Withdraw this application' });
  await expect(withdraw).toBeEnabled();
  await withdraw.focus();
  await expectVisibleFocus(page);
  await expectNoWcagViolations(page);
});
