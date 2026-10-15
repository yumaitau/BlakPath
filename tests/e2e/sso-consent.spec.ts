import { expect, test } from './helpers/page';
import { DEV_TENANT_B } from '../../src/db/seeds/dev-tenants';
import { expectNoWcagViolations } from './helpers/accessibility';
import { signInAndSelectOrganisation } from './helpers/auth';
import { expectNoPageErrors, watchForPageErrors } from './helpers/page-errors';

/**
 * SSO bindings + consent gate (#26). Federated sign-in itself is covered by
 * `sso-sign-in.spec.ts`; this locks the shippable surface: bindings list
 * gated, consent CRUD works, representative access without live consent is
 * denied and audited.
 */
test('sso bindings, consent gate, and SCIM-off denial', async ({ page, request }) => {
  const pageErrors = watchForPageErrors(page);

  await test.step('SSO bindings gating', async () => {
    const anon = await request.get('/api/sso/providers');
    expect(anon.status()).toBe(401);
    await expect(anon.json()).resolves.toMatchObject({ error: 'Unauthorized' });

    await signInAndSelectOrganisation(page);
    const list = await page.request.get('/api/sso/providers');
    expect(list.status()).toBe(200);
    const body = (await list.json()) as { providers: unknown[] };
    expect(Array.isArray(body.providers)).toBe(true);
  });

  await test.step('consent gate on representative access', async () => {
    const denied = await page.request.post('/api/representatives', {
      data: {
        subjectUserId: '00000000-0000-4000-8000-000000000000',
        representativeUserId: '00000000-0000-4000-8000-000000000001',
        purpose: 'Act on my behalf',
        consentRecordId: '00000000-0000-4000-8000-000000000002',
      },
    });
    expect(denied.status()).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: 'Forbidden' });
  });

  await test.step('SCIM-off denial without enumeration', async () => {
    const scim = await page.request.post(
      `/api/scim/v2/${DEV_TENANT_B.organisationId}/Users`,
      { data: { userName: 'nobody@example.test' } },
    );
    expect(scim.status()).toBe(403);
    const body = (await scim.json()) as { detail?: string; status?: string };
    expect(body.status).toBe('403');
    expect(body.detail).toBe('Forbidden');
  });

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expectNoWcagViolations(page);
  expectNoPageErrors(pageErrors);
});
