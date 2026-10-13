import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Queues from '@/lib/queues';

type QueuesModule = typeof Queues;

/**
 * Legacy import v2 against a real, migrated and seeded PostgreSQL database.
 * Skipped unless RUN_INTEGRATION=true. The queue is stubbed: the test drives
 * the worker-side processor directly, exactly as the Import worker would.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

vi.mock('@/lib/queues', async (importOriginal) => ({
  ...(await importOriginal<QueuesModule>()),
  addJob: vi.fn(async () => 'stubbed-job'),
}));

const ROWS = 5_000;

async function loadRuntime() {
  const [client, schema, tenancy, imports, certificates, drizzle] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/imports'),
    import('@/domains/certificates'),
    import('drizzle-orm'),
  ]);
  return { ...client, schema, tenancy, imports, certificates, drizzle };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

/** A 5,000-row legacy file; row 1 carries a recorded outcome and a certificate. */
function legacyCsv(certificateReference: string): string {
  const header =
    'external_reference,applicant_name,status,submitted_on,decided_on,outcome,outcome_recorded_by,certificate_reference,certificate_issued_on,intake.region';
  const lines = Array.from({ length: ROWS }, (_, i) =>
    i === 0
      ? `LEG-0,Legacy Applicant 0,decided,2018-02-01,2018-06-01,confirmed,"Committee meeting 2018-06-01",${certificateReference},2018-06-15,North`
      : `LEG-${i},Legacy Applicant ${i},submitted,2020-01-01,,,,,,South`,
  );
  return `${header}\n${lines.join('\n')}\n`;
}

