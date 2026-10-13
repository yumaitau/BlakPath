import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as S3 from '@/lib/storage/s3';

/**
 * Individual rights against a real, migrated PostgreSQL database: the request
 * register, the subject bundle, correction, erasure and tenant offboarding.
 * Queues and object storage are stubbed so only Postgres is required.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

type S3Module = typeof S3;

const storage = vi.hoisted(() => ({
  puts: [] as Array<{ key: string; body: Buffer }>,
  deletedPrefixes: [] as string[],
}));

vi.mock('@/lib/queues', () => ({
  QueueName: { Privacy: 'privacy', Webhook: 'webhook', Export: 'export' },
  addJob: vi.fn(async () => 'job'),
}));

vi.mock('@/lib/storage/s3', async (importOriginal) => {
  const actual = await importOriginal<S3Module>();
  return {
    ...actual,
    putObjectBytes: vi.fn(async (params: { key: string; body: Buffer }) => {
      storage.puts.push({ key: params.key, body: params.body });
    }),
    deleteAllObjectVersions: vi.fn(async (params: { prefix: string }) => {
      storage.deletedPrefixes.push(params.prefix);
      return 1;
    }),
  };
});

async function loadRuntime() {
  const [client, schema, tenancy, privacy, erasure, offboarding, registry, orm] =
    await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/lib/tenancy/context'),
      import('@/domains/privacy'),
      import('@/domains/privacy/erasure'),
      import('@/domains/privacy/offboarding'),
      import('@/domains/privacy/registry'),
      import('drizzle-orm'),
    ]);
  return { ...client, schema, tenancy, privacy, erasure, offboarding, registry, orm };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

integration('individual rights', () => {
  let rt: Runtime;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const staff = randomUUID();
  const applicant = randomUUID();
  const clientId = randomUUID();
  const otherClientId = randomUUID();
  const openApp = randomUUID();
  const decidedApp = randomUUID();
  const heldApp = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const email = `applicant-${suffix}@example.test`;
  let ctxA: TenantContext;
  let ctxB: TenantContext;

  const inA = <T>(fn: () => Promise<T>) => rt.tenancy.runWithTenantContext(ctxA, fn);
  const inB = <T>(fn: () => Promise<T>) => rt.tenancy.runWithTenantContext(ctxB, fn);

  beforeAll(async () => {
    rt = await loadRuntime();
    const s = rt.schema;
    await rt.db.insert(s.users).values([
      { id: staff, name: 'Records Officer', email: `staff-${suffix}@example.test` },
      { id: applicant, name: 'Applicant Person', email },
    ]);
    await rt.db.insert(s.organisations).values([
      {
        id: orgA,
        legalName: 'Rights Org A',
        slug: `rights-a-${suffix}`,
        status: 'active',
      },
      {
        id: orgB,
        legalName: 'Rights Org B',
        slug: `rights-b-${suffix}`,
        status: 'active',
      },
    ]);
    const membershipA = randomUUID();
    const membershipB = randomUUID();
    await rt.db.insert(s.memberships).values([
      { id: membershipA, organisationId: orgA, userId: staff, status: 'active' },
      { id: membershipB, organisationId: orgB, userId: staff, status: 'active' },
    ]);
    const base = {
      userId: staff,
      permissions: new Set(['privacy:manage', 'tenant:configure']),
      roles: ['records-officer'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    ctxA = { ...base, organisationId: orgA, membershipId: membershipA };
    ctxB = { ...base, organisationId: orgB, membershipId: membershipB };

    await rt.db.insert(s.clients).values([
      {
        id: clientId,
        organisationId: orgA,
        displayName: 'Applicant Person',
        contactEmail: email,
        contactPhone: '0400 000 000',
        linkedUserId: applicant,
        notes: 'Prefers phone contact.',
      },
      // Same person, other tenant: must never appear in tenant A's bundle.
      {
        id: otherClientId,
        organisationId: orgB,
        displayName: 'Applicant Person',
        contactEmail: email,
      },
    ]);
    await rt.db.insert(s.applications).values([
      {
        id: openApp,
        organisationId: orgA,
        reference: `APP-${suffix}-1`,
        applicantName: 'Applicant Person',
        applicantUserId: applicant,
        clientId,
        intake: { phone: '0400 000 000' },
      },
      {
        id: decidedApp,
        organisationId: orgA,
        reference: `APP-${suffix}-2`,
        applicantName: 'Applicant Person',
        clientId,
        status: 'decided',
      },
      {
        id: heldApp,
        organisationId: orgA,
        reference: `APP-${suffix}-3`,
        applicantName: 'Applicant Person',
        clientId,
      },
      {
        organisationId: orgB,
        reference: `APP-${suffix}-B`,
        applicantName: 'Applicant Person',
        clientId: otherClientId,
      },
    ]);
    await rt.db.insert(s.decisions).values({
      organisationId: orgA,
      applicationId: decidedApp,
      proposedOutcome: 'confirmed',
      finalOutcome: 'confirmed',
      status: 'finalised',
      rationale: 'Recorded by the committee.',
      finalisedAt: new Date(),
    });
    await rt.db.insert(s.reviews).values([
      {
        organisationId: orgA,
        applicationId: decidedApp,
        content: 'Observations for committee.',
      },
      { organisationId: orgA, applicationId: openApp, content: 'Draft observations.' },
    ]);
    await rt.db.insert(s.applicationNotes).values([
      {
        organisationId: orgA,
        applicationId: openApp,
        body: 'Shared note',
        visibility: 'shared',
      },
      {
        organisationId: orgA,
        applicationId: openApp,
        body: 'Staff-only note',
        visibility: 'staff',
      },
    ]);
    await rt.db.insert(s.familyLinks).values([
      {
        organisationId: orgA,
        applicationId: openApp,
        relationship: 'grandmother',
        relativeName: 'Aunty X',
        community: 'Example community',
      },
      {
        organisationId: orgA,
        applicationId: heldApp,
        relationship: 'grandfather',
        relativeName: 'Uncle Y',
      },
    ]);
    await rt.db.insert(s.evidence).values({
      organisationId: orgA,
      applicationId: openApp,
      fileName: 'birth-certificate.pdf',
      declaredContentType: 'application/pdf',
      sizeBytes: 1024,
      status: 'clean',
      evidenceKey: `${orgA}/evidence/${randomUUID()}`,
    });
    const formId = randomUUID();
    await rt.db.insert(s.forms).values({
      id: formId,
      organisationId: orgA,
      title: 'Family history',
      applicationId: openApp,
    });
    await rt.db.insert(s.formResponses).values({
      organisationId: orgA,
      formId,
      answers: { story: 'My grandmother was born in Example.' },
      respondentName: 'Applicant Person',
      respondentEmail: email,
      ipAddress: '203.0.113.9',
    });
    await rt.db.insert(s.consentRecords).values({
      organisationId: orgA,
      subjectUserId: applicant,
      purpose: 'evidence-handling',
      notes: 'Given at intake.',
    });
    await rt.db.insert(s.tasks).values({
      organisationId: orgA,
      title: 'Call Applicant Person',
      description: 'About missing evidence.',
      applicationId: openApp,
    });
    await rt.db.insert(s.legalHolds).values({
      organisationId: orgA,
      resourceType: 'application',
      resourceId: heldApp,
      reason: 'Tribunal review',
    });
  });

  afterAll(async () => {
    await rt?.sqlClient.end({ timeout: 5 });
  });

  it('logs a request with a statutory due date and tracks it', async () => {
    const request = await inA(() =>
      rt.privacy.logRequest({
        type: 'complaint',
        subjectClientId: clientId,
        requesterName: 'Applicant Person',
      }),
    );
    expect(request.dueAt.getTime() - request.receivedAt.getTime()).toBe(30 * 86_400_000);
    expect(request.escalation).toMatch(/OAIC|Australian Information Commissioner/);
    const list = await inA(() => rt.privacy.listRequests());
    expect(list.some((r) => r.id === request.id)).toBe(true);
    const updated = await inA(() =>
      rt.privacy.updateRequest(request.id, {
        status: 'in_progress',
        dueAt: new Date(request.dueAt.getTime() + 14 * 86_400_000),
        extensionReason: 'Records held off-site',
      }),
    );
    expect(updated).toMatchObject({
      status: 'in_progress',
      extensionReason: 'Records held off-site',
    });
    // Another tenant cannot see or touch it.
    await expect(inB(() => rt.privacy.getRequest(request.id))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('compiles the complete bundle in one action, tenant-scoped', async () => {
    const request = await inA(() =>
      rt.privacy.logRequest({
        type: 'access',
        subjectUserId: applicant,
        requesterName: 'Applicant Person',
      }),
    );
    const bundle = await inA(() => rt.privacy.compileSubjectBundle(request.id));
    const count = (table: string) =>
      bundle.sections.find((s) => s.table === table)?.records.length ?? -1;
    expect(count('clients')).toBe(1);
    expect(count('users')).toBe(1);
    expect(count('applications')).toBe(3);
    expect(count('application_notes')).toBe(1); // shared only
    expect(count('family_links')).toBe(2);
    expect(count('evidence')).toBe(1);
    expect(count('form_responses')).toBe(1);
    expect(count('consent_records')).toBe(1);
    expect(count('decisions')).toBe(1);
    expect(count('rights_requests')).toBeGreaterThanOrEqual(2);
    const notes = bundle.sections.find((s) => s.table === 'application_notes')!;
    expect(notes.records[0]!.fields.note).toBe('Shared note');

    const { pdf } = await inA(() =>
      rt.privacy.exportSubjectBundlePdf(request.id, {
        redactions: [{ table: 'family_links', recordId: 'x', field: 'relativeName' }],
      }),
    );
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('corrects only correctable fields of the subject’s own records, and keeps statements', async () => {
    const request = await inA(() =>
      rt.privacy.logRequest({
        type: 'correction',
        subjectClientId: clientId,
        requesterName: 'Applicant Person',
      }),
    );
    await inA(() =>
      rt.privacy.correctRecord(request.id, {
        table: 'applications',
        recordId: openApp,
        field: 'applicant_name',
        value: 'Applicant P. Person',
      }),
    );
    const [row] = await rt.db
      .select({ name: rt.schema.applications.applicantName })
      .from(rt.schema.applications)
      .where(rt.orm.eq(rt.schema.applications.id, openApp));
    expect(row!.name).toBe('Applicant P. Person');

    await expect(
      inA(() =>
        rt.privacy.correctRecord(request.id, {
          table: 'applications',
          recordId: openApp,
          field: 'reference',
          value: 'APP-FORGED',
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    const [link] = await rt.db
      .select({ id: rt.schema.familyLinks.id })
      .from(rt.schema.familyLinks)
      .where(rt.orm.eq(rt.schema.familyLinks.applicationId, openApp));
    const statement = await inA(() =>
      rt.privacy.associateStatement(request.id, {
        table: 'family_links',
        recordId: link!.id,
        field: 'relative_name',
        statement: 'Her name is spelt differently in community records.',
      }),
    );
    expect(statement.resourceType).toBe('family_links');
  });

  it('erasure anonymises every PII column outside official records and holds', async () => {
    const request = await inA(() =>
      rt.privacy.logRequest({
        type: 'erasure',
        subjectClientId: clientId,
        requesterName: 'Applicant Person',
      }),
    );
    await inA(() => rt.privacy.requestErasure(request.id));
    const report = await rt.erasure.processErasure({
      organisationId: orgA,
      correlationId: randomUUID(),
      requestId: request.id,
      requestedByUserId: staff,
    });
    expect(report).not.toBeNull();
    expect(report!.heldApplicationIds).toEqual([heldApp]);
    expect(report!.officialApplicationIds).toEqual([decidedApp]);
    expect(report!.objectFailures).toEqual([]);
    expect(storage.deletedPrefixes.some((p) => p.startsWith(`${orgA}/evidence/`))).toBe(
      true,
    );

    const { eq, and, inArray, not } = rt.orm;
    const s = rt.schema;
    const [client] = await rt.db
      .select()
      .from(s.clients)
      .where(eq(s.clients.id, clientId));
    expect(client).toMatchObject({
      displayName: '[erased]',
      contactEmail: null,
      contactPhone: null,
      notes: null,
      linkedUserId: null,
    });

    const apps = await rt.db
      .select()
      .from(s.applications)
      .where(inArray(s.applications.id, [openApp, decidedApp, heldApp]));
    const byId = new Map(apps.map((a) => [a.id, a]));
    expect(byId.get(openApp)).toMatchObject({ applicantName: '[erased]', intake: null });
    // Official record keeps the name the certificate/decision refers to.
    expect(byId.get(decidedApp)!.applicantName).toBe('Applicant Person');
    // Legal hold: untouched.
    expect(byId.get(heldApp)!.applicantName).toBe('Applicant Person');

    // Every registry-erased column on the open matter's child rows is anonymised.
    for (const [table, rows] of [
      [
        'application_notes',
        await rt.db
          .select()
          .from(s.applicationNotes)
          .where(eq(s.applicationNotes.applicationId, openApp)),
      ],
      [
        'family_links',
        await rt.db
          .select()
          .from(s.familyLinks)
          .where(eq(s.familyLinks.applicationId, openApp)),
      ],
      [
        'evidence',
        await rt.db
          .select()
          .from(s.evidence)
          .where(eq(s.evidence.applicationId, openApp)),
      ],
      [
        'tasks',
        await rt.db.select().from(s.tasks).where(eq(s.tasks.applicationId, openApp)),
      ],
      [
        'reviews',
        await rt.db.select().from(s.reviews).where(eq(s.reviews.applicationId, openApp)),
      ],
      [
        'form_responses',
        await rt.db
          .select()
          .from(s.formResponses)
          .where(eq(s.formResponses.organisationId, orgA)),
      ],
      [
        'consent_records',
        await rt.db
          .select()
          .from(s.consentRecords)
          .where(eq(s.consentRecords.organisationId, orgA)),
      ],
    ] as const) {
      const rules = rt.registry.erasureRulesFor(table)!;
      const keys = (await import('@/domains/privacy/subject')).columnKeys(
        (await import('@/domains/privacy/subject')).SUBJECT_TARGETS[table]!.table,
      );
      expect(rows.length, table).toBeGreaterThan(0);
      for (const row of rows as Array<Record<string, unknown>>) {
        for (const [column, rule] of Object.entries(rules)) {
          expect(row[keys.get(column)!], `${table}.${column}`).toEqual(
            rt.registry.anonymisedValue(rule),
          );
        }
      }
    }

    // Held matter's children and official records are untouched.
    const [heldLink] = await rt.db
      .select()
      .from(s.familyLinks)
      .where(eq(s.familyLinks.applicationId, heldApp));
    expect(heldLink!.relativeName).toBe('Uncle Y');
    const [decidedReview] = await rt.db
      .select()
      .from(s.reviews)
      .where(eq(s.reviews.applicationId, decidedApp));
    expect(decidedReview!.content).toBe('Observations for committee.');
    const [decision] = await rt.db
      .select()
      .from(s.decisions)
      .where(eq(s.decisions.applicationId, decidedApp));
    expect(decision!.rationale).toBe('Recorded by the committee.');

    // The other tenant's record of the same person is untouched.
    const [otherClient] = await rt.db
      .select()
      .from(s.clients)
      .where(eq(s.clients.id, otherClientId));
    expect(otherClient!.contactEmail).toBe(email);

    const [stored] = await rt.db
      .select()
      .from(s.rightsRequests)
      .where(eq(s.rightsRequests.id, request.id));
    expect(stored!.erasedAt).not.toBeNull();
    const audits = await rt.db
      .select()
      .from(s.auditEvents)
      .where(
        and(
          eq(s.auditEvents.organisationId, orgA),
          eq(s.auditEvents.action, 'privacy.subject_erased'),
          not(eq(s.auditEvents.result, 'denied')),
        ),
      );
    expect(audits.length).toBe(1);
  });

  it('offboards a tenant: export, download, then purge every row and object', async () => {
    const slug = `rights-b-${suffix}`;
    await expect(
      inB(() => rt.privacy.requestTenantOffboarding({ confirmSlug: 'wrong' })),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const row = await inB(() =>
      rt.privacy.requestTenantOffboarding({ confirmSlug: slug }),
    );
    const job = {
      organisationId: orgB,
      correlationId: randomUUID(),
      offboardingId: row.id,
    };
    await rt.offboarding.processOffboardingExport(job);

    const put = storage.puts.find((p) => p.key.endsWith(`${row.id}.json`))!;
    const exported = JSON.parse(put.body.toString('utf8')) as {
      manifest: Record<string, number>;
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    expect(exported.manifest.applications).toBe(1);
    expect(exported.manifest.clients).toBe(1);
    expect(exported.tables.organisations![0]!.id).toBe(orgB);

    await expect(
      inB(() => rt.privacy.confirmTenantPurge(row.id, { confirmSlug: slug })),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' }); // not downloaded yet
    await inB(() => rt.privacy.getOffboardingExportUrl(row.id));
    await inB(() => rt.privacy.confirmTenantPurge(row.id, { confirmSlug: slug }));
    await rt.offboarding.processOffboardingPurge(job);

    expect(storage.deletedPrefixes).toContain(`${orgB}/`);
    const { eq } = rt.orm;
    const s = rt.schema;
    expect(
      await rt.db.select().from(s.organisations).where(eq(s.organisations.id, orgB)),
    ).toEqual([]);
    expect(
      await rt.db.select().from(s.clients).where(eq(s.clients.organisationId, orgB)),
    ).toEqual([]);
    expect(
      await rt.db
        .select()
        .from(s.applications)
        .where(eq(s.applications.organisationId, orgB)),
    ).toEqual([]);
    const [log] = await rt.db
      .select()
      .from(s.tenantOffboardings)
      .where(eq(s.tenantOffboardings.id, row.id));
    expect(log!.status).toBe('purged');
    // The audit trail outlives the tenant.
    const trail = await rt.db
      .select()
      .from(s.auditEvents)
      .where(eq(s.auditEvents.organisationId, orgB));
    expect(trail.length).toBeGreaterThan(0);
    // Tenant A is untouched.
    expect(
      (await rt.db.select().from(s.organisations).where(eq(s.organisations.id, orgA)))
        .length,
    ).toBe(1);
  });
});
