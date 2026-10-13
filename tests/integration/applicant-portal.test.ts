import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/permissions/errors';

/**
 * Cross-case portal reads and the public-applications flag. Skipped unless
 * RUN_INTEGRATION=true and a migrated database is available.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, applications, portal] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/applications'),
    import('@/domains/portal'),
  ]);

  return { ...client, schema, tenancy, applications, portal };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

integration('applicant portal boundaries', () => {
  let runtime: Runtime;
  let organisationId: string;
  let applicantUserId: string;
  let staffUserId: string;
  let applicantContext: TenantContext;
  let staffContext: TenantContext;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationId = randomUUID();
    applicantUserId = randomUUID();
    staffUserId = randomUUID();
    const suffix = randomUUID().slice(0, 8);

    await runtime.db.insert(runtime.schema.users).values([
      {
        id: applicantUserId,
        name: 'Portal Applicant',
        email: `portal-applicant-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        id: staffUserId,
        name: 'Portal Staff',
        email: `portal-staff-${suffix}@example.test`,
        emailVerified: true,
      },
    ]);
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: `Portal Organisation ${suffix}`,
      slug: `portal-org-${suffix}`,
      status: 'active',
      publicApplicationsOpen: false,
    });

    const base = {
      organisationId,
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    applicantContext = {
      ...base,
      userId: applicantUserId,
      membershipId: randomUUID(),
      permissions: new Set([
        'application:create',
        'application:read-own',
        'evidence:upload-own',
      ]),
      roles: ['applicant'],
    };
    staffContext = {
      ...base,
      userId: staffUserId,
      membershipId: randomUUID(),
      permissions: new Set([
        'application:create',
        'application:read-any',
        'application:update-intake',
      ]),
      roles: ['intake-officer'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  it('blocks an applicant until public applications are open, then keeps them on their own case', async () => {
    const staffWhileClosed = await runtime.tenancy.runWithTenantContext(
      staffContext,
      () =>
        runtime.applications.createApplication({
          applicantName: 'Someone Else',
          applicantUserId: staffUserId,
        }),
    );
    expect(staffWhileClosed.applicantUserId).toBe(staffUserId);

    await expect(
      runtime.tenancy.runWithTenantContext(applicantContext, () =>
        runtime.applications.createApplication({ applicantName: 'Portal Applicant' }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    await runtime.db
      .update(runtime.schema.organisations)
      .set({ publicApplicationsOpen: true })
      .where(eq(runtime.schema.organisations.id, organisationId));

    const own = await runtime.tenancy.runWithTenantContext(applicantContext, () =>
      runtime.applications.createApplication({
        applicantName: 'Portal Applicant',
        applicantUserId: staffUserId,
        priority: 'high',
      }),
    );
    expect(own.applicantUserId).toBe(applicantUserId);
    expect(own.priority).toBe('normal');
    expect(own.clientId).toBeNull();

    await runtime.tenancy.runWithTenantContext(staffContext, () =>
      runtime.applications.addNote(own.id, {
        body: 'Internal staffing note not for the applicant.',
        visibility: 'staff',
      }),
    );
    await runtime.tenancy.runWithTenantContext(staffContext, () =>
      runtime.applications.addNote(own.id, {
        body: 'Please bring a birth certificate if you have one.',
        visibility: 'shared',
      }),
    );

    await expect(
      runtime.tenancy.runWithTenantContext(applicantContext, () =>
        runtime.portal.getApplicantPortal(staffWhileClosed.id),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const view = await runtime.tenancy.runWithTenantContext(applicantContext, () =>
      runtime.portal.getApplicantPortal(own.id),
    );
    expect(view.sharedNotes.map((note) => note.body)).toEqual([
      'Please bring a birth certificate if you have one.',
    ]);
    expect(JSON.stringify(view)).not.toContain('Internal staffing note');
    expect(view.timeline.every((entry) => !('note' in entry))).toBe(true);

    const ownList = await runtime.tenancy.runWithTenantContext(applicantContext, () =>
      runtime.portal.listOwnApplications(),
    );
    expect(ownList.map((item) => item.id)).toEqual([own.id]);

    const listed = await runtime.tenancy.runWithTenantContext(applicantContext, () =>
      runtime.applications.listApplications(),
    );
    expect(listed.items.map((item) => item.id)).toContain(own.id);
    expect(listed.items.map((item) => item.id)).not.toContain(staffWhileClosed.id);

    await expect(
      runtime.tenancy.runWithTenantContext(applicantContext, () =>
        runtime.applications.transitionApplication(staffWhileClosed.id, 'withdraw'),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const withdrawn = await runtime.tenancy.runWithTenantContext(applicantContext, () =>
      runtime.applications.transitionApplication(own.id, 'withdraw'),
    );
    expect(withdrawn.status).toBe('withdrawn');
  });
});
