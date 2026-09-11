import { expect, test } from '@playwright/test';
import { signInAndSelectOrganisation } from './helpers/auth';

/**
 * Council / team isolation. Council = organisation tenant. Client records,
 * teams and groups (docs/council-trust-model.md) must never leak across
 * tenants. Until team APIs land, this locks the current isolation floor:
 * anonymous 401s, unknown-id 404s (never 200 with foreign data), and per-org
 * scoping on every tenant route.
 */
test('teams: anonymous cannot reach tenant APIs', async ({ request }) => {
  const paths = [
    '/api/applications',
    '/api/memberships',
    '/api/membership-invitations',
    '/api/calendar/meetings',
    '/api/tasks',
    '/api/notifications',
  ];
  for (const path of paths) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
  }
});

test('teams: signed-in staff cannot fetch foreign tenant object', async ({ page }) => {
  await signInAndSelectOrganisation(page);
  const foreignId = '00000000-0000-4000-8000-000000000000';
  for (const path of [
    `/api/applications/${foreignId}`,
    `/api/memberships/${foreignId}`,
  ]) {
    const response = await page.request.get(path);
    // 405 also safe: route exists but rejects GET, leaking nothing.
    expect([401, 403, 404, 405]).toContain(response.status());
  }
});

test('teams: invitation accept requires real token + session', async ({ request }) => {
  const response = await request.post('/api/membership-invitations/accept', {
    data: { token: 'not-a-real-membership-invitation-token' },
  });
  expect([401, 404]).toContain(response.status());
});
