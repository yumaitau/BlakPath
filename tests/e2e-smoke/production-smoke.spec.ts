import { expect, test } from '../e2e/helpers/page';
import { expectNoWcagViolations } from '../e2e/helpers/accessibility';
import { expectNoPageErrors, watchForPageErrors } from '../e2e/helpers/page-errors';

/**
 * Hits a running `runner` image. No sign-in: production cookies are Secure,
 * and this suite only proves the image boots and serves the public shell.
 * The image enforces the production release gate at boot, so it needs a real
 * production configuration (KMS, SES, managed S3): point PLAYWRIGHT_BASE_URL
 * at a staging deployment. CI covers a production build with `next start`.
 */
test('production runner image serves health and sign-in', async ({ page, request }) => {
  const pageErrors = watchForPageErrors(page);

  await test.step('production image health and liveness', async () => {
    const live = await request.get('/api/live');
    expect(live.status()).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: 'ok' });

    const health = await request.get('/api/health');
    if (health.status() === 403) {
      // Readiness is internal only; traffic through the edge is refused.
      await expect(health.json()).resolves.toMatchObject({ error: 'Forbidden' });
      return;
    }
    const payload = (await health.json()) as { status: string; checks: object };
    if (payload.status === 'healthy') {
      expect(health.status()).toBe(200);
    } else {
      expect(payload.status).toBe('degraded');
      expect(health.status()).toBe(503);
    }
    expect(payload.checks).toBeTruthy();
  });

  await test.step('production image serves sign-in', async () => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fdashboard$/);
  });

  expectNoPageErrors(pageErrors);
});
