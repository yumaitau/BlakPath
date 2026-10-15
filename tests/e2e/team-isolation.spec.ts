import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { expect, test } from './helpers/page';
import {
  DEV_ORGANISATION_NAME,
  DEV_TEAM_FIXTURE,
  DEV_TENANT_B,
} from '../../src/db/seeds/dev-tenants';
import { expectNoWcagViolations } from './helpers/accessibility';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  selectDevelopmentOrganisation,
  selectOrganisation,
  signInAndSelectOrganisation,
  signInAs,
} from './helpers/auth';
import { expectNoPageErrors, watchForPageErrors } from './helpers/page-errors';

/**
 * Council / team isolation. Council = organisation tenant. Client records,
 * teams and groups (docs/council-trust-model.md) must never leak across
 * tenants. Fixture rows come from the non-production seed (tenant B and the
 * team-scoped case officers), so denials use real ids.
 */

async function finishPage(page: Page, errors: readonly Error[]): Promise<void> {
  await expectNoWcagViolations(page);
  expectNoPageErrors(errors);
}

test('teams: anonymous cannot reach tenant APIs', async ({ page, request }) => {
  const pageErrors = watchForPageErrors(page);
  const paths = [
    '/api/applications',
    '/api/memberships',
    '/api/membership-invitations',
    '/api/calendar/meetings',
    '/api/tasks',
    '/api/notifications',
  ];
  await test.step('anonymous tenant APIs deny', async () => {
    for (const path of paths) {
      const response = await request.get(path);
      expect(response.status()).toBe(401);
    }
  });
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await finishPage(page, pageErrors);
});

test('teams: council A cannot read council B', async ({ page, browser }) => {
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);

  await test.step('council A cannot read council B', async () => {
    const ownList = await page.request.get('/api/applications?limit=100');
    expect(ownList.status()).toBe(200);
    const ownBody = (await ownList.json()) as { items: { id: string }[] };
    expect(ownBody.items.some((item) => item.id === DEV_TENANT_B.applicationId)).toBe(
      false,
    );

    const foreign = await page.request.patch(
      `/api/applications/${DEV_TENANT_B.applicationId}`,
      { data: { operation: 'assign_self' } },
    );
    expect(foreign.status()).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ error: 'Forbidden' });

    const ownClients = await page.request.get('/api/clients');
    expect(ownClients.status()).toBe(200);
    const ownClientBody = (await ownClients.json()) as {
      clients: { displayName: string }[];
    };
    expect(
      ownClientBody.clients.some(
        (client) => client.displayName === DEV_TENANT_B.clientName,
      ),
    ).toBe(false);
  });

  const councilB = await browser.newContext();
  const councilBPage = await councilB.newPage();
  try {
    await signInAs(councilBPage, DEV_TENANT_B.adminEmail, DEV_TENANT_B.adminPassword);
    await selectOrganisation(councilBPage, DEV_TENANT_B.legalName);
    const foreignList = await councilBPage.request.get('/api/applications?limit=100');
    expect(foreignList.status()).toBe(200);
    const foreignBody = (await foreignList.json()) as { items: { id: string }[] };
    expect(foreignBody.items.some((item) => item.id === DEV_TENANT_B.applicationId)).toBe(
      true,
    );
    const foreignClients = await councilBPage.request.get('/api/clients');
    expect(foreignClients.status()).toBe(200);
    const foreignClientBody = (await foreignClients.json()) as {
      clients: { displayName: string }[];
    };
    expect(
      foreignClientBody.clients.some(
        (client) => client.displayName === DEV_TENANT_B.clientName,
      ),
    ).toBe(true);
  } finally {
    await councilB.close();
  }

  await page.goto('/clients');
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
  await finishPage(page, pageErrors);
});

test('teams: assigned officer sees the team client, unassigned officer does not', async ({
  browser,
}) => {
  async function clientNames(email: string, password: string): Promise<string[]> {
    const context = await browser.newContext();
    const officer = await context.newPage();
    try {
      await signInAs(officer, email, password);
      await selectOrganisation(officer, DEV_ORGANISATION_NAME);
      const response = await officer.request.get('/api/clients');
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { clients: { displayName: string }[] };
      return body.clients.map((client) => client.displayName);
    } finally {
      await context.close();
    }
  }

  await test.step('team-assigned read vs unassigned deny', async () => {
    const assigned = await clientNames(
      DEV_TEAM_FIXTURE.assignedEmail,
      DEV_TEAM_FIXTURE.assignedPassword,
    );
    expect(assigned).toContain(DEV_TEAM_FIXTURE.clientName);

    const unassigned = await clientNames(
      DEV_TEAM_FIXTURE.unassignedEmail,
      DEV_TEAM_FIXTURE.unassignedPassword,
    );
    expect(unassigned).not.toContain(DEV_TEAM_FIXTURE.clientName);
  });
});

