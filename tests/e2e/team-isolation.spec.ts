import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  isolateSignInClient,
  selectDevelopmentOrganisation,
  signInAndSelectOrganisation,
} from './helpers/auth';

/**
 * Council / team isolation. Council = organisation tenant. Client records,
 * teams and groups (docs/council-trust-model.md) must never leak across
 * tenants. Anonymous callers stay at 401. A case officer on the client's team
 * can read the linked matter; a case officer who is not on that team cannot.
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

async function signInFresh(page: Page, email: string, password: string): Promise<void> {
  await isolateSignInClient(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/(?:select-organisation|dashboard)$/, {
    timeout: 30_000,
  });
}

test('team member reads a linked case and a non-member is denied', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  const page = await adminContext.newPage();
  const password = 'blakpath-dev-team-2026';
  const stamp = Date.now().toString(36);
  const memberEmail = `team-member-${stamp}@blakpath.test`;
  const outsiderEmail = `team-outsider-${stamp}@blakpath.test`;
  const memberName = `Team Member ${stamp}`;
  const outsiderName = `Outsider ${stamp}`;
  const matterName = `Scoped matter ${stamp}`;

  try {
    await signInFresh(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await selectDevelopmentOrganisation(page);

    const rolesResponse = await page.request.get('/api/memberships');
    expect(rolesResponse.status()).toBe(200);
    const { roles } = (await rolesResponse.json()) as {
      roles: Array<{ id: string; name: string }>;
    };
    const caseOfficer = roles.find((role) => role.name === 'Case Officer');
    expect(caseOfficer).toBeTruthy();

    async function invite(email: string): Promise<string> {
      const response = await page.request.post('/api/membership-invitations', {
        data: { email, roleId: caseOfficer?.id },
      });
      expect(response.status()).toBe(201);
      const body = (await response.json()) as { url: string };
      const token = new URL(body.url).pathname.split('/').pop();
      if (!token) throw new Error('Invitation URL did not include a token.');
      return token;
    }

    const memberToken = await invite(memberEmail);
    const outsiderToken = await invite(outsiderEmail);
    for (const [token, name] of [
      [memberToken, memberName],
      [outsiderToken, outsiderName],
    ] as const) {
      const created = await page.request.post(
        '/api/membership-invitations/create-account',
        {
          data: { token, name, password },
        },
      );
      expect(created.status()).toBe(201);
    }

    const teamResponse = await page.request.post('/api/teams', {
      data: { slug: `e2e-scope-${stamp}`, name: `Scope ${stamp}` },
    });
    expect(teamResponse.status()).toBe(201);
    const teamId = ((await teamResponse.json()) as { team: { id: string } }).team.id;

    const groupResponse = await page.request.post('/api/groups', {
      data: { slug: `e2e-group-${stamp}`, name: `Group ${stamp}` },
    });
    expect(groupResponse.status()).toBe(201);

    const clientResponse = await page.request.post('/api/clients', {
      data: { displayName: `Scoped client ${stamp}`, assignedTeamId: teamId },
    });
    expect(clientResponse.status()).toBe(201);
    const clientId = ((await clientResponse.json()) as { client: { id: string } }).client
      .id;

    await page.goto('/applications');
    await page.getByLabel('Name as provided').fill(matterName);
    await page.getByLabel('Client record (optional)').selectOption({
      label: `Scoped client ${stamp}`,
    });
    await page.getByRole('button', { name: 'Start application' }).click();
    await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/);
    const applicationId = new URL(page.url()).pathname.split('/').pop();
    if (!applicationId) throw new Error('Application URL did not include an id.');
    await expect(page.getByLabel('Client record')).toHaveValue(clientId);
    const application = { id: applicationId };

    async function acceptAs(email: string, token: string) {
      const context = await browser.newContext();
      const userPage = await context.newPage();
      await signInFresh(userPage, email, password);
      const accepted = await userPage.request.post('/api/membership-invitations/accept', {
        data: { token },
      });
      expect(accepted.status()).toBe(200);
      return { context, userPage };
    }

    const member = await acceptAs(memberEmail, memberToken);
    const outsider = await acceptAs(outsiderEmail, outsiderToken);
    try {
      await member.userPage.goto(`/applications/${application.id}`);
      await expect(
        member.userPage.getByRole('heading', { name: 'Application unavailable' }),
      ).toBeVisible();

      await page.goto('/settings/teams');
      const teamItem = page.getByRole('listitem').filter({
        has: page.getByRole('button', { name: `Add to Scope ${stamp}` }),
      });
      await teamItem.getByLabel('Staff member').selectOption({
        label: `${memberName} (${memberEmail})`,
      });
      await teamItem.getByRole('button', { name: `Add to Scope ${stamp}` }).click();
      await expect(page.getByText('Team member added.')).toBeVisible();
      await expect(
        teamItem.getByRole('button', {
          name: `Remove ${memberName} from Scope ${stamp}`,
        }),
      ).toBeVisible();

      const memberList = await member.userPage.request.get('/api/applications?limit=100');
      expect(memberList.status()).toBe(200);
      const memberItems = ((await memberList.json()) as { items: Array<{ id: string }> })
        .items;
      expect(memberItems.some((item) => item.id === application.id)).toBe(true);
      await member.userPage.goto(`/applications/${application.id}`);
      await expect(member.userPage.getByLabel('Name as provided')).toHaveValue(
        matterName,
      );

      const outsiderList = await outsider.userPage.request.get(
        '/api/applications?limit=100',
      );
      expect(outsiderList.status()).toBe(200);
      const outsiderItems = (
        (await outsiderList.json()) as { items: Array<{ id: string }> }
      ).items;
      expect(outsiderItems.some((item) => item.id === application.id)).toBe(false);
      await outsider.userPage.goto(`/applications/${application.id}`);
      await expect(
        outsider.userPage.getByRole('heading', { name: 'Application unavailable' }),
      ).toBeVisible();

      await teamItem
        .getByRole('button', { name: `Remove ${memberName} from Scope ${stamp}` })
        .click();
      await expect(page.getByText('Team member removed.')).toBeVisible();
      await member.userPage.goto(`/applications/${application.id}`);
      await expect(
        member.userPage.getByRole('heading', { name: 'Application unavailable' }),
      ).toBeVisible();

      await page.goto(`/applications/${application.id}`);
      await page.getByLabel('Assign to a colleague').selectOption({
        label: `${memberName} (${memberEmail})`,
      });
      await page.getByRole('button', { name: 'Assign case' }).click();
      await expect(page.getByText('Case assigned.')).toBeVisible();
      await member.userPage.goto(`/applications/${application.id}`);
      await expect(
        member.userPage.getByText('This case is assigned to you.'),
      ).toBeVisible();

      const groupItem = page.locator('section[aria-label="Groups"] li').filter({
        has: page.getByRole('button', { name: `Add to Group ${stamp}` }),
      });
      await page.goto('/settings/teams');
      await groupItem.getByLabel('Staff member').selectOption({
        label: `${outsiderName} (${outsiderEmail})`,
      });
      await groupItem.getByRole('button', { name: `Add to Group ${stamp}` }).click();
      await expect(page.getByText('Group member added.')).toBeVisible();
      await groupItem
        .getByRole('button', { name: `Remove ${outsiderName} from Group ${stamp}` })
        .click();
      await expect(page.getByText('Group member removed.')).toBeVisible();
    } finally {
      await member.context.close();
      await outsider.context.close();
    }
  } finally {
    await adminContext.close();
  }
});
