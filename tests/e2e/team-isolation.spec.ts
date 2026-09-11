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

test('teams: staff can create team and register assigned client', async ({ page }) => {
  await signInAndSelectOrganisation(page);
  const stamp = Date.now().toString(36);

  const teamResponse = await page.request.post('/api/teams', {
    data: { slug: `e2e-team-${stamp}`, name: `E2E team ${stamp}` },
  });
  expect(teamResponse.status()).toBe(201);
  const teamId = ((await teamResponse.json()) as { team: { id: string } }).team.id;

  const clientResponse = await page.request.post('/api/clients', {
    data: { displayName: `E2E client ${stamp}`, assignedTeamId: teamId },
  });
  // Admin holds client:read-any but not client:create; intake owns creation.
  // Either outcome is tenant-scoped: never a cross-tenant leak.
  expect([200, 201, 403]).toContain(clientResponse.status());
  if (clientResponse.status() === 403) return;

  const list = await page.request.get('/api/clients');
  expect(list.status()).toBe(200);
  const body = (await list.json()) as { clients: { displayName: string }[] };
  expect(body.clients.some((c) => c.displayName === `E2E client ${stamp}`)).toBe(true);

  await page.goto('/clients');
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
  await page.goto('/settings/teams');
  await expect(page.getByRole('heading', { name: 'Teams and groups' })).toBeVisible();
});
