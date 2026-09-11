import axe from 'axe-core';
import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL,
  APPLICANT_EMAIL,
  APPLICANT_PASSWORD,
  isolateSignInClient,
  signInAndSelectOrganisation,
} from './helpers/auth';

async function expectNoSeriousAccessibilityViolations(page: Page): Promise<void> {
  // App Router metadata can stream after the page's visible content on a slow
  // CI runner. Wait for the title before asking axe to inspect the final DOM.
  await expect(page).toHaveTitle(/\S/);
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    interface AxeResult {
      impact: string | null;
      id: string;
      help: string;
      nodes: Array<{ target: string[] }>;
    }
    const runner = (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: object,
          ) => Promise<{ violations: AxeResult[] }>;
        };
      }
    ).axe;
    const result = await runner.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
      },
    });
    return result.violations
      .filter(({ impact }) => impact === 'critical' || impact === 'serious')
      .map(({ id, help, nodes }) => ({
        id,
        help,
        targets: nodes.map(({ target }) => target.join(' ')),
      }));
  });

  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

test('protected routes reject anonymous access and sign-in errors stay generic', async ({
  page,
}) => {
  await isolateSignInClient(page);
  const apiResponse = await page.request.get('/api/applications');
  expect(apiResponse.status()).toBe(401);
  await expect(apiResponse.json()).resolves.toEqual({ error: 'Unauthorized' });

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel('Email').fill('unknown@example.test');
  await page.getByLabel('Password').fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Those sign-in details didn’t match' }),
  ).toBeVisible();
  await expect(page.getByLabel('Email')).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);
});

