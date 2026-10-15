import type { Page } from '@playwright/test';
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
    await expect(foreign.json()).resolves.toEqual({ error: 'Forbidden' });

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
      await expect(councilBPage.getByRole('alert')).toContainText(
        'This invitation could not be accepted.',
      );
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
  await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  await page.goto('/sign-in');
  await finishPage(page, pageErrors);
});
