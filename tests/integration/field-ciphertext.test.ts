import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Raw SQL proof that inventoried tenant columns are version-2 ciphertext and
 * that the backfill clears a seeded plaintext dataset. Skipped unless
 * RUN_INTEGRATION=true and a migrated database is available.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

const CANARY = {
  applicantName: 'Canary Applicant Name',
  intake: 'intake-secret-canary',
  note: 'note-canary-body',
  relativeName: 'Relative Canary',
  community: 'Community Canary',
  familyNotes: 'family-notes-canary',
  answer: 'answer-secret-canary',
  respondentEmail: 'respondent-canary@example.test',
  contactEmail: 'client-canary@example.test',
  contactPhone: '0400000000',
  clientNotes: 'client-notes-canary',
  rationale: 'rationale-canary-text',
  webhookSecret: 'whsec-canary-not-for-logs',
  wording: 'consent-wording-canary',
  mailRecipient: 'mail-canary@example.test',
  mailSubject: 'mail-subject-canary',
  mailText: 'mail-text-canary',
  mailHtml: 'mail-html-canary',
} as const;

async function loadRuntime() {
  const [client, schema, tenancy, applications, organisationKeys, encryption] =
    await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/lib/tenancy/context'),
      import('@/domains/applications'),
      import('@/domains/organisation-keys'),
      import('@/lib/encryption/verify'),
    ]);
  const backfill = await import('@/lib/encryption/backfill');
  const fields = await import('@/lib/encryption/tenant-fields');
  return {
    ...client,
    schema,
    tenancy,
    applications,
    organisationKeys,
    encryption,
    backfill,
    fields,
  };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