test('public support and certificate-verification journeys are usable', async ({
  page,
}) => {
  const destinations = [
    ['Accessibility', '/accessibility', 'Accessibility'],
    ['Privacy', '/privacy', 'Privacy'],
    ['Support', '/support', 'Support'],
    ['Find an organisation', '/organisations', 'Find an organisation'],
  ] as const;

  for (const [linkName, path, heading] of destinations) {
    await page.goto('/');
    await page.getByRole('link', { name: linkName, exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }

  await page.goto('/verify');
  await page.getByLabel('Certificate code').fill('  not-a-real-certificate-code  ');
  await page.getByRole('button', { name: 'Verify certificate' }).click();
  await expect(page).toHaveURL(/\/verify\/not-a-real-certificate-code$/);
  await expect(
    page.getByRole('heading', { name: 'Certificate not found' }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test('staff can select a tenant, validate input, and start and find an application', async ({
  page,
}) => {
  await signInAndSelectOrganisation(page);

  const invalidResponse = await page.request.post('/api/applications', {
    data: { applicantName: '', priority: 'urgent' },
  });
  expect(invalidResponse.status()).toBe(400);
  await expect(invalidResponse.json()).resolves.toEqual({ error: 'Invalid request' });

  await page.getByRole('link', { name: 'Applications' }).first().click();
  await expect(
    page.getByRole('heading', { name: 'Applications', exact: true }),
  ).toBeVisible();

  await page.getByLabel('Search applications').fill('definitely-no-match');
  await expect(page.getByText('No applications match this search.')).toBeVisible();
  await page.getByLabel('Search applications').clear();

  const applicantName = `E2E case record ${Date.now()}`;
  await page.getByLabel('Name as provided').fill(applicantName);
  await page.getByLabel('Handling priority').selectOption('high');
  await page.getByRole('button', { name: 'Start application' }).click();

  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]+$/);
  await expect(page.getByLabel('Name as provided')).toHaveValue(applicantName);
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Applications' }).first().click();
  await page.getByLabel('Search applications').fill(applicantName);
  const applicationLink = page.getByRole('link', { name: new RegExp(applicantName) });
  await expect(applicationLink).toContainText('High priority');
  await expectNoSeriousAccessibilityViolations(page);
});

test('organisation administrators can view access controls but cannot suspend themselves', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signInAndSelectOrganisation(page);
  await page.goto('/settings/people');
  await expect(page.getByRole('heading', { name: 'People and access' })).toBeVisible();

  const invalidResponse = await page.request.post('/api/memberships', {
    data: { email: 'not-an-email', roleId: 'not-a-role-id' },
  });
  expect(invalidResponse.status()).toBe(400);

  const ownMembership = page.getByRole('listitem').filter({ hasText: ADMIN_EMAIL });
  await expect(ownMembership).toContainText('Organisation Administrator');
  await expect(ownMembership).toContainText('Intake Officer');
  await ownMembership.getByLabel('Assigned role').selectOption({ label: 'Applicant' });
  await ownMembership.getByRole('button', { name: 'Change role' }).click();
  await expect(page.getByText('That role change could not be made.')).toBeVisible();
  await expect(ownMembership).toContainText('Organisation Administrator');
  await ownMembership.getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByText('That access change could not be made.')).toBeVisible();
  await expect(ownMembership).toContainText('active');
  await expectNoSeriousAccessibilityViolations(page);
});

test('a linked applicant uploads evidence into quarantine without download access', async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    process.env.RUN_EVIDENCE_E2E !== 'true',
    'Needs real object storage: local MinIO or S3 staging (see docs/eks-runbook.md).',
  );
  test.setTimeout(60_000);
  await signInAndSelectOrganisation(page);
  await page.goto('/settings/people');
  await page.getByLabel('Initial role').selectOption({ label: 'Applicant' });
  const applicantRoleId = await page.getByLabel('Initial role').inputValue();
  const addApplicant = await page.request.post('/api/memberships', {
    data: { email: APPLICANT_EMAIL, roleId: applicantRoleId },
  });
  expect(addApplicant.status()).toBe(201);

  await page.goto('/applications');
  const stamp = Date.now();
  const applicantName = `Linked E2E applicant ${stamp}`;
  await page.getByLabel('Name as provided').fill(applicantName);
  await page.getByLabel('Applicant account (optional)').selectOption({
    label: `Dev Staff Member (${APPLICANT_EMAIL})`,
  });
  await page.getByRole('button', { name: 'Start application' }).click();
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]+$/);

  if (!baseURL) throw new Error('Playwright baseURL is required for this test.');
  const applicantContext = await browser.newContext({ baseURL });
  const applicantPage = await applicantContext.newPage();
  await isolateSignInClient(applicantPage);
  await applicantPage.goto('/sign-in');
  await applicantPage.getByLabel('Email').fill(APPLICANT_EMAIL);
  await applicantPage.getByLabel('Password').fill(APPLICANT_PASSWORD);
  await applicantPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(applicantPage).toHaveURL(/\/(?:select-organisation|dashboard)$/);
  if (/\/select-organisation$/.test(applicantPage.url())) {
    await applicantPage
      .getByRole('button', { name: /BlakPath Development Organisation/ })
      .click();
  }
  await expect(applicantPage).toHaveURL(/\/dashboard$/);
  await applicantPage.goto('/applications');
  await applicantPage.getByRole('link', { name: new RegExp(applicantName) }).click();

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  await applicantPage.getByLabel('Upload supporting evidence').setInputFiles({
    name: `supporting-record-${stamp}.png`,
    mimeType: 'image/png',
    buffer: png,
  });
  const completedResponse = applicantPage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/evidence\/[0-9a-f-]+\/complete$/.test(response.url()),
  );
  await applicantPage.getByRole('button', { name: 'Upload evidence' }).click();
  const completed = await completedResponse;
  expect(completed.status()).toBe(200);
  const payload = (await completed.json()) as { evidence: { id: string } };

  await expect(
    applicantPage.getByText(
      'Evidence uploaded to quarantine. It cannot be opened until the scan is clean.',
    ),
  ).toBeVisible();
  await expect(applicantPage.getByText('Quarantined', { exact: true })).toBeVisible();
  await expect(applicantPage.getByRole('link', { name: 'Download' })).toHaveCount(0);

  const deniedDownload = await applicantPage.request.get(
    `/api/evidence/${payload.evidence.id}/download`,
  );
  expect(deniedDownload.status()).toBe(403);
  await expect(deniedDownload.json()).resolves.toEqual({ error: 'Forbidden' });
  await expectNoSeriousAccessibilityViolations(applicantPage);
  await applicantContext.close();
});

