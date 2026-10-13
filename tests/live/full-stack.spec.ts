import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  APPLICANT_EMAIL,
  APPLICANT_PASSWORD,
  isolateSignInClient,
  signInAndSelectOrganisation,
} from '../e2e/helpers/auth';

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

interface MailpitMessages {
  messages: MailpitSummary[];
}

async function signInApplicant(page: Page): Promise<void> {
  await isolateSignInClient(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(APPLICANT_EMAIL);
  await page.getByLabel('Password').fill(APPLICANT_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/(?:select-organisation|dashboard)$/);
  if (/\/select-organisation$/.test(page.url())) {
    await page.getByRole('button', { name: /BlakPath Development Organisation/ }).click();
  }
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function findMailpitMessage(
  mailpitUrl: string,
  recipient: string,
): Promise<MailpitSummary | undefined> {
  const response = await fetch(`${mailpitUrl}/api/v1/messages`);
  if (!response.ok) return undefined;
  const payload = (await response.json()) as MailpitMessages;
  return payload.messages.find((message) =>
    message.To.some((address) => address.Address === recipient),
  );
}

async function createApplicantMembership(page: Page): Promise<void> {
  await page.goto('/settings/people');
  await page.getByLabel('Initial role').selectOption({ label: 'Applicant' });
  const applicantRoleId = await page.getByLabel('Initial role').inputValue();
  const response = await page.request.post('/api/memberships', {
    data: { email: APPLICANT_EMAIL, roleId: applicantRoleId },
  });
  expect(response.status()).toBe(201);
}

async function uploadEvidence(
  browser: Browser,
  baseURL: string,
  applicationUrl: string,
  stamp: number,
): Promise<void> {
  const applicantContext = await browser.newContext({ baseURL });
  const applicantPage = await applicantContext.newPage();
  try {
    await signInApplicant(applicantPage);
    await applicantPage.goto(applicationUrl);

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    await applicantPage.getByLabel('Upload supporting evidence').setInputFiles({
      name: `live-stack-${stamp}.png`,
      mimeType: 'image/png',
      buffer: png,
    });
    await applicantPage.getByLabel('I have read this collection notice').check();
    await applicantPage.getByRole('button', { name: 'Upload evidence' }).click();
    await expect(
      applicantPage.getByText(
        'Evidence uploaded to quarantine. It cannot be opened until the scan is clean.',
      ),
    ).toBeVisible();
    await expect(applicantPage.getByText('Quarantined', { exact: true })).toBeVisible();
  } finally {
    await applicantContext.close();
  }
}

test('seeded users complete the database, scan, email and public-form journey', async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Playwright baseURL is required.');
  const mailpitUrl = process.env.LIVE_MAILPIT_URL;
  if (!mailpitUrl) throw new Error('LIVE_MAILPIT_URL is required.');

  await signInAndSelectOrganisation(page);
  await createApplicantMembership(page);

  const stamp = Date.now();
  const applicantName = `Live stack applicant ${stamp}`;
  await page.goto('/applications');
  await page.getByLabel('Name as provided').fill(applicantName);
  await page.getByLabel('Applicant account (optional)').selectOption({
    label: `Dev Staff Member (${APPLICANT_EMAIL})`,
  });
  await page.getByLabel('I have given this collection notice to the applicant').check();
  await page.getByRole('button', { name: 'Start application' }).click();
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]+$/);
  const applicationUrl = page.url();

  await uploadEvidence(browser, baseURL, applicationUrl, stamp);

  await expect
    .poll(
      async () => {
        await page.goto(applicationUrl);
        return page.getByText('Scan clean', { exact: true }).count();
      },
      { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(1);
  await expect(page.getByRole('link', { name: 'Download' })).toBeVisible();

  await page.goto('/forms');
  await page.getByRole('button', { name: 'Create a form' }).click();
  await page.getByLabel('Form title').fill(`Live stack form ${stamp}`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/forms\/[0-9a-f-]+$/);
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByRole('textbox', { name: /^Label/ }).fill('Community response');
  await page.getByRole('checkbox', { name: 'Required' }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await page.getByRole('button', { name: 'Publish' }).click();

  const recipient = `live-recipient-${stamp}@example.test`;
  await page.getByLabel('Recipient name').fill('Live recipient');
  await page.getByLabel('Recipient email').fill(recipient);
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const invitationUrl = await page.getByLabel('Invitation link').inputValue();

  await expect
    .poll(() => findMailpitMessage(mailpitUrl, recipient), {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
    })
    .not.toBeUndefined();
  const message = await findMailpitMessage(mailpitUrl, recipient);
  expect(message?.Subject).toBe('You have been invited to complete a form in BlakPath');
  const messageResponse = await fetch(`${mailpitUrl}/api/v1/message/${message?.ID}`);
  expect(messageResponse.ok).toBe(true);
  expect(await messageResponse.text()).toContain(invitationUrl);

  const publicContext = await browser.newContext({ baseURL });
  const publicPage = await publicContext.newPage();
  try {
    await publicPage.goto(invitationUrl);
    await publicPage.getByLabel('Community response').fill(`Live response ${stamp}`);
    await publicPage.getByLabel('I have read this collection notice').check();
    await publicPage.getByRole('button', { name: 'Submit' }).click();
    await expect(
      publicPage.getByRole('heading', {
        name: 'Thank you — your response has been recorded.',
      }),
    ).toBeVisible();
  } finally {
    await publicContext.close();
  }
});