integration('legacy import v2', () => {
  let runtime: Runtime;
  let organisationId: string;
  let migrator: TenantContext;
  let intakeOnly: TenantContext;
  let csv: string;
  let certificateReference: string;

  beforeAll(async () => {
    runtime = await loadRuntime();
    const { db, schema } = runtime;
    organisationId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    certificateReference = `COA-LEGACY-${suffix}`;
    csv = legacyCsv(certificateReference);

    const migratorUser = randomUUID();
    const intakeUser = randomUUID();
    await db.insert(schema.users).values([
      { id: migratorUser, name: 'Migrator', email: `migrator-${suffix}@example.test` },
      { id: intakeUser, name: 'Intake', email: `intake-${suffix}@example.test` },
    ]);
    await db.insert(schema.organisations).values({
      id: organisationId,
      legalName: 'Legacy Import Organisation',
      slug: `legacy-import-${suffix}`,
      status: 'active',
    });

    async function member(userId: string, permissionKeys: string[]) {
      const membershipId = randomUUID();
      const roleId = randomUUID();
      await db
        .insert(schema.memberships)
        .values({ id: membershipId, organisationId, userId, status: 'active' });
      await db.insert(schema.roles).values({
        id: roleId,
        organisationId,
        slug: `role-${randomUUID().slice(0, 8)}`,
        name: 'Integration role',
      });
      await db
        .insert(schema.rolePermissions)
        .values(permissionKeys.map((permissionKey) => ({ roleId, permissionKey })));
      await db.insert(schema.membershipRoles).values({ membershipId, roleId });
      return {
        organisationId,
        userId,
        membershipId,
        permissions: new Set(permissionKeys),
        roles: ['integration-role'],
        sessionId: randomUUID(),
        correlationId: randomUUID(),
        requestId: randomUUID(),
      } satisfies TenantContext;
    }

    migrator = await member(migratorUser, [
      'application:create',
      'application:read-any',
      'decision:finalise',
      'certificate:sign',
    ]);
    intakeOnly = await member(intakeUser, ['application:create', 'application:read-any']);
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  async function importedCount(): Promise<number> {
    const { db, schema, drizzle } = runtime;
    const [row] = await db
      .select({ n: drizzle.count() })
      .from(schema.applications)
      .where(
        drizzle.and(
          drizzle.eq(schema.applications.organisationId, organisationId),
          drizzle.isNotNull(schema.applications.externalReference),
        ),
      );
    return row?.n ?? 0;
  }

  async function runJob(context: TenantContext) {
    const job = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.imports.requestImport({ csv, fileName: 'legacy.csv' }),
    );
    const progress: number[] = [];
    await runtime.imports.processApplicationImport({
      organisationId,
      correlationId: context.correlationId,
      importJobId: job.id,
      onProgress: (percent) => {
        progress.push(percent);
      },
    });
    const settled = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.imports.getImport(job.id),
    );
    return { settled, progress };
  }

  it('dry-runs the file without writing', async () => {
    const report = await runtime.tenancy.runWithTenantContext(migrator, () =>
      runtime.imports.validateImport({ csv, dryRun: true }),
    );
    expect(report).toMatchObject({
      total: ROWS,
      importable: ROWS,
      duplicates: 0,
      invalid: 0,
      withOutcome: 1,
      withCertificate: 1,
      missingPermissions: [],
    });
    expect(await importedCount()).toBe(0);
  });

  it('refuses outcomes and certificates from someone who cannot record them', async () => {
    await expect(
      runtime.tenancy.runWithTenantContext(intakeOnly, () =>
        runtime.imports.requestImport({ csv }),
      ),
    ).rejects.toMatchObject({ name: 'AuthorizationError' });
  });

  it(
    'imports 5,000 rows as a chunked worker job with progress',
    async () => {
      const { settled, progress } = await runJob(migrator);
      expect(settled).toMatchObject({
        status: 'completed',
        totalRows: ROWS,
        processedRows: ROWS,
        createdCount: ROWS,
        skippedCount: 0,
        failedCount: 0,
      });
      expect(progress.length).toBeGreaterThan(1);
      expect(progress.at(-1)).toBe(100);
      expect(await importedCount()).toBe(ROWS);

      // Staged applicant rows are cleared once the job settles.
      const { db, schema, drizzle } = runtime;
      const [job] = await db
        .select({ stagedRows: schema.importJobs.stagedRows })
        .from(schema.importJobs)
        .where(drizzle.eq(schema.importJobs.id, settled.id));
      expect(job?.stagedRows).toBeNull();
    },
    15 * 60_000,
  );

  it('keeps historical status and the recorded outcome with provenance', async () => {
    const { db, schema, drizzle } = runtime;
    const [application] = await db
      .select()
      .from(schema.applications)
      .where(
        drizzle.and(
          drizzle.eq(schema.applications.organisationId, organisationId),
          drizzle.eq(schema.applications.externalReference, 'LEG-0'),
        ),
      );
    expect(application).toMatchObject({
      status: 'decided',
      intake: { region: 'North' },
    });
    expect(application?.importJobId).toBeTruthy();

    const [decision] = await db
      .select()
      .from(schema.decisions)
      .where(drizzle.eq(schema.decisions.applicationId, application!.id));
    expect(decision).toMatchObject({
      status: 'finalised',
      finalOutcome: 'confirmed',
      recordedBeforeBlakpath: true,
      legacyRecordedBy: 'Committee meeting 2018-06-01',
      finalisedByUserId: null,
    });

    const [history] = await db
      .select()
      .from(schema.applicationStatusHistory)
      .where(drizzle.eq(schema.applicationStatusHistory.applicationId, application!.id));
    expect(history).toMatchObject({ action: 'legacy_import', toStatus: 'decided' });
  });

  it('verifies the legacy certificate as issued before BlakPath', async () => {
    const { db, schema, drizzle } = runtime;
    const [certificate] = await db
      .select()
      .from(schema.certificates)
      .where(
        drizzle.and(
          drizzle.eq(schema.certificates.organisationId, organisationId),
          drizzle.eq(schema.certificates.reference, certificateReference),
        ),
      );
    expect(certificate).toMatchObject({ status: 'signed', issuedBeforeBlakpath: true });

    const verification = await runtime.certificates.verifyCertificate(
      certificate!.verificationCode,
    );
    expect(verification).toMatchObject({
      valid: true,
      issuedBeforeBlakpath: true,
      signatureValid: false,
      reference: certificateReference,
      signedOn: '2018-06-15',
    });
  });

  it(
    're-running the same file creates no duplicates',
    async () => {
      const { settled } = await runJob(migrator);
      expect(settled).toMatchObject({
        status: 'completed',
        createdCount: 0,
        skippedCount: ROWS,
        failedCount: 0,
      });
      expect(await importedCount()).toBe(ROWS);
    },
    15 * 60_000,
  );
});