test('staff can progress a case through review and a human committee decision', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signInAndSelectOrganisation(page);
  await page.goto('/applications');

  const stamp = Date.now();
  const originalName = `E2E workspace case ${stamp}`;
  const updatedName = `${originalName} updated`;
  await page.getByLabel('Name as provided').fill(originalName);
  await page.getByRole('button', { name: 'Start application' }).click();
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]+$/);

  await expect(page.getByRole('heading', { name: /APP-\d{4}-/ })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('No evidence has been uploaded.')).toBeVisible();
  await expect(page.getByText(/Files stay quarantined and unavailable/)).toBeVisible();

  await page.getByLabel('Name as provided').fill(updatedName);
  await page.getByLabel('Handling priority').selectOption('high');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByRole('status')).toContainText('Intake details saved.');

  await page.getByRole('button', { name: 'Assign to me' }).click();
  await expect(page.getByRole('status')).toContainText('Case assigned to you.');
  await expect(page.getByText('This case is assigned to you.')).toBeVisible();

  await expect(page.getByLabel('Next step')).toHaveValue('submit');
  await page.getByRole('button', { name: 'Record next step' }).click();
  await expect(page.getByText('Submitted', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Next step')).toHaveValue('begin_intake');
  await page.getByRole('button', { name: 'Record next step' }).click();
  await expect(page.getByText('Intake Review', { exact: true }).first()).toBeVisible();

  const requestText = `Please provide the community record discussed at intake ${stamp}`;
  await page.getByLabel('Request further evidence').fill(requestText);
  await page.getByRole('button', { name: 'Record request' }).click();
  await expect(page.getByRole('status')).toContainText('Evidence request recorded.');
  await expect(page.getByText(requestText, { exact: true })).toBeVisible();

  const noteText = `Applicant prefers contact after 3 pm ${stamp}`;
  await page.getByLabel('Add a note').fill(noteText);
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByRole('status')).toContainText('Case note added.');
  await expect(page.getByText(noteText, { exact: true })).toBeVisible();

  await page.getByLabel('Next step').selectOption('start_review');
  await page.getByRole('button', { name: 'Record next step' }).click();
  await expect(page.getByText('In Review', { exact: true }).first()).toBeVisible();

  const reviewText = `Observations recorded by the E2E case officer ${stamp}`;
  await page.getByLabel('Reviewer observations').fill(reviewText);
  await page.getByRole('button', { name: 'Record draft review' }).click();
  await expect(page.getByText(reviewText, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Finalise review' }).click();
  await expect(
    page.getByText('Review finalised for the committee record.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reopen review' })).toBeVisible();

  await page.getByLabel('Next step').selectOption('ready_for_committee');
  await page.getByRole('button', { name: 'Record next step' }).click();
  await expect(
    page.getByText('Ready For Committee', { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByLabel('Next step')).toHaveValue('schedule_committee');
  await page.getByRole('button', { name: 'Record next step' }).click();
  await expect(page.getByText('In Committee', { exact: true }).first()).toBeVisible();

  const rationale = `Committee proposal recorded by a person ${stamp}`;
  await page
    .getByLabel('Outcome proposed by a committee member')
    .selectOption('confirmed');
  await page.getByLabel('Rationale (optional)').fill(rationale);
  await page.getByRole('button', { name: 'Record decision proposal' }).click();
  await expect(page.getByText(rationale, { exact: true })).toBeVisible();

  await page.getByLabel('Your vote').selectOption('for');
  await page.getByLabel('Vote note (optional)').fill('Vote entered by the member.');
  await page.getByRole('button', { name: 'Record my vote' }).click();
  await expect(page.getByRole('button', { name: 'Change my vote' })).toBeVisible();
  await expect(
    page.getByText(/Recorded votes: 1 for, 0 against, 0 abstained/),
  ).toBeVisible();

  await page.getByLabel('Outcome decided by the committee').selectOption('confirmed');
  await page
    .getByLabel('Committee record note (optional)')
    .fill('Final outcome entered by the authorised chair.');
  await page.getByRole('button', { name: 'Record final outcome' }).click();
  await expect(page.getByText('Decided', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate certificate' })).toBeVisible();

  const denied = await page.request.patch(
    '/api/applications/00000000-0000-4000-8000-000000000000',
    { data: { operation: 'assign_self' } },
  );
  expect(denied.status()).toBe(403);
  await expect(denied.json()).resolves.toEqual({ error: 'Forbidden' });

  await expectNoSeriousAccessibilityViolations(page);
});
