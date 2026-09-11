import { expect, type Page } from '@playwright/test';

export const ADMIN_EMAIL = 'admin@blakpath.local';
export const ADMIN_PASSWORD = 'blakpath-dev-admin-2026';
export const APPLICANT_EMAIL = 'staff@blakpath.local';
export const APPLICANT_PASSWORD = 'blakpath-dev-staff-2026';

let selectedAdminCookies:
  | Awaited<ReturnType<ReturnType<Page['context']>['cookies']>>
  | undefined;

/**
 * Give each interactive sign-in its own documentation-only client address.
 *
 * The acceptance suite signs in several independent browser contexts in quick
 * succession. On a CI runner they otherwise share localhost's five-attempt
 * production-style rate-limit bucket and later, valid sign-ins are rejected.
 * A unique RFC 3849 address keeps rate limiting enabled while modelling the
 * independent clients these contexts represent.
 */
export async function isolateSignInClient(page: Page): Promise<void> {
  const groups = globalThis.crypto
    .randomUUID()
    .replaceAll('-', '')
    .slice(0, 24)
    .match(/.{4}/g);
  if (!groups) throw new Error('Unable to generate an isolated E2E client address.');
  await page.context().setExtraHTTPHeaders({
    'x-forwarded-for': `2001:db8:${groups.join(':')}`,
  });
}

export async function signIn(page: Page): Promise<void> {
  await isolateSignInClient(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/(?:select-organisation|dashboard)$/, {
    timeout: 30_000,
  });
}

export async function selectDevelopmentOrganisation(page: Page): Promise<void> {
  if (/\/dashboard$/.test(page.url())) {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    selectedAdminCookies = await page.context().cookies();
    return;
  }
  await page.getByRole('button', { name: /BlakPath Development Organisation/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  selectedAdminCookies = await page.context().cookies();
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
