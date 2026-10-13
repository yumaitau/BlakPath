import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Team-scoped reads need Postgres: a case officer on the client's team can
 * read the matter, and the same officer cannot once removed. Skipped unless
 * RUN_INTEGRATION=true.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, applications, teams] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/applications'),
    import('@/domains/teams'),
  ]);
  return { ...client, schema, tenancy, applications, teams };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

integration('team scoping', () => {
  let runtime: Runtime;
  let organisationId: string;
  let admin: TenantContext;
  let member: TenantContext;
  let outsider: TenantContext;
  let memberUserId: string;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationId = randomUUID();
    const adminUserId = randomUUID();
    memberUserId = randomUUID();
    const outsiderUserId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const adminMembershipId = randomUUID();
    const memberMembershipId = randomUUID();
    const outsiderMembershipId = randomUUID();

    await runtime.db.insert(runtime.schema.users).values([
      {
        id: adminUserId,
        name: 'Team Scope Admin',
        email: `team-admin-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        id: memberUserId,
        name: 'Team Scope Member',
        email: `team-member-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        id: outsiderUserId,
        name: 'Team Scope Outsider',
        email: `team-outsider-${suffix}@example.test`,
        emailVerified: true,
      },
    ]);
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Team Scope Council',
      slug: `team-scope-${suffix}`,
      status: 'active',
    });
    await runtime.db.insert(runtime.schema.memberships).values([
      {
        id: adminMembershipId,
        organisationId,
        userId: adminUserId,
        status: 'active',
      },
      {
        id: memberMembershipId,
        organisationId,
        userId: memberUserId,
        status: 'active',
      },
      {
        id: outsiderMembershipId,
        organisationId,
        userId: outsiderUserId,
        status: 'active',
      },
    ]);

    const base = {
      organisationId,
      roles: ['integration-tester'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    admin = {
      ...base,
      userId: adminUserId,
      membershipId: adminMembershipId,
      permissions: new Set([
        'team:create',
        'team:manage',
        'group:create',
        'group:manage',
        'client:create',
        'client:assign-team',
        'client:read-any',
        'application:create',
        'application:assign',
        'application:read-any',
        'application:update-intake',
      ]),
    };
    member = {
      ...base,
      userId: memberUserId,
      membershipId: memberMembershipId,
      sessionId: randomUUID(),
      permissions: new Set(['application:read-assigned']),
    };
    outsider = {
      ...base,
      userId: outsiderUserId,
      membershipId: outsiderMembershipId,
      sessionId: randomUUID(),
      permissions: new Set(['application:read-assigned']),
    };
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  it('lets a team member read a linked case and denies everyone else', async () => {
    const { tenancy, applications, teams, schema, db } = runtime;
    const run = <T>(ctx: TenantContext, fn: () => Promise<T>) =>
      tenancy.runWithTenantContext(ctx, fn);

    const team = await run(admin, () =>
      teams.createTeam({ slug: `scope-${randomUUID().slice(0, 8)}`, name: 'Scope team' }),
    );
    await run(admin, () =>
      teams.addTeamMember({ teamId: team.id, userId: memberUserId, role: 'member' }),
    );
    const client = await run(admin, () =>
      teams.createClient({ displayName: 'Scoped client', assignedTeamId: team.id }),
    );
    const application = await run(admin, () =>
      applications.createApplication({
        applicantName: 'Scoped matter',
        clientId: client.id,
        priority: 'normal',
      }),
    );

    const visible = await run(member, () => applications.getApplication(application.id));
    expect(visible.application.id).toBe(application.id);
    const memberList = await run(member, () =>
      applications.listApplications({ limit: 100 }),
    );
    expect(memberList.items.some((item) => item.id === application.id)).toBe(true);

    await expect(
      run(outsider, () => applications.getApplication(application.id)),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const outsiderList = await run(outsider, () =>
      applications.listApplications({ limit: 100 }),
    );
    expect(outsiderList.items.some((item) => item.id === application.id)).toBe(false);

    await run(admin, () =>
      teams.removeTeamMember({ teamId: team.id, userId: memberUserId }),
    );
    await expect(
      run(member, () => applications.getApplication(application.id)),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    const assignment = await run(admin, () =>
      applications.assignApplication(application.id, { assigneeUserId: memberUserId }),
    );
    const auditRows = await db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.resourceId, assignment.id));
    expect(auditRows.some((row) => row.action === 'assignment.assigned')).toBe(true);

    const group = await run(admin, () =>
      teams.createGroup({
        slug: `scope-group-${randomUUID().slice(0, 8)}`,
        name: 'Scope group',
      }),
    );
    await run(admin, () =>
      teams.addGroupMember({ groupId: group.id, userId: memberUserId }),
    );
    await run(admin, () =>
      teams.removeGroupMember({ groupId: group.id, userId: memberUserId }),
    );
  });
});
