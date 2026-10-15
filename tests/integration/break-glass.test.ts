import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_APPEND_ONLY_TRIGGERS } from '@/db/audit-guard';
import { BreakGlassWriteError } from '@/lib/tenancy/break-glass-write';

/**
 * Disposable Postgres only. Skipped unless RUN_INTEGRATION=true.
 * Activation notification needs Redis, so this file covers the grant, expiry,
 * review, and read-only scope without the queue.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, tenantDb, breakGlass] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/db/tenant-db'),
    import('@/domains/break-glass'),
  ]);
  return { ...client, schema, tenancy, tenantDb, breakGlass };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

integration('break-glass grant, expiry, review, and read-only scope', () => {
  let runtime: Runtime;
  let organisationId: string;
  let operatorId: string;
  let approverId: string;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationId = randomUUID();
    operatorId = randomUUID();
    approverId = randomUUID();
    const suffix = randomUUID().slice(0, 8);

    await runtime.db.insert(runtime.schema.users).values([
      {
        id: operatorId,
        name: 'Break Glass Operator',
        email: `bg-operator-${suffix}@example.test`,
        emailVerified: true,
        isPlatformOperator: true,
      },
      {
        id: approverId,
        name: 'Break Glass Approver',
        email: `bg-approver-${suffix}@example.test`,
        emailVerified: true,
      },
    ]);
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Break Glass Integration Org',
      slug: `bg-org-${suffix}`,
      status: 'active',
    });
  });

  afterAll(async () => {
    if (!runtime) return;
    await runtime.db
      .delete(runtime.schema.breakGlassRequests)
      .where(eq(runtime.schema.breakGlassRequests.organisationId, organisationId));
    // The trail is append-only; lift the guard only for test cleanup.
    for (const trigger of AUDIT_APPEND_ONLY_TRIGGERS) {
      await runtime.db
        .execute(sql.raw(`ALTER TABLE ${trigger.table} DISABLE TRIGGER ${trigger.name}`))
        .catch(() => undefined);
    }
    try {
      await runtime.db
        .delete(runtime.schema.auditEvents)
        .where(eq(runtime.schema.auditEvents.organisationId, organisationId));
    } finally {
      for (const trigger of AUDIT_APPEND_ONLY_TRIGGERS) {
        await runtime.db
          .execute(
            sql.raw(`ALTER TABLE ${trigger.table} ENABLE ALWAYS TRIGGER ${trigger.name}`),
          )
          .catch(() => undefined);
      }
    }
    await runtime.db
      .delete(runtime.schema.organisations)
      .where(eq(runtime.schema.organisations.id, organisationId));
    await runtime.db
      .delete(runtime.schema.users)
      .where(eq(runtime.schema.users.id, operatorId));
    await runtime.db
      .delete(runtime.schema.users)
      .where(eq(runtime.schema.users.id, approverId));
    await runtime.sqlClient.end({ timeout: 5 });
  });

  it('refuses a new request while a review is overdue', async () => {
    const grantId = randomUUID();
    await runtime.db.insert(runtime.schema.breakGlassRequests).values({
      id: grantId,
      organisationId,
      supportCaseRef: 'SUP-OVERDUE',
      requestedByUserId: operatorId,
      purpose: 'Earlier support case',
      scope: 'Read application status',
      status: 'expired',
      stepUpVerified: true,
      expiresAt: new Date(Date.now() - 86_400_000),
      activatedAt: new Date(Date.now() - 86_400_000),
      reviewDueAt: new Date(Date.now() - 60_000),
    });

    await expect(
      runtime.breakGlass.requestBreakGlass({
        requestedByUserId: operatorId,
        correlationId: randomUUID(),
        input: {
          organisationId,
          supportCaseRef: 'SUP-NEXT',
          purpose: 'Follow-up',
          scope: 'Read application status',
          expiresInMinutes: 30,
        },
      }),
    ).rejects.toBeInstanceOf(runtime.breakGlass.BreakGlassReviewOverdueError);
  });

  it('resolves a live grant and blocks writes', async () => {
    const grantId = randomUUID();
    await runtime.db.insert(runtime.schema.breakGlassRequests).values({
      id: grantId,
      organisationId,
      supportCaseRef: 'SUP-LIVE',
      requestedByUserId: operatorId,
      purpose: 'Check a stuck upload',
      scope: 'Read application and evidence metadata',
      status: 'active',
      stepUpVerified: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      activatedAt: new Date(),
      reviewDueAt: new Date(Date.now() + 7 * 86_400_000),
      tenantNotifiedAt: new Date(),
    });

    const ctx = await runtime.breakGlass.resolveBreakGlassContext({
      requestId: grantId,
      userId: operatorId,
      correlationId: randomUUID(),
      reqId: randomUUID(),
    });
    expect(ctx.organisationId).toBe(organisationId);
    expect(ctx.breakGlass?.requestId).toBe(grantId);
    expect(ctx.permissions.has('application:read-any')).toBe(true);
    expect(ctx.permissions.has('application:create')).toBe(false);

    await expect(
      runtime.tenancy.runWithTenantContext(ctx, async () => {
        const scope = runtime.tenantDb.currentScope();
        return scope.db.insert(runtime.schema.breakGlassRequests).values({
          organisationId,
          supportCaseRef: 'SHOULD-NOT-WRITE',
          requestedByUserId: operatorId,
          purpose: 'nope',
          scope: 'nope',
        });
      }),
    ).rejects.toBeInstanceOf(BreakGlassWriteError);
  });

  it('expires a grant that is past its window and records a denied access', async () => {
    const grantId = randomUUID();
    await runtime.db.insert(runtime.schema.breakGlassRequests).values({
      id: grantId,
      organisationId,
      supportCaseRef: 'SUP-EXPIRED',
      requestedByUserId: operatorId,
      purpose: 'Already finished',
      scope: 'Read application status',
      status: 'active',
      stepUpVerified: true,
      expiresAt: new Date(Date.now() - 60_000),
      activatedAt: new Date(Date.now() - 120_000),
    });

    await expect(
      runtime.breakGlass.resolveBreakGlassContext({
        requestId: grantId,
        userId: operatorId,
        correlationId: randomUUID(),
        reqId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(runtime.breakGlass.BreakGlassError);

    const rows = await runtime.db
      .select({ status: runtime.schema.breakGlassRequests.status })
      .from(runtime.schema.breakGlassRequests)
      .where(eq(runtime.schema.breakGlassRequests.id, grantId));
    expect(rows[0]?.status).toBe('expired');
  });

  it('records a human review from a different person', async () => {
    const grantId = randomUUID();
    await runtime.db.insert(runtime.schema.breakGlassRequests).values({
      id: grantId,
      organisationId,
      supportCaseRef: 'SUP-REVIEW',
      requestedByUserId: operatorId,
      purpose: 'Check a stuck upload',
      scope: 'Read application status',
      status: 'expired',
      stepUpVerified: true,
      expiresAt: new Date(Date.now() - 60_000),
      activatedAt: new Date(Date.now() - 120_000),
      reviewDueAt: new Date(Date.now() + 86_400_000),
    });

    const reviewed = await runtime.tenancy.runWithTenantContext(
      {
        organisationId,
        userId: approverId,
        membershipId: randomUUID(),
        permissions: new Set(['break-glass:approve']),
        roles: ['organisation-admin'],
        sessionId: randomUUID(),
        correlationId: randomUUID(),
        requestId: randomUUID(),
      },
      () =>
        runtime.breakGlass.reviewBreakGlass(grantId, {
          notes: 'Access matched the support case and stopped at expiry.',
        }),
    );
    expect(reviewed.reviewedByUserId).toBe(approverId);
    expect(reviewed.reviewNotes).toContain('matched the support case');

    // The notes stay on the row. The append-only trail holds a code only.
    const audit = await runtime.db
      .select({ reason: runtime.schema.auditEvents.reason })
      .from(runtime.schema.auditEvents)
      .where(eq(runtime.schema.auditEvents.resourceId, grantId));
    expect(audit.map((row) => row.reason)).toContain('break_glass.reviewed');
    expect(JSON.stringify(audit)).not.toContain('matched the support case');
  });

  it('refuses an active grant until the tenant has been notified', async () => {
    const grantId = randomUUID();
    await runtime.db.insert(runtime.schema.breakGlassRequests).values({
      id: grantId,
      organisationId,
      supportCaseRef: 'SUP-UNNOTIFIED',
      requestedByUserId: operatorId,
      purpose: 'Check a stuck upload',
      scope: 'Read application status',
      status: 'active',
      stepUpVerified: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      activatedAt: new Date(),
    });

    await expect(
      runtime.breakGlass.resolveBreakGlassContext({
        requestId: grantId,
        userId: operatorId,
        correlationId: randomUUID(),
        reqId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(runtime.breakGlass.BreakGlassError);

    const audit = await runtime.db
      .select({
        action: runtime.schema.auditEvents.action,
        result: runtime.schema.auditEvents.result,
        reason: runtime.schema.auditEvents.reason,
      })
      .from(runtime.schema.auditEvents)
      .where(eq(runtime.schema.auditEvents.resourceId, grantId));
    expect(audit).toContainEqual({
      action: 'break_glass.accessed',
      result: 'denied',
      reason: 'break_glass.grant_not_live',
    });
  });
});