integration('inventoried columns are tenant ciphertext', () => {
  let runtime: Runtime;
  let organisationId: string;
  let userId: string;
  let applicationId: string;
  let reference: string;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationId = randomUUID();
    userId = randomUUID();
    applicationId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    reference = `APP-CANARY-${suffix}`;
    const membershipId = randomUUID();

    await runtime.db.insert(runtime.schema.users).values({
      id: userId,
      name: 'Field Cipher Staff',
      email: `field-cipher-${suffix}@example.test`,
      emailVerified: true,
    });
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Field Cipher Organisation',
      slug: `field-cipher-${suffix}`,
      status: 'active',
    });
    await runtime.db.insert(runtime.schema.memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: 'active',
    });
    await runtime.organisationKeys.ensureOrganisationKey(organisationId);

    await runtime.db.insert(runtime.schema.applications).values({
      id: applicationId,
      organisationId,
      reference,
      applicantName: CANARY.applicantName,
      intake: { canary: CANARY.intake },
      status: 'draft',
      createdByUserId: userId,
    });
    await runtime.db.insert(runtime.schema.applicationNotes).values({
      id: randomUUID(),
      organisationId,
      applicationId,
      authorUserId: userId,
      body: CANARY.note,
    });
    await runtime.db.insert(runtime.schema.familyLinks).values({
      id: randomUUID(),
      organisationId,
      applicationId,
      relationship: 'grandmother',
      relativeName: CANARY.relativeName,
      community: CANARY.community,
      notes: CANARY.familyNotes,
    });
    const formId = randomUUID();
    await runtime.db.insert(runtime.schema.forms).values({
      id: formId,
      organisationId,
      title: 'Cipher form',
      createdByUserId: userId,
    });
    await runtime.db.insert(runtime.schema.formResponses).values({
      id: randomUUID(),
      organisationId,
      formId,
      answers: { canary: CANARY.answer },
      respondentEmail: CANARY.respondentEmail,
    });
    await runtime.db.insert(runtime.schema.clients).values({
      id: randomUUID(),
      organisationId,
      displayName: 'Readable Client',
      contactEmail: CANARY.contactEmail,
      contactPhone: CANARY.contactPhone,
      notes: CANARY.clientNotes,
    });
    await runtime.db.insert(runtime.schema.decisions).values({
      id: randomUUID(),
      organisationId,
      applicationId,
      proposedOutcome: 'confirmed',
      rationale: CANARY.rationale,
    });
    await runtime.db.insert(runtime.schema.webhookEndpoints).values({
      id: randomUUID(),
      organisationId,
      url: 'https://example.test/hooks',
      secret: CANARY.webhookSecret,
    });
    await runtime.db.insert(runtime.schema.consentRecords).values({
      id: randomUUID(),
      organisationId,
      subjectUserId: userId,
      purpose: 'evidence-handling',
      wordingSnapshot: CANARY.wording,
    });
    await runtime.fields.insertSealedCorrespondence({
      organisationId,
      recipient: CANARY.mailRecipient,
      subject: CANARY.mailSubject,
      textBody: CANARY.mailText,
      htmlBody: CANARY.mailHtml,
    });

    const before = await runtime.sqlClient.unsafe<{ residue: number }[]>(
      runtime.encryption.plaintextResidueSql(organisationId),
    );
    if (!before.some((row) => Number(row.residue) > 0)) {
      throw new Error('seeded plaintext was not visible to the verification query');
    }
    const total = await runtime.backfill.runBackfillUntilDone({
      organisationId,
      correlationId: randomUUID(),
    });
    if (total <= 0) throw new Error('backfill encrypted nothing');
  });

  afterAll(async () => {
    if (runtime && organisationId) {
      await runtime.db
        .delete(runtime.schema.organisations)
        .where(eq(runtime.schema.organisations.id, organisationId));
      await runtime.db
        .delete(runtime.schema.users)
        .where(eq(runtime.schema.users.id, userId));
    }
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  it('backfill seals seeded plaintext and the verification query finds none', async () => {
    const after = await runtime.sqlClient.unsafe<
      { column_name: string; residue: number }[]
    >(runtime.encryption.plaintextResidueSql(organisationId));
    expect(after.length).toBeGreaterThan(0);
    for (const row of after) {
      expect(Number(row.residue), row.column_name).toBe(0);
    }

    const [application] = await runtime.sqlClient<
      {
        applicant_name: string;
        intake: string;
        reference: string;
        reference_bidx: string;
      }[]
    >`
      select applicant_name, intake::text as intake, reference, reference_bidx
      from applications
      where id = ${applicationId}
    `;
    expect(application?.applicant_name.startsWith('{"v":2')).toBe(true);
    expect(application?.applicant_name).not.toContain(CANARY.applicantName);
    expect(application?.intake).toMatch(/"v"\s*:\s*2/);
    expect(application?.intake).not.toContain(CANARY.intake);
    expect(application?.reference).toBe(reference);
    expect(application?.reference_bidx).toMatch(/^[0-9a-f]{64}$/);

    const stored = await runtime.sqlClient<{ blob: string }[]>`
      select body as blob from application_notes where organisation_id = ${organisationId}
      union all
      select relative_name from family_links where organisation_id = ${organisationId}
      union all
      select community from family_links where organisation_id = ${organisationId}
      union all
      select notes from family_links where organisation_id = ${organisationId}
      union all
      select answers::text from form_responses where organisation_id = ${organisationId}
      union all
      select respondent_email from form_responses where organisation_id = ${organisationId}
      union all
      select contact_email from clients where organisation_id = ${organisationId}
      union all
      select contact_phone from clients where organisation_id = ${organisationId}
      union all
      select notes from clients where organisation_id = ${organisationId}
      union all
      select rationale from decisions where organisation_id = ${organisationId}
      union all
      select secret from webhook_endpoints where organisation_id = ${organisationId}
      union all
      select wording_snapshot from consent_records where organisation_id = ${organisationId}
      union all
      select recipient from correspondence_messages where organisation_id = ${organisationId}
      union all
      select subject from correspondence_messages where organisation_id = ${organisationId}
      union all
      select text_body from correspondence_messages where organisation_id = ${organisationId}
      union all
      select html_body from correspondence_messages where organisation_id = ${organisationId}
    `;
    const blobs = stored.map((row) => row.blob);
    expect(blobs.every((blob) => /"v"\s*:\s*2/.test(blob))).toBe(true);
    for (const canary of Object.values(CANARY)) {
      expect(blobs.some((blob) => blob.includes(canary))).toBe(false);
    }

    const indexes = await runtime.sqlClient<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'applications'
    `;
    const defs = indexes.map((row) => row.indexdef);
    expect(
      defs.some((def) => def.includes('applications_org_reference_bidx_unique')),
    ).toBe(true);
    expect(
      defs.some((def) => def.includes('reference') && !def.includes('reference_bidx')),
    ).toBe(false);

    const audits = await runtime.sqlClient<{ after_meta: string | null }[]>`
      select after_meta::text as after_meta
      from audit_events
      where organisation_id = ${organisationId}
        and action like 'encryption.backfill%'
    `;
    expect(audits.length).toBeGreaterThan(0);
    for (const canary of Object.values(CANARY)) {
      expect(audits.some((row) => row.after_meta?.includes(canary))).toBe(false);
    }
  });

  it('finds the matter by reference and by a whole name token', async () => {
    const membershipId = (
      await runtime.sqlClient<{ id: string }[]>`
        select id from memberships where organisation_id = ${organisationId} limit 1
      `
    )[0]?.id;
    expect(membershipId).toBeTruthy();
    const context = {
      userId,
      organisationId,
      membershipId: membershipId ?? '',
      permissions: new Set(['application:read-any']),
      roles: ['integration-tester'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };

    const byToken = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.applications.listApplications({ q: 'Canary' }),
    );
    expect(byToken.items.map((item) => item.id)).toContain(applicationId);
    expect(byToken.items.find((item) => item.id === applicationId)?.applicantName).toBe(
      CANARY.applicantName,
    );

    const byReference = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.applications.listApplications({ q: reference }),
    );
    expect(byReference.items.map((item) => item.id)).toContain(applicationId);

    const fragment = await runtime.tenancy.runWithTenantContext(context, () =>
      runtime.applications.listApplications({ q: 'Cana' }),
    );
    expect(fragment.items.map((item) => item.id)).not.toContain(applicationId);
  });
});