test('teams: group list stays inside the tenant', async ({ page, browser }) => {
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);
  const stamp = Date.now().toString(36);

  await test.step('group list stays inside the tenant', async () => {
    const created = await page.request.post('/api/groups', {
      data: { slug: `e2e-group-${stamp}`, name: `E2E group ${stamp}` },
    });
    expect(created.status()).toBe(201);
    const groupId = ((await created.json()) as { group: { id: string } }).group.id;

    const own = await page.request.get('/api/groups');
    expect(own.status()).toBe(200);
    const ownBody = (await own.json()) as { groups: { id: string }[] };
    expect(ownBody.groups.some((group) => group.id === groupId)).toBe(true);

    const councilB = await browser.newContext();
    const councilBPage = await councilB.newPage();
    try {
      await signInAs(councilBPage, DEV_TENANT_B.adminEmail, DEV_TENANT_B.adminPassword);
      await selectOrganisation(councilBPage, DEV_TENANT_B.legalName);
      const foreign = await councilBPage.request.get('/api/groups');
      expect(foreign.status()).toBe(200);
      const foreignBody = (await foreign.json()) as { groups: { id: string }[] };
      expect(foreignBody.groups.some((group) => group.id === groupId)).toBe(false);
    } finally {
      await councilB.close();
    }
  });

  await page.goto('/settings/teams');
  await expect(page.getByRole('heading', { name: 'Teams and groups' })).toBeVisible();
  await finishPage(page, pageErrors);
});

test('teams: staff can create a team and register a client', async ({ page }) => {
  const pageErrors = watchForPageErrors(page);
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
  expect(clientResponse.status()).toBe(201);

  const list = await page.request.get('/api/clients');
  expect(list.status()).toBe(200);
  const body = (await list.json()) as { clients: { displayName: string }[] };
  expect(
    body.clients.some((client) => client.displayName === `E2E client ${stamp}`),
  ).toBe(true);

  await page.goto('/clients');
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
  await finishPage(page, pageErrors);
});

test('teams: invitation email-mismatch deny', async ({ page, browser }) => {
  const pageErrors = watchForPageErrors(page);
  await test.step('invitation email-mismatch deny', async () => {
    await signInAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await selectOrganisation(page, DEV_ORGANISATION_NAME);
    const mismatchEmail = `mismatch-${Date.now().toString(36)}@example.test`;
    await page.goto('/settings/people');
    await page.getByLabel('Email address').fill(mismatchEmail);
    await page.getByLabel('Initial role').selectOption({ label: 'Intake Officer' });
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText('Invitation created.')).toBeVisible();
    const invitationUrl = await page.getByLabel('Latest invitation link').inputValue();

    const councilB = await browser.newContext();
    const councilBPage = await councilB.newPage();
    try {
      await signInAs(councilBPage, DEV_TENANT_B.adminEmail, DEV_TENANT_B.adminPassword);
      await selectOrganisation(councilBPage, DEV_TENANT_B.legalName);
      await councilBPage.goto(invitationUrl);
      const accept = councilBPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/api/membership-invitations/accept'),
      );
      await councilBPage
        .getByRole('button', { name: `Join ${DEV_ORGANISATION_NAME}` })
        .click();
      expect((await accept).status()).toBe(403);
      await expect(
        councilBPage
          .getByRole('alert')
          .filter({ hasText: 'This invitation could not be accepted.' }),
      ).toBeVisible();
    } finally {
      await councilB.close();
    }
  });

  await finishPage(page, pageErrors);
});

test('teams: invitation accept requires a session', async ({ page, request }) => {
  const pageErrors = watchForPageErrors(page);
  const response = await request.post('/api/membership-invitations/accept', {
    data: { token: 'not-a-real-membership-invitation-token' },
  });
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ error: 'Unauthorized' });
  await page.goto('/sign-in');
  await finishPage(page, pageErrors);
});

/**
 * Staff MFA policy gates the staff shell. Give invited case officers a
 * fixture passkey, like the dev seed and the SSO journey, so the spec reaches
 * the team-scoping decision rather than the enrolment redirect.
 */
async function enrolFixturePasskeys(emails: readonly string[]): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for staff MFA fixtures.');
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const email of emails) {
      const [user] = await sql<{ id: string }[]>`
        select id from users where email = ${email}`;
      if (!user) throw new Error(`No account was created for ${email}.`);
      await sql`
        insert into passkeys (id, user_id, name, credential_id, public_key, counter)
        select ${randomUUID()}, ${user.id}, 'Team E2E fixture passkey',
               ${`team-e2e-${user.id}`}, 'team-e2e-fixture-passkey', 0
        where not exists (select 1 from passkeys where user_id = ${user.id})`;
    }
  } finally {
    await sql.end();
  }
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
    await signInAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
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
    await enrolFixturePasskeys([memberEmail, outsiderEmail]);

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
      await signInAs(userPage, email, password);
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
