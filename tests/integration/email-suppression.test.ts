import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Suppressed addresses are surfaced to organisation administrators, who can
 * clear one for their OWN tenant's members only. Clearing is audited.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

integration('email suppression handling for staff', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await cleanup?.();
  });

  it('lists, guards and audits clearing a member suppression', async () => {
    const [{ db, sqlClient }, schema, tenancy, memberships, email, drizzle] =
      await Promise.all([
        import('@/db/client'),
        import('@/db/schema'),
        import('@/lib/tenancy/context'),
        import('@/domains/memberships'),
        import('@/domains/email'),
        import('drizzle-orm'),
      ]);
    const orgA = randomUUID();
    const orgB = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    const memberEmail = `bounced-${memberId}@example.test`;
    const adminMembershipA = randomUUID();
    const adminMembershipB = randomUUID();
    const memberMembership = randomUUID();
    cleanup = async () => {
      await db
        .delete(schema.organisations)
        .where(drizzle.inArray(schema.organisations.id, [orgA, orgB]));
      await db
        .delete(schema.users)
        .where(drizzle.inArray(schema.users.id, [adminId, memberId]));
      await db
        .delete(schema.emailSuppressions)
        .where(
          drizzle.eq(
            schema.emailSuppressions.addressHash,
            email.hashAddress(memberEmail),
          ),
        );
      await sqlClient.end({ timeout: 5 });
    };

    await db.insert(schema.users).values([
      { id: adminId, name: 'Admin', email: `admin-${adminId}@example.test` },
      { id: memberId, name: 'Member', email: memberEmail },
    ]);
    await db.insert(schema.organisations).values([
      { id: orgA, legalName: 'Suppression A', slug: `sup-a-${orgA}`, status: 'active' },
      { id: orgB, legalName: 'Suppression B', slug: `sup-b-${orgB}`, status: 'active' },
    ]);
    await db.insert(schema.memberships).values([
      { id: adminMembershipA, organisationId: orgA, userId: adminId, status: 'active' },
      { id: adminMembershipB, organisationId: orgB, userId: adminId, status: 'active' },
      { id: memberMembership, organisationId: orgA, userId: memberId, status: 'active' },
    ]);
    const base = {
      userId: adminId,
      permissions: new Set(['membership:manage']),
      roles: ['organisation-admin'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    const contextA = { ...base, organisationId: orgA, membershipId: adminMembershipA };
    const contextB = { ...base, organisationId: orgB, membershipId: adminMembershipB };

    await email.recordSuppression({ address: memberEmail.toUpperCase(), kind: 'bounce' });
    expect(await email.isSuppressed(memberEmail)).toBe(true);

    const listed = await tenancy.runWithTenantContext(contextA, () =>
      memberships.listManagedMembers(),
    );
    expect(listed.find((m) => m.id === memberMembership)?.emailSuppression).toBe(
      'bounce',
    );
    expect(listed.find((m) => m.id === adminMembershipA)?.emailSuppression).toBeNull();

    // Another tenant's administrator cannot clear it.
    await expect(
      tenancy.runWithTenantContext(contextB, () =>
        memberships.clearEmailSuppression({ kind: 'membership', id: memberMembership }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await email.isSuppressed(memberEmail)).toBe(true);

    await expect(
      tenancy.runWithTenantContext(contextA, () =>
        memberships.clearEmailSuppression({ kind: 'membership', id: memberMembership }),
      ),
    ).resolves.toBe(true);
    expect(await email.isSuppressed(memberEmail)).toBe(false);

    const events = await db
      .select({
        result: schema.auditEvents.result,
        actorUserId: schema.auditEvents.actorUserId,
      })
      .from(schema.auditEvents)
      .where(
        drizzle.and(
          drizzle.eq(schema.auditEvents.organisationId, orgA),
          drizzle.eq(schema.auditEvents.action, 'email.suppression_cleared'),
        ),
      );
    expect(events).toEqual([{ result: 'success', actorUserId: adminId }]);

    // Nothing left to clear.
    await expect(
      tenancy.runWithTenantContext(contextA, () =>
        memberships.clearEmailSuppression({ kind: 'membership', id: memberMembership }),
      ),
    ).resolves.toBe(false);
  }, 30_000);
});
