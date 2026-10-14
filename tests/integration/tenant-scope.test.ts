import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@/lib/tenancy/context';

/**
 * Disposable migrated Postgres. Skipped unless RUN_INTEGRATION=true (CI sets it
 * after `pnpm db:migrate`).
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, calendar, certificates, tenantJob] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/calendar/service'),
    import('@/domains/certificates/service'),
    import('../../worker/tenant-job'),
  ]);
  return { ...client, schema, tenancy, calendar, certificates, tenantJob };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

function context(organisationId: string): TenantContext {
  return {
    organisationId,
    userId: randomUUID(),
    membershipId: randomUUID(),
    permissions: new Set<string>(),
    roles: ['integration-tester'],
    sessionId: randomUUID(),
    correlationId: randomUUID(),
    requestId: randomUUID(),
  };
}

integration('tenant query scope', () => {
  let runtime: Runtime;

  beforeAll(async () => {
    runtime = await loadRuntime();
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  it('returns each tenant flag when more than ten organisations hold it', async () => {
    const suffix = randomUUID().slice(0, 8);
    const orgIds = Array.from({ length: 11 }, () => randomUUID());
    const enabledFor = (index: number) => index % 2 === 0;

    await runtime.db.insert(runtime.schema.organisations).values(
      orgIds.map((id, index) => ({
        id,
        legalName: `Flag Organisation ${index}`,
        slug: `flag-org-${suffix}-${index}`,
        status: 'active' as const,
      })),
    );
    await runtime.db.insert(runtime.schema.featureFlags).values([
      ...orgIds.map((organisationId, index) => ({
        id: randomUUID(),
        organisationId,
        key: 'calendar-resource-hard-block',
        enabled: enabledFor(index),
      })),
      {
        id: randomUUID(),
        organisationId: null,
        key: 'calendar-resource-hard-block',
        enabled: false,
      },
    ]);

    for (let index = 0; index < orgIds.length; index += 1) {
      const enabled = await runtime.tenancy.runWithTenantContext(
        context(orgIds[index]!),
        () => runtime.calendar.resourceHardBlock(),
      );
      expect(enabled).toBe(enabledFor(index));
    }
  });

  it('does not return another organisation decision', async () => {
    const suffix = randomUUID().slice(0, 8);
    const userId = randomUUID();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const appA = randomUUID();
    const appB = randomUUID();
    const decisionA = randomUUID();
    const decisionB = randomUUID();

    await runtime.db.insert(runtime.schema.users).values({
      id: userId,
      name: 'Decision Scope Tester',
      email: `decision-scope-${suffix}@example.test`,
      emailVerified: true,
    });
    await runtime.db.insert(runtime.schema.organisations).values([
      {
        id: orgA,
        legalName: 'Decision Organisation A',
        slug: `decision-a-${suffix}`,
        status: 'active',
      },
      {
        id: orgB,
        legalName: 'Decision Organisation B',
        slug: `decision-b-${suffix}`,
        status: 'active',
      },
    ]);
    await runtime.db.insert(runtime.schema.applications).values([
      {
        id: appA,
        organisationId: orgA,
        reference: `APP-${suffix}-A`,
        applicantName: 'Applicant A',
      },
      {
        id: appB,
        organisationId: orgB,
        reference: `APP-${suffix}-B`,
        applicantName: 'Applicant B',
      },
    ]);
    await runtime.db.insert(runtime.schema.decisions).values([
      {
        id: decisionA,
        organisationId: orgA,
        applicationId: appA,
        proposedOutcome: 'confirmed',
        finalOutcome: 'confirmed',
        status: 'finalised',
      },
      {
        id: decisionB,
        organisationId: orgB,
        applicationId: appB,
        proposedOutcome: 'not_confirmed',
        finalOutcome: 'not_confirmed',
        status: 'finalised',
      },
    ]);

    await expect(
      runtime.certificates.findDecisionOutcome(orgA, decisionB),
    ).resolves.toBeNull();
    await expect(runtime.certificates.findDecisionOutcome(orgA, decisionA)).resolves.toBe(
      'confirmed',
    );
    await expect(runtime.certificates.findDecisionOutcome(orgB, decisionB)).resolves.toBe(
      'not_confirmed',
    );
  });

  it('drops and audits jobs for a suspended or missing organisation', async () => {
    const suffix = randomUUID().slice(0, 8);
    const suspendedId = randomUUID();
    const activeId = randomUUID();
    const missingId = randomUUID();
    const suspendedCorrelation = randomUUID();
    const missingCorrelation = randomUUID();
    const activeCorrelation = randomUUID();

    await runtime.db.insert(runtime.schema.organisations).values([
      {
        id: suspendedId,
        legalName: 'Suspended Job Organisation',
        slug: `job-suspended-${suffix}`,
        status: 'suspended',
      },
      {
        id: activeId,
        legalName: 'Active Job Organisation',
        slug: `job-active-${suffix}`,
        status: 'active',
      },
    ]);

    const silentLog = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    };

    await expect(
      runtime.tenantJob.acceptTenantJob(
        {
          id: 'job-suspended',
          queueName: 'notification',
          data: { organisationId: suspendedId, correlationId: suspendedCorrelation },
        },
        silentLog as never,
      ),
    ).resolves.toBe(false);
    await expect(
      runtime.tenantJob.acceptTenantJob(
        {
          id: 'job-missing',
          queueName: 'retention',
          data: { organisationId: missingId, correlationId: missingCorrelation },
        },
        silentLog as never,
      ),
    ).resolves.toBe(false);
    await expect(
      runtime.tenantJob.acceptTenantJob(
        {
          id: 'job-active',
          queueName: 'reminder',
          data: { organisationId: activeId, correlationId: activeCorrelation },
        },
        silentLog as never,
      ),
    ).resolves.toBe(true);

    const suspended = await runtime.db
      .select({
        action: runtime.schema.auditEvents.action,
        result: runtime.schema.auditEvents.result,
        reason: runtime.schema.auditEvents.reason,
        organisationId: runtime.schema.auditEvents.organisationId,
      })
      .from(runtime.schema.auditEvents)
      .where(eq(runtime.schema.auditEvents.correlationId, suspendedCorrelation));
    expect(suspended).toEqual([
      expect.objectContaining({
        action: 'job.rejected',
        result: 'denied',
        reason: 'organisation_not_active',
        organisationId: suspendedId,
      }),
    ]);

    const missing = await runtime.db
      .select({
        action: runtime.schema.auditEvents.action,
        result: runtime.schema.auditEvents.result,
        reason: runtime.schema.auditEvents.reason,
        organisationId: runtime.schema.auditEvents.organisationId,
      })
      .from(runtime.schema.auditEvents)
      .where(eq(runtime.schema.auditEvents.correlationId, missingCorrelation));
    expect(missing).toEqual([
      expect.objectContaining({
        action: 'job.rejected',
        result: 'denied',
        reason: 'organisation_not_found',
        organisationId: null,
      }),
    ]);

    const active = await runtime.db
      .select({ id: runtime.schema.auditEvents.id })
      .from(runtime.schema.auditEvents)
      .where(eq(runtime.schema.auditEvents.correlationId, activeCorrelation));
    expect(active).toEqual([]);
  });
});
