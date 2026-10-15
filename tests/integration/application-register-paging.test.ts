import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Keyset paging over the application register. Rows that share a millisecond
 * (but not a microsecond) must each appear exactly once, in order, and only
 * for the caller's organisation. Skipped unless RUN_INTEGRATION=true.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, applications, organisationKeys] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/applications'),
    import('@/domains/organisation-keys'),
  ]);
  return { ...client, schema, tenancy, applications, organisationKeys };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

integration('application register keyset paging', () => {
  let runtime: Runtime;

  async function tenant(label: string) {
    const organisationId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await runtime.db.insert(runtime.schema.users).values({
      id: userId,
      name: `Paging ${label}`,
      email: `paging-${label}-${suffix}@example.test`,
      emailVerified: true,
    });
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: `Paging ${label}`,
      slug: `paging-${label}-${suffix}`,
      status: 'active',
    });
    await runtime.db.insert(runtime.schema.memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: 'active',
    });
    await runtime.organisationKeys.ensureOrganisationKey(organisationId);
    return {
      userId,
      organisationId,
      membershipId,
      permissions: new Set(['application:create', 'application:read-any']),
      roles: ['integration-tester'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
  }

  beforeAll(async () => {
    runtime = await loadRuntime();
  });

  it('walks every row once across a shared millisecond, scoped to the tenant', async () => {
    const mine = await tenant('mine');
    const theirs = await tenant('theirs');

    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const row = await runtime.tenancy.runWithTenantContext(mine, () =>
        runtime.applications.createApplication({
          applicantName: `Paging Person ${index}`,
        }),
      );
      created.push(row.id);
    }
    const other = await runtime.tenancy.runWithTenantContext(theirs, () =>
      runtime.applications.createApplication({ applicantName: 'Other Tenant Person' }),
    );

    // Same millisecond, different microseconds: a millisecond cursor would
    // skip or repeat rows here.
    for (const [index, id] of created.entries()) {
      const at = `2026-01-01T00:00:00.123${String(100 + index * 10).padStart(3, '0')}Z`;
      await runtime.sqlClient`
        update applications set created_at = ${at}::timestamptz where id = ${id}
      `;
    }
    await runtime.sqlClient`
      update applications set created_at = '2026-01-01T00:00:00.123120Z'::timestamptz
      where id = ${other.id}
    `;

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await runtime.tenancy.runWithTenantContext(mine, () =>
        runtime.applications.listApplications({
          limit: 2,
          ...(cursor ? { cursor } : {}),
        }),
      );
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toEqual([...created].reverse());
    expect(seen).not.toContain(other.id);
  });
});
