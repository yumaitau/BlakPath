import { expect, test, type Page } from '@playwright/test';
import { CLIENT_IP_HEADER, ORIGIN_VERIFY_HEADER } from '@/lib/http/client-ip';
import { E2E_ORIGIN_VERIFY_SECRET } from './origin-verify';

export const ADMIN_EMAIL = 'admin@blakpath.local';
export const ADMIN_PASSWORD = 'blakpath-dev-admin-2026';
export const APPLICANT_EMAIL = 'staff@blakpath.local';
export const APPLICANT_PASSWORD = 'blakpath-dev-staff-2026';
/** Seeded applicant-only account. Distinct from the spare staff account above. */
export const PORTAL_APPLICANT_EMAIL = 'applicant@blakpath.local';
export const PORTAL_APPLICANT_PASSWORD = 'blakpath-dev-applicant-2026';

let selectedAdminCookies:
  Awaited<ReturnType<ReturnType<Page['context']>['cookies']>> | undefined;

/**
 * Give each interactive sign-in its own documentation-only client address.
 *
 * The acceptance suite signs in several independent browser contexts in quick
 * succession. On a CI runner they otherwise share localhost's five-attempt
 * production-style rate-limit bucket and later, valid sign-ins are rejected.
 * A unique RFC 3849 address keeps rate limiting enabled while modelling the
 * independent clients these contexts represent. The address is sent as
 * CF-Connecting-IP together with the Playwright origin-verify secret, which is
 * the only pair the app will treat as a client identity.
 */
export async function isolateSignInClient(page: Page): Promise<void> {
  const groups = globalThis.crypto
    .randomUUID()
    .replaceAll('-', '')
    .slice(0, 24)
    .match(/.{4}/g);
  if (!groups) throw new Error('Unable to generate an isolated E2E client address.');
  // setExtraHTTPHeaders replaces the config's headers, so keep its Origin.
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('Playwright baseURL is required for E2E sign-in.');
  await page.context().setExtraHTTPHeaders({
    Origin: baseURL,
    [CLIENT_IP_HEADER]: `2001:db8:${groups.join(':')}`,
    [ORIGIN_VERIFY_HEADER]: E2E_ORIGIN_VERIFY_SECRET,
  });
}

export async function signInAs(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await isolateSignInClient(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/(?:select-organisation|dashboard)$/, {
    timeout: 30_000,
  });
}

export async function selectOrganisation(
  page: Page,
  name: string | RegExp,
): Promise<void> {
  if (/\/dashboard$/.test(page.url())) {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    return;
  }
  await page.getByRole('button', { name }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

export async function signIn(page: Page): Promise<void> {
  await signInAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
}

export async function selectDevelopmentOrganisation(page: Page): Promise<void> {
  if (/\/dashboard$/.test(page.url())) {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    selectedAdminCookies = await page.context().cookies();
    return;
  }
  // Wait for the selection request with the click, so a lost click fails here
  // with a clear cause rather than as a URL timeout.
  const [selected] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/organisations/active',
    ),
    page.getByRole('button', { name: /BlakPath Development Organisation/ }).click(),
  ]);
  expect(selected.ok()).toBe(true);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  selectedAdminCookies = await page.context().cookies();
}

/** Sign in as the seeded applicant. Lands on the portal, never the staff shell. */
export async function signInAsPortalApplicant(page: Page): Promise<void> {
  await isolateSignInClient(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(PORTAL_APPLICANT_EMAIL);
  await page.getByLabel('Password').fill(PORTAL_APPLICANT_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/(?:select-organisation|portal)/, { timeout: 30_000 });
  if (/\/select-organisation/.test(page.url())) {
    await page.getByRole('button', { name: /BlakPath Development Organisation/ }).click();
  }
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('navigation', { name: 'Your application' })).toBeVisible();
}

export async function signInAndSelectOrganisation(page: Page): Promise<void> {
  if (selectedAdminCookies) {
    await page.context().addCookies(selectedAdminCookies);
    await page.goto('/dashboard');
    // A prior spec may have signed out (revoking the shared session) or the
    // session may have aged out. Fall back to a fresh sign-in instead of
    // failing order-dependently.
    try {
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
        timeout: 10_000,
      });
      return;
    } catch {
      selectedAdminCookies = undefined;
    }
  }
  await signIn(page);
  await selectDevelopmentOrganisation(page);
}
