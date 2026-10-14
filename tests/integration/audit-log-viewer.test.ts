import { afterAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@/lib/tenancy/context';

const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

function context(
  organisationId: string,
  userId: string,
  permissions: readonly string[],
): TenantContext {
  return {
    organisationId,
    userId,
    membershipId: userId,
    permissions: new Set(permissions),
    roles: ['organisation-admin'],
    sessionId: userId,
    correlationId: 'audit-log-viewer',
    requestId: 'audit-log-viewer',
  };
}

integration('audit log viewer', () => {
  let closeDatabase: (() => Promise<unknown>) | undefined;

  // audit_events is append-only (DELETE raises 42501), so the per-run
  // organisations and their trail stay behind; ids are fresh uuidv7s.
  afterAll(async () => {
    if (closeDatabase) await closeDatabase();
  });

  it('scopes reads to the tenant, audits the view, and exports formula-safe csv', async () => {
    const [{ db, sqlClient }, schema, audit, tenancy, permissions, { uuidv7 }, drizzle] =
      await Promise.all([
        import('@/db/client'),
        import('@/db/schema'),
        import('@/domains/audit'),
        import('@/lib/tenancy/context'),
        import('@/lib/permissions/errors'),
        import('uuidv7'),
        import('drizzle-orm'),
      ]);
    closeDatabase = () => sqlClient.end({ timeout: 5 });

    const orgA = uuidv7();
    const orgB = uuidv7();
    const actorId = uuidv7();
    const viewerId = uuidv7();
    const caseId = uuidv7();
    const otherCaseId = uuidv7();
    const evidenceId = uuidv7();

    await db.insert(schema.organisations).values([
      {
        id: orgA,
        legalName: 'Audit Viewer A',
        slug: `audit-viewer-a-${orgA}`,
        status: 'active',
      },
      {
        id: orgB,
        legalName: 'Audit Viewer B',
        slug: `audit-viewer-b-${orgB}`,
        status: 'active',
      },
    ]);

    await audit.recordAudit({
      organisationId: orgA,
      actorUserId: actorId,
      // Formula probe: actingRole is free-form, reasons are coded only.
      actingRole: '=1+1',
      sessionId: null,
      action: 'application.viewed',
      resourceType: 'application',
      resourceId: caseId,
      result: 'success',
    });
    await audit.recordAudit({
      organisationId: orgA,
      actorUserId: null,
      actingRole: 'case-officer',
      sessionId: null,
      action: 'application.updated',
      resourceType: 'application',
      resourceId: otherCaseId,
      result: 'denied',
      reason: 'application.not_assigned',
    });
    await audit.recordAudit({
      organisationId: orgA,
      actorUserId: null,
      actingRole: 'platform-operator',
      sessionId: null,
      action: 'break_glass.activated',
      resourceType: 'break_glass_request',
      resourceId: uuidv7(),
      result: 'success',
    });
    await audit.recordAudit({
      organisationId: orgA,
      actorUserId: null,
      actingRole: 'case-officer',
      sessionId: null,
      action: 'evidence.viewed',
      resourceType: 'evidence',
      resourceId: evidenceId,
      result: 'success',
      after: { data: { applicationId: caseId }, allow: ['applicationId'] },
    });
    await audit.recordAudit({
      organisationId: orgB,
      actorUserId: null,
      actingRole: 'case-officer',
      sessionId: null,
      action: 'application.viewed',
      resourceType: 'application',
      resourceId: uuidv7(),
      result: 'success',
      reason: 'test.other_tenant',
    });
    await audit.recordPlatformAudit({
      actorUserId: null,
      actingRole: 'platform-operator',
      sessionId: null,
      action: 'key.viewed',
      resourceType: 'organisation_key',
      resourceId: orgA,
      result: 'success',
      reason: 'test.platform_chain',
    });

    const viewer = context(orgA, viewerId, ['audit:view']);

    const denied = await tenancy
      .runWithTenantContext(context(orgA, viewerId, []), () => audit.listAuditLog({}))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(denied).toBeInstanceOf(permissions.AuthorizationError);

    const all = await tenancy.runWithTenantContext(viewer, () => audit.listAuditLog({}));
    expect(JSON.stringify(all)).not.toContain('test.other_tenant');
    expect(JSON.stringify(all)).not.toContain('test.platform_chain');
    expect(all.total).toBe(5);
    expect(all.items.some((item) => item.action === 'audit.viewed')).toBe(true);

    const again = await tenancy.runWithTenantContext(viewer, () =>
      audit.listAuditLog({}),
    );
    expect(again.total).toBe(all.total + 1);

    const byCase = await tenancy.runWithTenantContext(viewer, () =>
      audit.listAuditLog({ case: caseId }),
    );
    expect(byCase.total).toBe(2);
    expect(byCase.items.map((item) => item.resourceId).sort()).toEqual(
      [caseId, evidenceId].sort(),
    );

    const byUser = await tenancy.runWithTenantContext(viewer, () =>
      audit.listAuditLog({ user: actorId }),
    );
    expect(byUser.total).toBe(1);
    expect(byUser.items[0]?.actingRole).toBe('=1+1');

    const denials = await tenancy.runWithTenantContext(viewer, () =>
      audit.listAuditLog({ denials: '1' }),
    );
    expect(denials.items.every((item) => item.result === 'denied')).toBe(true);
    expect(denials.total).toBe(2);

    const breakGlass = await tenancy.runWithTenantContext(viewer, () =>
      audit.listAuditLog({ breakGlass: '1' }),
    );
    expect(breakGlass.total).toBe(1);
    expect(breakGlass.items[0]?.action).toBe('break_glass.activated');

    const exported = await tenancy.runWithTenantContext(viewer, () =>
      audit.exportAuditLog({ case: caseId }),
    );
    expect(exported.csv).toContain("'=1+1");
    expect(exported.csv).not.toContain('test.other_tenant');
    expect(exported.csv).not.toContain('test.platform_chain');
    expect(exported.csv).not.toMatch(/(^|,)=1\+1/);
    expect(exported.truncated).toBe(false);

    // The monthly review stores structured fields and a coded reason only.
    const rejected = await tenancy
      .runWithTenantContext(viewer, () =>
        audit.recordMonthlyAuditReview({
          period: '2026-10',
          outcome: 'no_findings',
          notes: 'FREE_TEXT_NOTE',
        }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejected).not.toBeNull();
    await tenancy.runWithTenantContext(viewer, () =>
      audit.recordMonthlyAuditReview({
        period: '2026-10',
        outcome: 'findings_raised',
        findingsCount: 2,
      }),
    );
    const [review] = await db
      .select({
        reason: schema.auditEvents.reason,
        afterMeta: schema.auditEvents.afterMeta,
        actorUserId: schema.auditEvents.actorUserId,
      })
      .from(schema.auditEvents)
      .where(
        drizzle.and(
          drizzle.eq(schema.auditEvents.organisationId, orgA),
          drizzle.eq(schema.auditEvents.action, 'audit.monthly_review_recorded'),
          drizzle.eq(schema.auditEvents.result, 'success'),
        ),
      );
    expect(review?.reason).toBe('audit.monthly_review');
    expect(review?.actorUserId).toBe(viewerId);
    expect(review?.afterMeta).toEqual({
      findingsCount: 2,
      outcome: 'findings_raised',
      period: '2026-10',
    });

    // Every reason this flow wrote to the tenant chain is a coded value.
    const chain = await db
      .select({
        reason: schema.auditEvents.reason,
        afterMeta: schema.auditEvents.afterMeta,
      })
      .from(schema.auditEvents)
      .where(drizzle.eq(schema.auditEvents.organisationId, orgA));
    expect(JSON.stringify(chain)).not.toContain('FREE_TEXT_NOTE');
    for (const row of chain) {
      if (row.reason !== null) {
        expect(row.reason).toMatch(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/);
      }
    }
  });
});
