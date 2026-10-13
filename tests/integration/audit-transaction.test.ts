import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditResult } from '@/domains/audit';

/**
 * Proves recordAudit joins the caller transaction.
 *
 * Skipped unless RUN_INTEGRATION=true. beforeAll pins DATABASE_POOL_MAX to 5
 * before the client is created. Fifty in-flight assignments exceed that pool.
 * Nested audit transactions deadlock once concurrency reaches the pool max;
 * one shared transaction does not.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

integration('audit joins the business transaction', () => {
  let closeDatabase: (() => Promise<unknown>) | undefined;

  beforeAll(() => {
    process.env.DATABASE_POOL_MAX = '5';
  });
  const organisationIds: string[] = [];
  const userIds: string[] = [];

  afterAll(async () => {
    if (!closeDatabase) return;
    const [{ db }, schema, drizzle] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('drizzle-orm'),
    ]);
    if (organisationIds.length > 0) {
      await db
        .delete(schema.auditEvents)
        .where(drizzle.inArray(schema.auditEvents.organisationId, organisationIds));
      await db
        .delete(schema.auditEvents)
        .where(drizzle.inArray(schema.auditEvents.resourceId, organisationIds));
      await db
        .delete(schema.organisations)
        .where(drizzle.inArray(schema.organisations.id, organisationIds));
    }
    if (userIds.length > 0) {
      await db.delete(schema.users).where(drizzle.inArray(schema.users.id, userIds));
    }
    await closeDatabase();
  });

  it('rolls the business row back when the audit insert fails', async () => {
    const [{ db, sqlClient }, schema, audit, { uuidv7 }, drizzle] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/domains/audit'),
      import('uuidv7'),
      import('drizzle-orm'),
    ]);
    closeDatabase = () => sqlClient.end({ timeout: 5 });
    const orgId = uuidv7();
    organisationIds.push(orgId);

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(schema.organisations).values({
          id: orgId,
          legalName: 'Audit Rollback Organisation',
          slug: `audit-rollback-${orgId}`,
          status: 'active',
        });
        await audit.recordAudit(
          {
            organisationId: orgId,
            actorUserId: null,
            actingRole: 'system',
            sessionId: null,
            action: 'record.viewed',
            resourceType: 'application',
            resourceId: orgId,
            result: 'not-a-result' as AuditResult,
            correlationId: `audit-rollback-${orgId}`,
          },
          tx,
        );
      }),
    ).rejects.toThrow();

    const orgs = await db
      .select({ id: schema.organisations.id })
      .from(schema.organisations)
      .where(drizzle.eq(schema.organisations.id, orgId));
    expect(orgs).toHaveLength(0);
  });

  it('drops the audit row when the caller transaction rolls back', async () => {
    const [{ db, sqlClient }, schema, audit, { uuidv7 }, drizzle] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/domains/audit'),
      import('uuidv7'),
      import('drizzle-orm'),
    ]);
    closeDatabase = () => sqlClient.end({ timeout: 5 });
    const orgId = uuidv7();
    organisationIds.push(orgId);

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(schema.organisations).values({
          id: orgId,
          legalName: 'Audit Join Organisation',
          slug: `audit-join-${orgId}`,
          status: 'active',
        });
        await audit.recordAudit(
          {
            organisationId: null,
            actorUserId: null,
            actingRole: 'system',
            sessionId: null,
            action: 'record.viewed',
            resourceType: 'application',
            resourceId: orgId,
            result: 'success',
            correlationId: `audit-join-${orgId}`,
          },
          tx,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const orgs = await db
      .select({ id: schema.organisations.id })
      .from(schema.organisations)
      .where(drizzle.eq(schema.organisations.id, orgId));
    const events = await db
      .select({ id: schema.auditEvents.id })
      .from(schema.auditEvents)
      .where(drizzle.eq(schema.auditEvents.resourceId, orgId));
    expect(orgs).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('finishes 50 concurrent assignments without hanging', async () => {
    const [{ db, sqlClient }, schema, applications, tenancy, { uuidv7 }, drizzle] =
      await Promise.all([
        import('@/db/client'),
        import('@/db/schema'),
        import('@/domains/applications'),
        import('@/lib/tenancy/context'),
        import('uuidv7'),
        import('drizzle-orm'),
      ]);
    closeDatabase = () => sqlClient.end({ timeout: 5 });
    const { env } = await import('@/lib/env');
    expect(env.DATABASE_POOL_MAX).toBe(5);

    const orgId = uuidv7();
    const actorId = uuidv7();
    const assigneeId = uuidv7();
    const membershipId = uuidv7();
    const applicationId = uuidv7();
    organisationIds.push(orgId);
    userIds.push(actorId, assigneeId);

    await db.insert(schema.users).values([
      {
        id: actorId,
        name: 'Assignment Actor',
        email: `actor-${orgId}@example.test`,
        emailVerified: true,
      },
      {
        id: assigneeId,
        name: 'Assignment Assignee',
        email: `assignee-${orgId}@example.test`,
        emailVerified: true,
      },
    ]);
    await db.insert(schema.organisations).values({
      id: orgId,
      legalName: 'Assignment Pool Organisation',
      slug: `audit-assign-${orgId}`,
      status: 'active',
    });
    await db.insert(schema.memberships).values({
      id: membershipId,
      organisationId: orgId,
      userId: actorId,
      status: 'active',
    });
    await db.insert(schema.applications).values({
      id: applicationId,
      organisationId: orgId,
      reference: `APP-${orgId.slice(0, 8)}`,
      applicantName: 'Pool Applicant',
      createdByUserId: actorId,
    });

    const assignments = await tenancy.runWithTenantContext(
      {
        userId: actorId,
        organisationId: orgId,
        membershipId,
        permissions: new Set(['application:assign']),
        roles: ['integration-tester'],
        sessionId: uuidv7(),
        correlationId: `audit-assign-${orgId}`,
        requestId: uuidv7(),
      },
      () =>
        Promise.all(
          Array.from({ length: 50 }, () =>
            applications.assignApplication(applicationId, { assigneeUserId: assigneeId }),
          ),
        ),
    );

    expect(assignments).toHaveLength(50);
    const rows = await db
      .select({ id: schema.applicationAssignments.id })
      .from(schema.applicationAssignments)
      .where(drizzle.eq(schema.applicationAssignments.applicationId, applicationId));
    expect(rows.length).toBeGreaterThanOrEqual(50);
  }, 30_000);
});
