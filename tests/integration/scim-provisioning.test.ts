import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Directory provisioning against a migrated database.
 * Skipped unless RUN_INTEGRATION=true.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, scim, route] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/scim'),
    import('@/app/api/scim/v2/[orgId]/Users/route'),
  ]);
  return { ...client, schema, tenancy, scim, route };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

function callUsers(
  runtime: Runtime,
  method: 'POST' | 'PATCH' | 'DELETE',
  orgId: string,
  token: string,
  body?: unknown,
  userName?: string,
): Promise<Response> {
  const query = userName ? `?userName=${encodeURIComponent(userName)}` : '';
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const request = new Request(
    `http://localhost/api/scim/v2/${orgId}/Users${query}`,
    init,
  );
  const params = { params: Promise.resolve({ orgId }) };
  if (method === 'POST') return runtime.route.POST(request as never, params);
  if (method === 'PATCH') return runtime.route.PATCH(request as never, params);
  return runtime.route.DELETE(request as never, params);
}

integration('scim directory credentials', () => {
  let runtime: Runtime;
  let organisationA: string;
  let organisationB: string;
  let contextA: TenantContext;
  let tokenA: string;
  let tokenAdmin: string;
  let credentialAId: string;
  let adminRoleId: string;
  let keeperMembershipId: string;
  const suffix = randomUUID().slice(0, 8);
  const personEmail = `scim-person-${suffix}@example.test`;
  const deletedEmail = `scim-deleted-${suffix}@example.test`;
  const adminEmail = `scim-admin-${suffix}@example.test`;
  const rotatedEmail = `scim-rotated-${suffix}@example.test`;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationA = randomUUID();
    organisationB = randomUUID();
    const userId = randomUUID();
    const keeperId = randomUUID();
    const membershipA = randomUUID();
    keeperMembershipId = randomUUID();
    adminRoleId = randomUUID();
    const caseRoleId = randomUUID();
    const intakeRoleId = randomUUID();

    await runtime.db.insert(runtime.schema.users).values([
      {
        id: userId,
        name: 'SCIM Integration Admin',
        email: `scim-admin-actor-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        id: keeperId,
        name: 'SCIM Keeper Admin',
        email: `scim-keeper-${suffix}@example.test`,
        emailVerified: true,
      },
    ]);
    await runtime.db.insert(runtime.schema.organisations).values([
      {
        id: organisationA,
        legalName: 'SCIM Organisation A',
        slug: `scim-a-${suffix}`,
        status: 'active',
      },
      {
        id: organisationB,
        legalName: 'SCIM Organisation B',
        slug: `scim-b-${suffix}`,
        status: 'active',
      },
    ]);
    await runtime.db.insert(runtime.schema.memberships).values([
      {
        id: membershipA,
        organisationId: organisationA,
        userId,
        status: 'active',
      },
      {
        id: keeperMembershipId,
        organisationId: organisationA,
        userId: keeperId,
        status: 'active',
      },
    ]);
    await runtime.db.insert(runtime.schema.roles).values([
      {
        id: caseRoleId,
        organisationId: organisationA,
        slug: 'case-officer',
        name: 'Case Officer',
        isSystem: true,
      },
      {
        id: intakeRoleId,
        organisationId: organisationA,
        slug: 'intake-officer',
        name: 'Intake Officer',
        isSystem: true,
      },
      {
        id: adminRoleId,
        organisationId: organisationA,
        slug: 'organisation-admin',
        name: 'Organisation Admin',
        isSystem: true,
      },
    ]);
    await runtime.db.insert(runtime.schema.membershipRoles).values({
      id: randomUUID(),
      membershipId: keeperMembershipId,
      roleId: adminRoleId,
    });

    contextA = {
      userId,
      organisationId: organisationA,
      membershipId: membershipA,
      permissions: new Set(['tenant:configure']),
      roles: ['organisation-admin'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };

    const created = await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.scim.createScimCredential({ name: 'Council IdP' }),
    );
    tokenA = created.token;
    credentialAId = created.credential.id;
    const adminCredential = await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.scim.createScimCredential({
        name: 'Council IdP admin',
        allowOrganisationAdmin: true,
      }),
    );
    tokenAdmin = adminCredential.token;

    const [stored] = await runtime.db
      .select({ tokenHash: runtime.schema.scimCredentials.tokenHash })
      .from(runtime.schema.scimCredentials)
      .where(eq(runtime.schema.scimCredentials.id, credentialAId))
      .limit(1);
    expect(stored?.tokenHash).toBe(runtime.scim.hashScimToken(tokenA));
    expect(stored?.tokenHash).not.toBe(tokenA);
  }, 30_000);

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  async function roleSlugs(membershipId: string): Promise<string[]> {
    const rows = await runtime.db
      .select({ slug: runtime.schema.roles.slug })
      .from(runtime.schema.membershipRoles)
      .innerJoin(
        runtime.schema.roles,
        eq(runtime.schema.membershipRoles.roleId, runtime.schema.roles.id),
      )
      .where(eq(runtime.schema.membershipRoles.membershipId, membershipId));
    return rows.map((row) => row.slug).sort();
  }

  async function membershipStatus(membershipId: string): Promise<string | undefined> {
    const [row] = await runtime.db
      .select({ status: runtime.schema.memberships.status })
      .from(runtime.schema.memberships)
      .where(eq(runtime.schema.memberships.id, membershipId))
      .limit(1);
    return row?.status;
  }

  it('rejects another organisation and an unknown bearer', async () => {
    const crossEmail = `scim-cross-${suffix}@example.test`;
    const denied = await callUsers(runtime, 'POST', organisationB, tokenA, {
      userName: crossEmail,
      active: true,
      groups: [{ display: 'case-officer' }],
    });
    expect(denied.status).toBe(403);

    const unknown = await callUsers(
      runtime,
      'POST',
      organisationA,
      `${runtime.scim.SCIM_TOKEN_PREFIX}${'a'.repeat(40)}`,
      { userName: crossEmail, active: true },
    );
    expect(unknown.status).toBe(403);

    const memberships = await runtime.db
      .select({ id: runtime.schema.memberships.id })
      .from(runtime.schema.memberships)
      .where(eq(runtime.schema.memberships.organisationId, organisationB));
    expect(memberships).toHaveLength(0);
    const users = await runtime.db
      .select({ id: runtime.schema.users.id })
      .from(runtime.schema.users)
      .where(eq(runtime.schema.users.email, crossEmail));
    expect(users).toHaveLength(0);
  });

  it('removes a role when the group is removed', async () => {
    const created = await callUsers(runtime, 'POST', organisationA, tokenA, {
      userName: personEmail,
      active: true,
      groups: [{ display: 'case-officer' }, { display: 'intake-officer' }],
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; active: boolean };
    expect(body.active).toBe(true);
    expect(await roleSlugs(body.id)).toEqual(['case-officer', 'intake-officer']);

    const updated = await callUsers(runtime, 'POST', organisationA, tokenA, {
      userName: personEmail,
      active: true,
      groups: [{ display: 'intake-officer' }],
    });
    expect(updated.status).toBe(201);
    expect(await roleSlugs(body.id)).toEqual(['intake-officer']);
  });

  it('ends sessions on suspend and refuses to reactivate a revoked membership', async () => {
    const [user] = await runtime.db
      .select({ id: runtime.schema.users.id })
      .from(runtime.schema.users)
      .where(eq(runtime.schema.users.email, personEmail))
      .limit(1);
    const userId = user?.id;
    expect(userId).toBeTruthy();
    const sessionId = randomUUID();
    await runtime.db.insert(runtime.schema.sessions).values({
      id: sessionId,
      token: `scim-session-${suffix}`,
      userId: userId as string,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const suspended = await callUsers(runtime, 'PATCH', organisationA, tokenA, {
      userName: personEmail,
      active: false,
    });
    expect(suspended.status).toBe(200);
    const sessions = await runtime.db
      .select({ id: runtime.schema.sessions.id })
      .from(runtime.schema.sessions)
      .where(eq(runtime.schema.sessions.userId, userId as string));
    expect(sessions).toHaveLength(0);

    const [membership] = await runtime.db
      .select({ id: runtime.schema.memberships.id })
      .from(runtime.schema.memberships)
      .where(eq(runtime.schema.memberships.userId, userId as string))
      .limit(1);
    const membershipId = membership?.id as string;
    expect(await membershipStatus(membershipId)).toBe('suspended');

    const reinstated = await callUsers(runtime, 'PATCH', organisationA, tokenA, {
      userName: personEmail,
      active: true,
    });
    expect(reinstated.status).toBe(200);
    expect(await membershipStatus(membershipId)).toBe('active');

    await runtime.db
      .update(runtime.schema.memberships)
      .set({ status: 'revoked' })
      .where(eq(runtime.schema.memberships.id, membershipId));
    const again = await callUsers(runtime, 'POST', organisationA, tokenA, {
      userName: personEmail,
      active: true,
      groups: [{ display: 'case-officer' }, { display: 'intake-officer' }],
    });
    expect(again.status).toBe(403);
    expect(await membershipStatus(membershipId)).toBe('revoked');
    expect(await roleSlugs(membershipId)).toEqual(['intake-officer']);
  });

  it('keeps a directory delete revoked', async () => {
    const created = await callUsers(runtime, 'POST', organisationA, tokenA, {
      userName: deletedEmail,
      active: true,
      groups: [{ display: 'case-officer' }],
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string };
    const removed = await callUsers(
      runtime,
      'DELETE',
      organisationA,
      tokenA,
      undefined,
      deletedEmail,
    );
    expect(removed.status).toBe(204);
    expect(await membershipStatus(body.id)).toBe('revoked');

    const again = await callUsers(runtime, 'POST', organisationA, tokenA, {
      userName: deletedEmail,
      active: true,
      groups: [{ display: 'case-officer' }],
    });
    expect(again.status).toBe(403);
    expect(await membershipStatus(body.id)).toBe('revoked');
  });

  it('assigns organisation-admin only when the credential opts in', async () => {
    const without = await callUsers(runtime, 'POST', organisationA, tokenA, {
      userName: adminEmail,
      active: true,
      groups: [{ display: 'organisation-admin' }, { display: 'case-officer' }],
    });
    expect(without.status).toBe(201);
    const body = (await without.json()) as { id: string };
    expect(await roleSlugs(body.id)).toEqual(['case-officer']);

    const withAdmin = await callUsers(runtime, 'POST', organisationA, tokenAdmin, {
      userName: adminEmail,
      active: true,
      groups: [{ display: 'organisation-admin' }, { display: 'case-officer' }],
    });
    expect(withAdmin.status).toBe(201);
    expect(await roleSlugs(body.id)).toEqual(['case-officer', 'organisation-admin']);

    const dropped = await callUsers(runtime, 'POST', organisationA, tokenAdmin, {
      userName: adminEmail,
      active: true,
      groups: [{ display: 'case-officer' }],
    });
    expect(dropped.status).toBe(201);
    expect(await roleSlugs(body.id)).toEqual(['case-officer']);

    await callUsers(runtime, 'POST', organisationA, tokenAdmin, {
      userName: adminEmail,
      active: true,
      groups: [{ display: 'organisation-admin' }],
    });
    await runtime.db
      .delete(runtime.schema.membershipRoles)
      .where(eq(runtime.schema.membershipRoles.membershipId, keeperMembershipId));
    const kept = await callUsers(runtime, 'POST', organisationA, tokenAdmin, {
      userName: adminEmail,
      active: true,
      groups: [],
    });
    expect(kept.status).toBe(201);
    expect(await roleSlugs(body.id)).toEqual(['organisation-admin']);
  });

  it('rotates and revokes a credential and audits both', async () => {
    const rotated = await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.scim.rotateScimCredential(credentialAId),
    );
    const stale = await callUsers(runtime, 'POST', organisationA, tokenA, {
      userName: rotatedEmail,
      active: true,
    });
    expect(stale.status).toBe(403);
    const fresh = await callUsers(runtime, 'POST', organisationA, rotated.token, {
      userName: rotatedEmail,
      active: true,
      groups: [{ display: 'intake-officer' }],
    });
    expect(fresh.status).toBe(201);

    await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.scim.revokeScimCredential(rotated.credential.id),
    );
    const afterRevoke = await callUsers(runtime, 'POST', organisationA, rotated.token, {
      userName: rotatedEmail,
      active: true,
    });
    expect(afterRevoke.status).toBe(403);

    const listed = await runtime.tenancy.runWithTenantContext(contextA, () =>
      runtime.scim.listScimCredentials(),
    );
    for (const item of listed) {
      expect(item).not.toHaveProperty('token');
      expect(item).not.toHaveProperty('tokenHash');
    }

    const events = await runtime.db
      .select({ action: runtime.schema.auditEvents.action })
      .from(runtime.schema.auditEvents)
      .where(eq(runtime.schema.auditEvents.organisationId, organisationA));
    const actions = new Set(events.map((event) => event.action));
    expect(actions.has('scim.credential_created')).toBe(true);
    expect(actions.has('scim.credential_rotated')).toBe(true);
    expect(actions.has('scim.credential_revoked')).toBe(true);
  });
});
