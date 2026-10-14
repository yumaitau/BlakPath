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
    const [{ db, sqlClient }, schema, audit, tenancy, permissions, { uuidv7 }] =
      await Promise.all([
        import('@/db/client'),
        import('@/db/schema'),
        import('@/domains/audit'),
        import('@/lib/tenancy/context'),
        import('@/lib/permissions/errors'),
        import('uuidv7'),
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
      actingRole: 'case-officer',
      sessionId: null,
      action: 'application.viewed',
      resourceType: 'application',
      resourceId: caseId,
      result: 'success',
      reason: '=1+1',
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
      reason: 'not assigned',
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
      reason: '=OTHER_TENANT',
    });
    await audit.recordPlatformAudit({
      actorUserId: null,
      actingRole: 'platform-operator',
      sessionId: null,
      action: 'key.viewed',
      resourceType: 'organisation_key',
      resourceId: orgA,
      result: 'success',
      reason: 'PLATFORM_CHAIN',
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
    expect(JSON.stringify(all)).not.toContain('OTHER_TENANT');
    expect(JSON.stringify(all)).not.toContain('PLATFORM_CHAIN');
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
    expect(byUser.items[0]?.reason).toBe('=1+1');

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
    expect(exported.csv).not.toContain('OTHER_TENANT');
    expect(exported.csv).not.toContain('PLATFORM_CHAIN');
    expect(exported.csv).not.toMatch(/(^|,)=1\+1/);
    expect(exported.truncated).toBe(false);
  });
});
