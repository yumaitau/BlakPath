import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Database proof for human-sent correspondence (#99). Skipped unless
 * RUN_INTEGRATION=true and a migrated Postgres is available at DATABASE_URL.
 *
 * Delivery is sealed into `correspondence_messages` exactly as in production;
 * only the BullMQ enqueue is replaced so the test does not hold a Redis queue.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

vi.mock('@/lib/email/queue', async () => {
  const fields = await import('@/lib/encryption/tenant-fields');
  return {
    queueTenantEmail: async (input: {
      organisationId: string;
      to: string;
      subject: string;
      text: string;
    }) =>
      fields.insertSealedCorrespondence({
        organisationId: input.organisationId,
        recipient: input.to,
        subject: input.subject,
        textBody: input.text,
        htmlBody: null,
      }),
  };
});

async function loadRuntime() {
  const [client, schema, tenancy, applications, evidence, correspondence, fields] =
    await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/lib/tenancy/context'),
      import('@/domains/applications'),
      import('@/domains/evidence'),
      import('@/domains/correspondence'),
      import('@/lib/encryption/tenant-fields'),
    ]);
  return {
    ...client,
    schema,
    tenancy,
    applications,
    evidence,
    correspondence,
    fields,
  };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

const ENVELOPE = /^\{"v":2/;

integration('correspondence', () => {
  let runtime: Runtime;
  let staff: TenantContext;
  let applicant: TenantContext;
  let organisationId: string;
  let applicationId: string;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const suffix = randomUUID().slice(0, 8);

    await runtime.db.insert(runtime.schema.users).values({
      id: userId,
      name: 'Correspondence Officer',
      email: `correspondence-${suffix}@example.test`,
      emailVerified: true,
    });
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Correspondence Test Organisation',
      slug: `correspondence-${suffix}`,
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

    const base = {
      organisationId,
      userId,
      membershipId,
      roles: ['integration-tester'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    staff = {
      ...base,
      permissions: new Set([
        'application:create',
        'application:read-any',
        'evidence:request',
        'correspondence:send',
        'correspondence:manage-templates',
      ]),
    };
    applicant = { ...base, permissions: new Set(['application:read-own']) };

    const application = await runtime.tenancy.runWithTenantContext(staff, () =>
      runtime.applications.createApplication({ applicantName: 'Jane Letterhead' }),
    );
    applicationId = application.id;
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  const asStaff = <T>(fn: () => Promise<T>) =>
    runtime.tenancy.runWithTenantContext(staff, fn);

  it('seals template text and opens it for staff', async () => {
    const created = await asStaff(() => runtime.correspondence.seedStarterTemplates());
    expect(created.length).toBeGreaterThan(0);
    const again = await asStaff(() => runtime.correspondence.seedStarterTemplates());
    expect(again).toHaveLength(0);

    const raw = await runtime.db
      .select()
      .from(runtime.schema.correspondenceTemplates)
      .where(eq(runtime.schema.correspondenceTemplates.organisationId, organisationId));
    expect(raw.length).toBe(created.length);
    for (const row of raw) {
      expect(row.subjectTemplate).toMatch(ENVELOPE);
      expect(row.bodyTemplate).toMatch(ENVELOPE);
    }

    const listed = await asStaff(() => runtime.correspondence.listTemplates());
    const general = listed.find((row) => row.kind === 'general');
    expect(general?.bodyTemplate).toContain('{{');

    const updated = await asStaff(() =>
      runtime.correspondence.updateTemplate(general?.id ?? '', {
        subjectTemplate: 'About {{application.reference}}',
        active: true,
      }),
    );
    expect(updated.subjectTemplate).toBe('About {{application.reference}}');

    await expect(
      asStaff(() =>
        runtime.correspondence.createTemplate({
          name: 'Bad field',
          kind: 'general',
          subjectTemplate: 'Hello {{applicant.dob}}',
          bodyTemplate: 'Body',
        }),
      ),
    ).rejects.toMatchObject({ name: 'CorrespondenceError', code: 'unknown_merge_field' });
  });

  it('drafts, sends once, and keeps only ciphertext and a hashed link', async () => {
    const { item, preview } = await asStaff(() =>
      runtime.correspondence.draftCorrespondence(applicationId, {
        kind: 'general',
        channel: 'email',
        subjectTemplate: 'Letter for {{applicant.name}}',
        bodyTemplate: 'Dear {{applicant.name}}, read it at {{portal.url}}.',
        recipientEmail: 'jane.letterhead@example.test',
      }),
    );
    expect(item.status).toBe('draft');
    expect(preview.subject).toBe('Letter for Jane Letterhead');
    expect(preview.email?.text).not.toContain('Jane Letterhead');

    const sent = await asStaff(() => runtime.correspondence.sendCorrespondence(item.id));
    expect(sent.status).toBe('sent');
    expect(sent.messageId).toBeTruthy();
    expect(sent.renderedBody).toContain('Dear Jane Letterhead');
    expect(sent.renderedBody).not.toMatch(/\/c\//);

    const [raw] = await runtime.db
      .select()
      .from(runtime.schema.correspondenceItems)
      .where(eq(runtime.schema.correspondenceItems.id, item.id));
    for (const value of [
      raw?.subjectTemplate,
      raw?.bodyTemplate,
      raw?.renderedSubject,
      raw?.renderedBody,
      raw?.recipientName,
      raw?.recipientEmail,
    ]) {
      expect(value).toMatch(ENVELOPE);
    }
    expect(raw?.portalTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(raw?.messageId).toBe(sent.messageId);

    await expect(
      asStaff(() => runtime.correspondence.sendCorrespondence(item.id)),
    ).rejects.toMatchObject({ code: 'not_draft' });

    const letters = await asStaff(() =>
      runtime.correspondence.listCorrespondence(applicationId),
    );
    const listed = letters.find((letter) => letter.id === item.id);
    expect(listed?.recipientEmail).toBe('jane.letterhead@example.test');
    expect(listed?.emailText).toContain('[secure link]');
    expect(listed?.emailText).not.toContain('Jane Letterhead');

    // The applicant link opens the stored letter; the live link is only in the
    // sealed delivery copy.
    const message = await runtime.fields.openCorrespondence(
      organisationId,
      sent.messageId ?? '',
    );
    const token = message?.text.match(/\/c\/([A-Za-z0-9_-]+)/)?.[1] ?? '';
    expect(token.length).toBeGreaterThan(20);
    const view = await runtime.correspondence.getPublicCorrespondence(token);
    expect(view).toMatchObject({
      organisationName: 'Correspondence Test Organisation',
      subject: 'Letter for Jane Letterhead',
      kind: 'general',
      certificateAvailable: false,
    });
    expect(view?.body).toContain('the secure link sent with this letter');
    expect(
      await runtime.correspondence.getPublicCorrespondence('x'.repeat(36)),
    ).toBeNull();
    expect(
      await runtime.correspondence.getPublicCertificateDownloadUrl(token),
    ).toBeNull();
  });

  it('refuses sends that are missing their facts', async () => {
    await expect(
      asStaff(() =>
        runtime.correspondence.draftCorrespondence(applicationId, {
          kind: 'evidence_request',
          channel: 'email',
        }),
      ),
    ).rejects.toMatchObject({ code: 'related_record_required' });

    const request = await asStaff(() =>
      runtime.evidence.requestFurtherEvidence(applicationId, {
        description: 'Birth certificate copy',
      }),
    );
    await expect(
      asStaff(() =>
        runtime.correspondence.sendEvidenceRequestNotice(applicationId, request.id, {
          channel: 'email',
          recipientEmail: 'jane.letterhead@example.test',
        }),
      ),
    ).rejects.toMatchObject({ code: 'evidence_due_date_required' });

    const { item } = await asStaff(() =>
      runtime.correspondence.draftCorrespondence(applicationId, {
        kind: 'general',
        channel: 'email',
      }),
    );
    await expect(
      asStaff(() => runtime.correspondence.sendCorrespondence(item.id)),
    ).rejects.toMatchObject({ code: 'recipient_email_required' });
  });

  it('keeps drafts and letters away from applicant-only access', async () => {
    await expect(
      runtime.tenancy.runWithTenantContext(applicant, () =>
        runtime.correspondence.listCorrespondence(applicationId),
      ),
    ).rejects.toMatchObject({ name: 'AuthorizationError' });
    await expect(
      runtime.tenancy.runWithTenantContext(applicant, () =>
        runtime.correspondence.draftCorrespondence(applicationId, {
          kind: 'general',
          channel: 'letter',
        }),
      ),
    ).rejects.toMatchObject({ name: 'AuthorizationError' });
  });
});
