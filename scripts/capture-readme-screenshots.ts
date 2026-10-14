import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import { chromium, type Page } from '@playwright/test';

const environment = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;

const baseUrl = environment?.SCREENSHOT_URL ?? 'http://127.0.0.1:3000';
const email = environment?.SCREENSHOT_EMAIL ?? 'admin@blakpath.local';
const password = environment?.SCREENSHOT_PASSWORD ?? 'blakpath-dev-admin-2026';
const authSecret = environment?.SCREENSHOT_AUTH_SECRET ?? environment?.BETTER_AUTH_SECRET;
const shotsDir = resolve('docs/screenshots');

function pageUrl(pathname: string): string {
  return new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`).toString();
}

function output(fileName: string): string {
  return resolve(shotsDir, fileName);
}

async function capture(
  page: Page,
  pathname: string,
  ready: () => Promise<void>,
  fileName: string,
): Promise<void> {
  await page.goto(pageUrl(pathname), { waitUntil: 'domcontentloaded' });
  await ready();
  await page.screenshot({ path: output(fileName), fullPage: true });
}

function signSessionData(input: {
  session: {
    session: Record<string, unknown>;
    user: Record<string, unknown>;
    updatedAt: number;
    version: string;
  };
  expiresAt: number;
}): string {
  if (!authSecret) {
    throw new Error('SCREENSHOT_AUTH_SECRET or BETTER_AUTH_SECRET is required.');
  }
  const payload = JSON.stringify({ ...input.session, expiresAt: input.expiresAt });
  const signature = crypto
    .createHmac('sha256', authSecret)
    .update(payload)
    .digest('base64url');
  return Buffer.from(JSON.stringify({ ...input, signature })).toString('base64');
}

async function setActiveOrganisation(page: Page, organisationId: string): Promise<void> {
  const cookies = await page.context().cookies();
  const sessionDataCookie = cookies.find(
    (cookie) =>
      cookie.name === '__Host-blakpath.session_data' ||
      cookie.name === '__Secure-blakpath.session_data' ||
      cookie.name === 'blakpath.session_data',
  );
  if (!sessionDataCookie) throw new Error('session cache cookie is missing');
  const decoded = JSON.parse(
    Buffer.from(sessionDataCookie.value, 'base64').toString('utf8'),
  ) as {
    session: {
      session: Record<string, unknown> & { activeOrganisationId?: string | null };
      user: Record<string, unknown>;
      updatedAt: number;
      version: string;
    };
    expiresAt: number;
  };
  decoded.session.session.activeOrganisationId = organisationId;
  decoded.session.updatedAt = Date.now();
  await page.context().addCookies([
    {
      name: sessionDataCookie.name,
      value: signSessionData(decoded),
      domain: sessionDataCookie.domain,
      path: sessionDataCookie.path,
      expires: sessionDataCookie.expires,
      httpOnly: sessionDataCookie.httpOnly,
      secure: sessionDataCookie.secure,
      sameSite: sessionDataCookie.sameSite,
    },
  ]);
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: 1,
    });

    await capture(
      page,
      '/',
      async () => {
        await page
          .getByRole('heading', {
            name: 'Community-controlled confirmation, with a clearer path for everyone.',
          })
          .waitFor();
      },
      'landing-page.png',
    );

    await capture(
      page,
      '/sign-in',
      async () => {
        await page.getByLabel('Email').waitFor();
        await page.getByLabel('Password').waitFor();
        await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      },
      'sign-in.png',
    );

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForTimeout(6000);

    const memberships = await page.evaluate(async () => {
      const response = await fetch('/api/organisations', { credentials: 'include' });
      return (await response.json()) as {
        organisations: Array<{ organisationId: string }>;
      };
    });

    const organisationId = memberships.organisations[0]?.organisationId;
    if (!organisationId) {
      throw new Error('No organisations were returned for the signed-in user.');
    }

    await page.goto(pageUrl('/select-organisation'), {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('heading', { name: 'Choose an organisation' }).waitFor();
    await page.screenshot({ path: output('organisation-picker.png'), fullPage: true });

    await setActiveOrganisation(page, organisationId);
    await page.goto(pageUrl('/dashboard'), { waitUntil: 'domcontentloaded' });

    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await page.getByRole('button', { name: 'Reset section order' }).waitFor();
    await page.screenshot({ path: output('dashboard.png'), fullPage: true });

    await capture(
      page,
      '/board',
      async () => {
        await page.getByRole('heading', { name: 'Work board' }).waitFor();
        await page.getByRole('button', { name: 'Add task' }).waitFor();
      },
      'work-board.png',
    );

    await capture(
      page,
      '/forms',
      async () => {
        await page.getByRole('heading', { name: 'Forms' }).waitFor();
        await page.getByRole('button', { name: 'Create a form' }).waitFor();
      },
      'forms.png',
    );

    await capture(
      page,
      '/meetings',
      async () => {
        await page.getByRole('heading', { name: 'Committee meetings' }).waitFor();
        await page.getByText('July confirmation committee').waitFor();
      },
      'meetings.png',
    );

    await capture(
      page,
      '/settings/security',
      async () => {
        await page.getByRole('heading', { name: 'Account security' }).waitFor();
        await page.getByRole('heading', { name: 'Two-step verification' }).waitFor();
        await page.getByRole('heading', { name: 'Passkeys' }).waitFor();
      },
      'account-security.png',
    );
  } finally {
    await browser.close();
  }
}

void main();
