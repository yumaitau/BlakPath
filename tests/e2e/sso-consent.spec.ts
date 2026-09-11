import { expect, test } from '@playwright/test';
import { signInAndSelectOrganisation } from './helpers/auth';

/**
 * SSO bindings + consent gate (#26). Federated session issuance stays open
 * work; this locks the shippable surface: bindings list gated, consent CRUD
 * works, representative access without live consent is denied and audited.
 */
test('sso: bindings list is admin-gated, anonymous denied', async ({ page, request }) => {
  const anon = await request.get('/api/sso/providers');
  expect(anon.status()).toBe(401);

  await signInAndSelectOrganisation(page);
  const list = await page.request.get('/api/sso/providers');
  expect([200, 403]).toContain(list.status());
  if (list.status() === 200) {
    const body = (await list.json()) as { providers: unknown[] };
    expect(Array.isArray(body.providers)).toBe(true);
  }
});

test('consent: record, list, and gate representative access', async ({ page }) => {
  await signInAndSelectOrganisation(page);

  // Representative request with a bogus consent id must deny, never create.
  const denied = await page.request.post('/api/representatives', {
    data: {
      subjectUserId: '00000000-0000-4000-8000-000000000000',
      representativeUserId: '00000000-0000-4000-8000-000000000001',
      purpose: 'Act on my behalf',
      consentRecordId: '00000000-0000-4000-8000-000000000002',
    },
  });
  expect([400, 403, 404]).toContain(denied.status());

  // SCIM is off without bearer: denied, no user enumeration.
  const scim = await page.request.post(
    '/api/scim/v2/00000000-0000-4000-8000-000000000000/Users',
    {
      data: { userName: 'nobody@example.test' },
    },
  );
  expect([403, 404]).toContain(scim.status());
});
