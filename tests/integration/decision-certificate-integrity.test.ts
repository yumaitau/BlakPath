import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationWorkflowError } from '@/domains/applications/workflow';
import { DecisionWorkflowError } from '@/domains/decisions/errors';

/**
 * Database proof for issue #102. Skipped unless RUN_INTEGRATION=true and a
 * migrated Postgres is available at DATABASE_URL.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, applications, decisions, certificates] =
    await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/lib/tenancy/context'),
      import('@/domains/applications'),
      import('@/domains/decisions'),
      import('@/domains/certificates'),
    ]);
  return { ...client, schema, tenancy, applications, decisions, certificates };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const row = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (row.code === '23505') return true;
    if (
      typeof row.message === 'string' &&
      row.message.includes('certificates_live_decision_unique')
    ) {
      return true;
    }
    current = row.cause;
  }
  return false;
}

integration('decision and certificate integrity', () => {
  let runtime: Runtime;
  let context: TenantContext;
  let userId: string;

  beforeAll(async () => {
    runtime = await loadRuntime();
    const organisationId = randomUUID();
    userId = randomUUID();
    const membershipId = randomUUID();
    const suffix = randomUUID().slice(0, 8);

    await runtime.db.insert(runtime.schema.users).values({
      id: userId,
      name: 'Integrity Test Chair',
      email: `integrity-${suffix}@example.test`,
      emailVerified: true,
    });
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Integrity Test Organisation',
      slug: `integrity-${suffix}`,
      status: 'active',
    });
    const { ensureOrganisationKey } = await import('@/domains/organisation-keys');
    await ensureOrganisationKey(organisationId);
    await runtime.db.insert(runtime.schema.memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: 'active',
    });

    context = {
      organisationId,
      userId,
      membershipId,
      permissions: new Set([
        'application:create',
        'application:read-any',
        'application:update-intake',
        'review:finalise',
        'meeting:agenda-manage',
        'decision:propose',
        'decision:finalise',
        'certificate:generate',
      ]),
      roles: ['integration-tester'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  async function advanceTo(applicationId: string, target: 'in_review' | 'in_committee') {
    await runtime.tenancy.runWithTenantContext(context, async () => {
      await runtime.applications.transitionApplication(applicationId, 'submit');
      await runtime.applications.transitionApplication(applicationId, 'begin_intake');
      await runtime.applications.transitionApplication(applicationId, 'start_review');
      if (target === 'in_review') return;
      await runtime.applications.transitionApplication(
        applicationId,
        'ready_for_committee',
      );
      await runtime.applications.transitionApplication(
        applicationId,
        'schedule_committee',
      );
    });
  }

  it('refuses a proposal while the case is in review', async () => {
    const application = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.applications.createApplication({
        applicantName: 'Proposal gate',
        applicantUserId: userId,
      }),
    );
    await advanceTo(application.id, 'in_review');

    const error = await runtime.tenancy
      .runWithTenantContext(context, () =>
        runtime.decisions.proposeDecision(application.id, { outcome: 'confirmed' }),
      )
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(DecisionWorkflowError);
    expect(error).toMatchObject({ status: 409, code: 'CASE_NOT_READY_FOR_DECISION' });
  });

  it('rolls back finalisation when the case transition is illegal', async () => {
    const application = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.applications.createApplication({
        applicantName: 'Rollback gate',
        applicantUserId: userId,
      }),
    );
    await advanceTo(application.id, 'in_committee');
    const decision = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.decisions.proposeDecision(application.id, { outcome: 'confirmed' }),
    );

    await runtime.db
      .update(runtime.schema.applications)
      .set({ status: 'in_review' })
      .where(eq(runtime.schema.applications.id, application.id));

    await expect(
      runtime.tenancy.runWithTenantContext(context, () =>
        runtime.decisions.finaliseDecision(decision.id, { outcome: 'confirmed' }),
      ),
    ).rejects.toBeInstanceOf(ApplicationWorkflowError);

    const [storedDecision] = await runtime.db
      .select({ status: runtime.schema.decisions.status })
      .from(runtime.schema.decisions)
      .where(eq(runtime.schema.decisions.id, decision.id));
    const [storedApplication] = await runtime.db
      .select({ status: runtime.schema.applications.status })
      .from(runtime.schema.applications)
      .where(eq(runtime.schema.applications.id, application.id));
    expect(storedDecision?.status).toBe('proposed');
    expect(storedApplication?.status).toBe('in_review');
  });

  it('denies a certificate when the case was never decided', async () => {
    const application = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.applications.createApplication({
        applicantName: 'Undecided certificate',
        applicantUserId: userId,
      }),
    );
    await advanceTo(application.id, 'in_review');
    const [decision] = await runtime.db
      .insert(runtime.schema.decisions)
      .values({
        organisationId: context.organisationId,
        applicationId: application.id,
        proposedByUserId: userId,
        proposedOutcome: 'confirmed',
        status: 'finalised',
        finalOutcome: 'confirmed',
        finalisedByUserId: userId,
        finalisedAt: new Date(),
      })
      .returning({ id: runtime.schema.decisions.id });
    if (!decision) throw new Error('decision insert returned no row');

    await expect(
      runtime.tenancy.runWithTenantContext(context, () =>
        runtime.certificates.generateCertificate({ decisionId: decision.id }),
      ),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'POLICY_DENIED',
      message: 'A certificate can only be generated after the case is decided.',
    });
  });

  it('rejects a second live certificate for the same decision', async () => {
    const application = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.applications.createApplication({
        applicantName: 'Certificate gate',
        applicantUserId: userId,
      }),
    );
    await advanceTo(application.id, 'in_committee');
    const decision = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.decisions.proposeDecision(application.id, { outcome: 'confirmed' }),
    );
    await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.decisions.finaliseDecision(decision.id, { outcome: 'confirmed' }),
    );

    const base = {
      organisationId: context.organisationId,
      applicationId: application.id,
      decisionId: decision.id,
      status: 'draft' as const,
    };
    await runtime.db.insert(runtime.schema.certificates).values({
      ...base,
      reference: `CERT-LIVE-${randomUUID().slice(0, 8)}`,
      verificationCode: randomUUID().replace(/-/g, '') + 'aaaa',
    });

    let rejected = false;
    try {
      await runtime.db.insert(runtime.schema.certificates).values({
        ...base,
        reference: `CERT-LIVE-${randomUUID().slice(0, 8)}`,
        verificationCode: randomUUID().replace(/-/g, '') + 'bbbb',
      });
    } catch (error) {
      rejected = isUniqueViolation(error);
      if (!rejected) throw error;
    }
    expect(rejected).toBe(true);

    await runtime.db
      .update(runtime.schema.certificates)
      .set({ status: 'revoked' })
      .where(eq(runtime.schema.certificates.decisionId, decision.id));

    await expect(
      runtime.db.insert(runtime.schema.certificates).values({
        ...base,
        reference: `CERT-LIVE-${randomUUID().slice(0, 8)}`,
        verificationCode: randomUUID().replace(/-/g, '') + 'cccc',
      }),
    ).resolves.toBeDefined();
  });
});
