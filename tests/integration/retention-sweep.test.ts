import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as drizzle from 'drizzle-orm';
import type { Database } from '@/db/client';
import { AUDIT_APPEND_ONLY_TRIGGERS } from '@/db/audit-guard';
import type * as TenantFields from '@/lib/encryption/tenant-fields';
import * as schema from '@/db/schema';
import type { RetentionPreviewItem, SweepInput } from '@/domains/retention/sweep';
import { ANONYMISED_PLACEHOLDER, MIN_RETENTION_DAYS } from '@/domains/retention/rules';
import { CATALOGUE_VERSION } from '@/domains/retention/disposal';

/**
 * Real Postgres. Proves the sweep page cannot hide due rows behind not-due or
 * held rows, that anonymise is idempotent, and that holds and official records
 * stop disposal. S3 is mocked here; version deletion is covered in unit tests.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

const deleteAllObjectVersions = vi.hoisted(() =>
  vi.fn(async (_params: { bucket: string; key: string }) => {}),
);

vi.mock('@/lib/storage/s3', () => ({
  deleteAllObjectVersions: (params: { bucket: string; key: string }) =>
    deleteAllObjectVersions(params),
  EVIDENCE_BUCKET: 'blakpath-evidence',
  QUARANTINE_BUCKET: 'blakpath-quarantine',
}));

const DAY = 24 * 60 * 60 * 1000;

integration('retention sweep', () => {
  let closeDatabase: (() => Promise<unknown>) | undefined;
  let db: Database;
  let processRetentionSweep: (input: SweepInput) => Promise<void>;
  let previewRetentionSweep: (organisationId: string) => Promise<RetentionPreviewItem[]>;
  let pageSize: number;
  let ensureOrganisationKey: (organisationId: string) => Promise<void>;
  let fields: typeof TenantFields;
  const orgIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const client = await import('@/db/client');
    db = client.db;
    closeDatabase = () => client.sqlClient.end({ timeout: 5 });
    const sweep = await import('@/domains/retention/sweep');
    processRetentionSweep = sweep.processRetentionSweep;
    previewRetentionSweep = sweep.previewRetentionSweep;
    pageSize = sweep.SWEEP_PAGE_SIZE;
    ensureOrganisationKey = (await import('@/domains/organisation-keys'))
      .ensureOrganisationKey;
    fields = await import('@/lib/encryption/tenant-fields');
  });

  beforeEach(() => {
    deleteAllObjectVersions.mockReset();
    deleteAllObjectVersions.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    if (db && schema && drizzle) {
      // Teardown only: the audit trail is append-only, so lift the guard to
      // remove this suite's throwaway tenants, then restore it.
      for (const trigger of AUDIT_APPEND_ONLY_TRIGGERS) {
        await db
          .execute(
            drizzle.sql.raw(
              `ALTER TABLE ${trigger.table} DISABLE TRIGGER ${trigger.name}`,
            ),
          )
          .catch(() => undefined);
      }
      try {
        for (const orgId of orgIds) {
          await db
            .delete(schema.auditEvents)
            .where(drizzle.eq(schema.auditEvents.organisationId, orgId));
        }
      } finally {
        for (const trigger of AUDIT_APPEND_ONLY_TRIGGERS) {
          await db
            .execute(
              drizzle.sql.raw(
                `ALTER TABLE ${trigger.table} ENABLE ALWAYS TRIGGER ${trigger.name}`,
              ),
            )
            .catch(() => undefined);
        }
      }
      for (const orgId of orgIds) {
        await db
          .delete(schema.organisations)
          .where(drizzle.eq(schema.organisations.id, orgId));
      }
      for (const userId of userIds) {
        await db.delete(schema.users).where(drizzle.eq(schema.users.id, userId));
      }
    }
    await closeDatabase?.();
  });

  async function createOrg(): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const [org] = await db
      .insert(schema.organisations)
      .values({ legalName: `Retention ${stamp}`, slug: `ret-${stamp}`, status: 'active' })
      .returning({ id: schema.organisations.id });
    if (!org) throw new Error('organisation insert failed');
    orgIds.push(org.id);
    await ensureOrganisationKey(org.id);
    return org.id;
  }

  async function createUser(): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const [user] = await db
      .insert(schema.users)
      .values({ name: 'Records Officer', email: `records-${stamp}@blakpath.test` })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('user insert failed');
    userIds.push(user.id);
    return user.id;
  }

  async function insertApps(
    orgId: string,
    prefix: string,
    count: number,
    createdAt: Date,
    extra: Partial<typeof schema.applications.$inferInsert> = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; offset < count; offset += 100) {
      const size = Math.min(100, count - offset);
      const values = Array.from({ length: size }, (_, index) => ({
        organisationId: orgId,
        reference: `${prefix}-${offset + index}`,
        applicantName: `${prefix} ${offset + index}`,
        createdAt,
        ...extra,
      }));
      const rows = await db
        .insert(schema.applications)
        .values(values)
        .returning({ id: schema.applications.id });
      ids.push(...rows.map((row) => row.id));
    }
    return ids;
  }

  const CLASS_BY_TYPE = {
    application: 'application_matter',
    evidence: 'supporting_evidence',
    form_response: 'application_matter',
  } as const;

  async function signAuthority(
    orgId: string,
    resourceType: keyof typeof CLASS_BY_TYPE,
    authorityReference: string,
  ): Promise<void> {
    const signer = await createUser();
    await db.insert(schema.disposalAuthoritySignoffs).values({
      organisationId: orgId,
      jurisdiction: 'nsw',
      disposalClass: CLASS_BY_TYPE[resourceType],
      catalogueVersion: CATALOGUE_VERSION,
      authorityReference,
      permanent: false,
      signedOffByUserId: signer,
    });
  }

  /**
   * An active policy drafted by one person and activated by another. A purge
   * gets a matching records-manager sign-off unless `signed` is false.
   */
  async function addPolicy(
    orgId: string,
    resourceType: keyof typeof CLASS_BY_TYPE,
    action: 'anonymise' | 'purge',
    options: { disposalAuthorityRef?: string; signed?: boolean } = {},
  ): Promise<string> {
    const drafter = await createUser();
    const approver = await createUser();
    const disposalAuthorityRef =
      options.disposalAuthorityRef ?? (action === 'purge' ? 'GA39-1.1.1' : undefined);
    const [policy] = await db
      .insert(schema.retentionPolicies)
      .values({
        organisationId: orgId,
        resourceType,
        disposalClass: CLASS_BY_TYPE[resourceType],
        jurisdiction: 'nsw',
        retentionDays: MIN_RETENTION_DAYS,
        action,
        active: true,
        createdByUserId: drafter,
        approvedByUserId: approver,
        approvedAt: new Date(),
        ...(disposalAuthorityRef ? { disposalAuthorityRef } : {}),
      })
      .returning({ id: schema.retentionPolicies.id });
    if (!policy) throw new Error('policy insert failed');
    if ((options.signed ?? action === 'purge') && disposalAuthorityRef) {
      await signAuthority(orgId, resourceType, disposalAuthorityRef);
    }
    return policy.id;
  }

  async function auditCount(orgId: string, correlationId?: string): Promise<number> {
    const filters = [drizzle.eq(schema.auditEvents.organisationId, orgId)];
    if (correlationId) {
      filters.push(drizzle.eq(schema.auditEvents.correlationId, correlationId));
    }
    const [row] = await db
      .select({ n: drizzle.count() })
      .from(schema.auditEvents)
      .where(drizzle.and(...filters));
    return Number(row?.n ?? 0);
  }

  it('processes due rows that sit behind a full page of not-due rows', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    await insertApps(orgId, 'FRESH', pageSize + 100, new Date());
    const dueIds = await insertApps(orgId, 'DUE', 10, dueAt);
    await addPolicy(orgId, 'application', 'anonymise');

    const preview = await previewRetentionSweep(orgId);
    expect(preview).toEqual([
      expect.objectContaining({
        resourceType: 'application',
        action: 'anonymise',
        due: 10,
      }),
    ]);
    expect(await auditCount(orgId)).toBe(0);

    await processRetentionSweep({ organisationId: orgId, correlationId: 'due-page' });

    const dueRows = await db
      .select({
        id: schema.applications.id,
        anonymisedAt: schema.applications.anonymisedAt,
        applicantName: schema.applications.applicantName,
        intake: schema.applications.intake,
      })
      .from(schema.applications)
      .where(drizzle.inArray(schema.applications.id, dueIds));
    expect(dueRows).toHaveLength(10);
    expect(dueRows.every((row) => row.anonymisedAt instanceof Date)).toBe(true);
    const opened = await fields.openApplicationRows(orgId, dueRows);
    expect(opened.every((row) => row.applicantName === ANONYMISED_PLACEHOLDER)).toBe(
      true,
    );

    const [fresh] = await db
      .select({ n: drizzle.count() })
      .from(schema.applications)
      .where(
        drizzle.and(
          drizzle.eq(schema.applications.organisationId, orgId),
          drizzle.isNull(schema.applications.anonymisedAt),
          drizzle.like(schema.applications.reference, 'FRESH-%'),
        ),
      );
    expect(Number(fresh?.n ?? 0)).toBe(pageSize + 100);
  }, 120_000);

  it('processes due rows that sit behind a full page of held rows', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    const heldIds = await insertApps(orgId, 'HELD', pageSize, dueAt);
    const dueIds = await insertApps(orgId, 'FREE', 10, dueAt);
    for (let offset = 0; offset < heldIds.length; offset += 100) {
      await db.insert(schema.legalHolds).values(
        heldIds.slice(offset, offset + 100).map((id) => ({
          organisationId: orgId,
          resourceType: 'application',
          resourceId: id,
          reason: 'litigation',
        })),
      );
    }
    await addPolicy(orgId, 'application', 'anonymise');

    await processRetentionSweep({ organisationId: orgId, correlationId: 'held-page' });

    const held = await db
      .select({ anonymisedAt: schema.applications.anonymisedAt })
      .from(schema.applications)
      .where(drizzle.inArray(schema.applications.id, heldIds));
    expect(held.every((row) => row.anonymisedAt === null)).toBe(true);
    const freed = await db
      .select({ anonymisedAt: schema.applications.anonymisedAt })
      .from(schema.applications)
      .where(drizzle.inArray(schema.applications.id, dueIds));
    expect(freed.every((row) => row.anonymisedAt instanceof Date)).toBe(true);
  }, 120_000);

  it('does not rewrite or re-audit an anonymised application', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    const [id] = await insertApps(orgId, 'ONCE', 1, dueAt);
    await addPolicy(orgId, 'application', 'anonymise');
    await processRetentionSweep({ organisationId: orgId, correlationId: 'once-first' });
    const [first] = await db
      .select({ anonymisedAt: schema.applications.anonymisedAt })
      .from(schema.applications)
      .where(drizzle.eq(schema.applications.id, id ?? ''));
    const before = await auditCount(orgId);

    await processRetentionSweep({ organisationId: orgId, correlationId: 'once-second' });

    const [second] = await db
      .select({
        anonymisedAt: schema.applications.anonymisedAt,
        applicantName: schema.applications.applicantName,
      })
      .from(schema.applications)
      .where(drizzle.eq(schema.applications.id, id ?? ''));
    expect(second?.anonymisedAt?.getTime()).toBe(first?.anonymisedAt?.getTime());
    expect(
      await fields.openApplicantName(orgId, id ?? '', second?.applicantName ?? ''),
    ).toBe(ANONYMISED_PLACEHOLDER);
    expect(await auditCount(orgId)).toBe(before);
    expect(await auditCount(orgId, 'once-second')).toBe(0);
  });

  it('anonymises family links, evidence, form responses, notes, client and decision notes', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    const [client] = await db
      .insert(schema.clients)
      .values({
        organisationId: orgId,
        displayName: 'Pat Smith',
        contactEmail: 'pat@example.test',
        notes: 'phone intake',
      })
      .returning({ id: schema.clients.id });
    const [appId] = await insertApps(orgId, 'CASCADE', 1, dueAt, {
      clientId: client?.id,
      intake: { phone: '0400000000' },
    });
    if (!appId || !client) throw new Error('fixture insert failed');
    await db.insert(schema.familyLinks).values({
      organisationId: orgId,
      applicationId: appId,
      relationship: 'grandmother',
      relativeName: 'Aunty Example',
      community: 'Example Nation',
      notes: 'family note',
      decisionNote: 'link note',
    });
    await db.insert(schema.evidence).values({
      organisationId: orgId,
      applicationId: appId,
      fileName: 'certificate.pdf',
      declaredContentType: 'application/pdf',
      sizeBytes: 1200,
      evidenceKey: `${orgId}/secret-object`,
      createdAt: dueAt,
    });
    await db.insert(schema.applicationNotes).values({
      organisationId: orgId,
      applicationId: appId,
      body: 'staff note about the applicant',
    });
    const [form] = await db
      .insert(schema.forms)
      .values({ organisationId: orgId, title: 'Intake', applicationId: appId })
      .returning({ id: schema.forms.id });
    await db.insert(schema.formResponses).values({
      organisationId: orgId,
      formId: form?.id ?? '',
      answers: { name: 'Pat Smith' },
      respondentName: 'Pat Smith',
      respondentEmail: 'pat@example.test',
      ipAddress: '203.0.113.5',
      submittedAt: dueAt,
    });
    await db.insert(schema.decisions).values({
      organisationId: orgId,
      applicationId: appId,
      proposedOutcome: 'deferred',
      rationale: 'private rationale',
      status: 'proposed',
    });
    await addPolicy(orgId, 'application', 'anonymise');

    await processRetentionSweep({ organisationId: orgId, correlationId: 'cascade' });

    const [link] = await db
      .select()
      .from(schema.familyLinks)
      .where(drizzle.eq(schema.familyLinks.applicationId, appId));
    const [openedLink] = link ? await fields.openFamilyRows(orgId, [link]) : [];
    expect(openedLink?.relativeName).toBe(ANONYMISED_PLACEHOLDER);
    expect(link?.community).toBeNull();
    expect(link?.notes).toBeNull();
    expect(link?.decisionNote).toBeNull();

    const [file] = await db
      .select()
      .from(schema.evidence)
      .where(drizzle.eq(schema.evidence.applicationId, appId));
    expect(file?.fileName).toBe(ANONYMISED_PLACEHOLDER);
    expect(file?.evidenceKey).toBeNull();
    expect(file?.anonymisedAt).toBeInstanceOf(Date);
    expect(deleteAllObjectVersions).toHaveBeenCalledWith({
      bucket: 'blakpath-evidence',
      key: `${orgId}/secret-object`,
    });

    const [note] = await db
      .select()
      .from(schema.applicationNotes)
      .where(drizzle.eq(schema.applicationNotes.applicationId, appId));
    const [openedNote] = note ? await fields.openNoteRows(orgId, [note]) : [];
    expect(openedNote?.body).toBe(ANONYMISED_PLACEHOLDER);

    const [response] = await db
      .select()
      .from(schema.formResponses)
      .where(drizzle.eq(schema.formResponses.formId, form?.id ?? ''));
    const [openedResponse] = response
      ? await fields.openFormResponses(orgId, [response])
      : [];
    expect(openedResponse?.answers).toEqual({});
    expect(response?.respondentName).toBeNull();
    expect(response?.respondentEmail).toBeNull();
    expect(response?.ipAddress).toBeNull();

    const [person] = await db
      .select()
      .from(schema.clients)
      .where(drizzle.eq(schema.clients.id, client.id));
    expect(person?.displayName).toBe(ANONYMISED_PLACEHOLDER);
    expect(person?.contactEmail).toBeNull();
    expect(person?.notes).toBeNull();

    const [decision] = await db
      .select()
      .from(schema.decisions)
      .where(drizzle.eq(schema.decisions.applicationId, appId));
    expect(decision?.rationale).toBeNull();
    expect(decision?.status).toBe('proposed');

    // The old name's blind index must not still find the anonymised matter.
    const { blindIndex } = await import('@/lib/encryption/blind-index');
    const [anonApp] = await db
      .select({ bidx: schema.applications.applicantNameBidx })
      .from(schema.applications)
      .where(drizzle.eq(schema.applications.id, appId));
    expect(anonApp?.bidx).toBe(await blindIndex(orgId, ANONYMISED_PLACEHOLDER));
  });

  it('keeps a held application and its evidence', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    const [appId] = await insertApps(orgId, 'SHIELD', 1, dueAt);
    if (!appId) throw new Error('fixture insert failed');
    await db.insert(schema.evidence).values({
      organisationId: orgId,
      applicationId: appId,
      fileName: 'held.pdf',
      declaredContentType: 'application/pdf',
      sizeBytes: 10,
      evidenceKey: `${orgId}/held-object`,
      createdAt: dueAt,
    });
    await db.insert(schema.legalHolds).values({
      organisationId: orgId,
      resourceType: 'application',
      resourceId: appId,
      reason: 'subpoena',
    });
    await addPolicy(orgId, 'application', 'purge');
    await addPolicy(orgId, 'evidence', 'purge');

    await processRetentionSweep({ organisationId: orgId, correlationId: 'shield' });

    const [app] = await db
      .select()
      .from(schema.applications)
      .where(drizzle.eq(schema.applications.id, appId));
    const [file] = await db
      .select()
      .from(schema.evidence)
      .where(drizzle.eq(schema.evidence.applicationId, appId));
    expect(app?.deletedAt).toBeNull();
    expect(app?.applicantName).toBe('SHIELD 0');
    expect(file?.deletedAt).toBeNull();
    expect(file?.evidenceKey).toBe(`${orgId}/held-object`);
    expect(deleteAllObjectVersions).not.toHaveBeenCalled();
  });

  /**
   * A sent letter as `sendCorrespondence` leaves it: sealed text and recipient,
   * a hashed applicant link that is still live, a sealed delivery copy, and a
   * printed PDF object.
   */
  async function insertSentLetter(
    orgId: string,
    appId: string,
    token: string,
  ): Promise<{ itemId: string; messageId: string }> {
    const { createHash, randomUUID } = await import('node:crypto');
    const messageId = await fields.insertSealedCorrespondence({
      organisationId: orgId,
      recipient: 'pat@example.test',
      subject: 'Update on application',
      textBody: `Read it at https://app.example.test/c/${token}`,
      htmlBody: '<p>Pat Smith</p>',
    });
    const itemId = randomUUID();
    const sealed = await fields.sealCorrespondenceItemText(orgId, itemId, {
      subjectTemplate: 'Letter for {{applicant.name}}',
      bodyTemplate: 'Dear {{applicant.name}}',
      renderedSubject: 'Letter for Pat Smith',
      renderedBody: 'Dear Pat Smith',
      recipientName: 'Pat Smith',
      recipientEmail: 'pat@example.test',
    });
    await db.insert(schema.correspondenceItems).values({
      id: itemId,
      organisationId: orgId,
      applicationId: appId,
      kind: 'general',
      channel: 'letter',
      status: 'sent',
      subjectTemplate: sealed.subjectTemplate ?? '',
      bodyTemplate: sealed.bodyTemplate ?? '',
      renderedSubject: sealed.renderedSubject ?? null,
      renderedBody: sealed.renderedBody ?? null,
      recipientName: sealed.recipientName ?? null,
      recipientEmail: sealed.recipientEmail ?? null,
      messageId,
      portalTokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      portalExpiresAt: new Date(Date.now() + 14 * DAY),
      pdfObjectKey: `${orgId}/correspondence/${itemId}.pdf`,
      sentAt: new Date(),
    });
    return { itemId, messageId };
  }

  async function residue(orgId: string): Promise<number> {
    const { plaintextResidueSql } = await import('@/lib/encryption/verify');
    const rows = (await db.execute(
      drizzle.sql.raw(plaintextResidueSql(orgId)),
    )) as unknown as Array<{ column_name: string; residue: number }>;
    const checked = rows.filter((row) => row.column_name.startsWith('correspondence_'));
    // Every inventoried correspondence column is checked, not an empty set.
    expect(checked.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'correspondence_items.rendered_body',
        'correspondence_items.recipient_email',
        'correspondence_messages.text_body',
        'correspondence_templates.body_template',
      ]),
    );
    return checked.reduce((sum, row) => sum + Number(row.residue), 0);
  }

  it('anonymises letters and their delivery copies and kills the applicant link', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    const [appId] = await insertApps(orgId, 'LETTER', 1, dueAt);
    if (!appId) throw new Error('fixture insert failed');
    const token = `letter-token-${Date.now()}-abcdefghijklmnop`;
    const { itemId, messageId } = await insertSentLetter(orgId, appId, token);
    const { getPublicCorrespondence } = await import('@/domains/correspondence');
    expect(await getPublicCorrespondence(token)).toMatchObject({
      body: 'Dear Pat Smith',
    });
    expect(await residue(orgId)).toBe(0);
    await addPolicy(orgId, 'application', 'anonymise');

    await processRetentionSweep({ organisationId: orgId, correlationId: 'letters' });

    const [item] = await db
      .select()
      .from(schema.correspondenceItems)
      .where(drizzle.eq(schema.correspondenceItems.id, itemId));
    if (!item) throw new Error('letter row missing');
    const [opened] = await fields.openCorrespondenceItemRows(orgId, [item]);
    expect(opened).toMatchObject({
      subjectTemplate: ANONYMISED_PLACEHOLDER,
      bodyTemplate: ANONYMISED_PLACEHOLDER,
      renderedSubject: ANONYMISED_PLACEHOLDER,
      renderedBody: ANONYMISED_PLACEHOLDER,
      recipientName: null,
      recipientEmail: null,
      portalTokenHash: null,
      portalExpiresAt: null,
      pdfObjectKey: null,
    });
    expect(await fields.openCorrespondence(orgId, messageId)).toEqual({
      to: ANONYMISED_PLACEHOLDER,
      subject: ANONYMISED_PLACEHOLDER,
      text: ANONYMISED_PLACEHOLDER,
      html: null,
    });
    expect(await getPublicCorrespondence(token)).toBeNull();
    expect(deleteAllObjectVersions).toHaveBeenCalledWith({
      bucket: 'blakpath-evidence',
      key: `${orgId}/correspondence/${itemId}.pdf`,
    });
    expect(await residue(orgId)).toBe(0);
  });

  it('purges letters with the case: link dead at tombstone, rows gone after grace', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    const [appId] = await insertApps(orgId, 'PURGELETTER', 1, dueAt);
    if (!appId) throw new Error('fixture insert failed');
    const token = `purge-token-${Date.now()}-abcdefghijklmnop`;
    const { itemId, messageId } = await insertSentLetter(orgId, appId, token);
    await addPolicy(orgId, 'application', 'purge');
    const { getPublicCorrespondence } = await import('@/domains/correspondence');

    await processRetentionSweep({ organisationId: orgId, correlationId: 'purge-letter' });
    expect(await getPublicCorrespondence(token)).toBeNull();
    expect(deleteAllObjectVersions).toHaveBeenCalledWith({
      bucket: 'blakpath-evidence',
      key: `${orgId}/correspondence/${itemId}.pdf`,
    });

    // Past the grace period the tombstone is hard-deleted; letters cascade and
    // the sealed delivery copy goes with them.
    const old = new Date(Date.now() - 40 * DAY);
    await db
      .update(schema.applications)
      .set({ deletedAt: old })
      .where(drizzle.eq(schema.applications.id, appId));
    await processRetentionSweep({ organisationId: orgId, correlationId: 'purge-grace' });

    expect(
      await db
        .select({ id: schema.applications.id })
        .from(schema.applications)
        .where(drizzle.eq(schema.applications.id, appId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: schema.correspondenceItems.id })
        .from(schema.correspondenceItems)
        .where(drizzle.eq(schema.correspondenceItems.id, itemId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: schema.correspondenceMessages.id })
        .from(schema.correspondenceMessages)
        .where(drizzle.eq(schema.correspondenceMessages.id, messageId)),
    ).toEqual([]);
  });

  it('refuses decided and certified applications until a signed authority is verified', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    const [decidedId] = await insertApps(orgId, 'DECIDED', 1, dueAt, {
      status: 'decided',
    });
    const [certifiedId] = await insertApps(orgId, 'CERT', 1, dueAt, {
      status: 'submitted',
    });
    if (!decidedId || !certifiedId) throw new Error('fixture insert failed');
    const [decision] = await db
      .insert(schema.decisions)
      .values({
        organisationId: orgId,
        applicationId: certifiedId,
        proposedOutcome: 'confirmed',
        status: 'finalised',
        finalOutcome: 'confirmed',
        rationale: 'human record',
      })
      .returning({ id: schema.decisions.id });
    await db.insert(schema.certificates).values({
      organisationId: orgId,
      applicationId: certifiedId,
      decisionId: decision?.id ?? '',
      reference: `CERT-${certifiedId.slice(0, 8)}`,
      status: 'signed',
      verificationCode: `verify-${certifiedId}`,
    });
    // A reference with no records-manager sign-off is not an authority.
    const policyId = await addPolicy(orgId, 'application', 'purge', {
      disposalAuthorityRef: 'GA39-1.1.1',
      signed: false,
    });

    await processRetentionSweep({
      organisationId: orgId,
      correlationId: 'official-blocked',
    });
    const [blockedAudit] = await db
      .select({
        reason: schema.auditEvents.reason,
        resourceId: schema.auditEvents.resourceId,
      })
      .from(schema.auditEvents)
      .where(
        drizzle.and(
          drizzle.eq(schema.auditEvents.organisationId, orgId),
          drizzle.eq(schema.auditEvents.action, 'retention.purge_blocked'),
        ),
      );
    expect(blockedAudit).toEqual({
      reason: 'retention.purge_blocked.no_signoff',
      resourceId: policyId,
    });

    const blocked = await db
      .select({
        id: schema.applications.id,
        deletedAt: schema.applications.deletedAt,
        applicantName: schema.applications.applicantName,
      })
      .from(schema.applications)
      .where(drizzle.inArray(schema.applications.id, [decidedId, certifiedId]));
    expect(blocked.every((row) => row.deletedAt === null)).toBe(true);
    expect(blocked.map((row) => row.applicantName).sort()).toEqual([
      'CERT 0',
      'DECIDED 0',
    ]);
    const [kept] = await db
      .select({ rationale: schema.decisions.rationale })
      .from(schema.decisions)
      .where(drizzle.eq(schema.decisions.id, decision?.id ?? ''));
    expect(kept?.rationale).toBe('human record');

    // Self-approval is not two-person approval, even with a signed authority.
    await signAuthority(orgId, 'application', 'GA39-1.1.1');
    const [drafter] = await db
      .select({ createdByUserId: schema.retentionPolicies.createdByUserId })
      .from(schema.retentionPolicies)
      .where(drizzle.eq(schema.retentionPolicies.id, policyId));
    await db
      .update(schema.retentionPolicies)
      .set({ approvedByUserId: drafter?.createdByUserId ?? null })
      .where(drizzle.eq(schema.retentionPolicies.id, policyId));
    await processRetentionSweep({
      organisationId: orgId,
      correlationId: 'official-self-approved',
    });
    const stillKept = await db
      .select({ deletedAt: schema.applications.deletedAt })
      .from(schema.applications)
      .where(drizzle.inArray(schema.applications.id, [decidedId, certifiedId]));
    expect(stillKept.every((row) => row.deletedAt === null)).toBe(true);

    const approver = await createUser();
    await db
      .update(schema.retentionPolicies)
      .set({ approvedByUserId: approver })
      .where(drizzle.eq(schema.retentionPolicies.id, policyId));
    await processRetentionSweep({
      organisationId: orgId,
      correlationId: 'official-authorised',
    });

    const disposed = await db
      .select({ deletedAt: schema.applications.deletedAt })
      .from(schema.applications)
      .where(drizzle.inArray(schema.applications.id, [decidedId, certifiedId]));
    expect(disposed.every((row) => row.deletedAt instanceof Date)).toBe(true);
    const register = await db
      .select({
        resourceId: schema.destructionRegister.resourceId,
        authorityReference: schema.destructionRegister.authorityReference,
      })
      .from(schema.destructionRegister)
      .where(drizzle.eq(schema.destructionRegister.organisationId, orgId));
    expect(register.map((row) => row.resourceId).sort()).toEqual(
      [decidedId, certifiedId].sort(),
    );
    expect(register.every((row) => row.authorityReference === 'GA39-1.1.1')).toBe(true);
  });

  it('does not anonymise an official record on a bare authority reference', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    const [decidedId] = await insertApps(orgId, 'BARE', 1, dueAt, { status: 'decided' });
    const [openId] = await insertApps(orgId, 'OPEN', 1, dueAt, { status: 'submitted' });
    if (!decidedId || !openId) throw new Error('fixture insert failed');
    await addPolicy(orgId, 'application', 'anonymise', {
      disposalAuthorityRef: 'GA39-1.1.1',
      signed: false,
    });

    await processRetentionSweep({ organisationId: orgId, correlationId: 'bare-ref' });

    const rows = await db
      .select({
        id: schema.applications.id,
        anonymisedAt: schema.applications.anonymisedAt,
      })
      .from(schema.applications)
      .where(drizzle.inArray(schema.applications.id, [decidedId, openId]));
    const byId = new Map(rows.map((row) => [row.id, row.anonymisedAt]));
    expect(byId.get(decidedId)).toBeNull();
    expect(byId.get(openId)).toBeInstanceOf(Date);
  });

  it('needs a second person to activate a policy and a signed authority to draft a purge', async () => {
    const orgId = await createOrg();
    const drafter = await createUser();
    const approver = await createUser();
    const { createPolicy, activatePolicy } = await import('@/domains/retention/service');
    const { RetentionError } = await import('@/domains/retention/errors');
    const { runWithTenantContext } = await import('@/lib/tenancy/context');
    const ctxFor = (userId: string) => ({
      organisationId: orgId,
      userId,
      membershipId: userId,
      permissions: new Set(['retention:manage']),
      roles: ['records-officer'],
      sessionId: userId,
      correlationId: 'two-person',
      requestId: 'two-person',
    });

    await expect(
      runWithTenantContext(ctxFor(drafter), () =>
        createPolicy({
          resourceType: 'application',
          retentionDays: MIN_RETENTION_DAYS,
          action: 'purge',
          jurisdiction: 'nsw',
          authorityReference: 'GA39-1.1.1',
        }),
      ),
    ).rejects.toBeInstanceOf(RetentionError);

    const draft = await runWithTenantContext(ctxFor(drafter), () =>
      createPolicy({
        resourceType: 'application',
        retentionDays: MIN_RETENTION_DAYS,
        action: 'anonymise',
        jurisdiction: 'nsw',
      }),
    );
    expect(draft.active).toBe(false);
    await expect(
      runWithTenantContext(ctxFor(drafter), () => activatePolicy(draft.id)),
    ).rejects.toThrow();
    const active = await runWithTenantContext(ctxFor(approver), () =>
      activatePolicy(draft.id),
    );
    expect(active.active).toBe(true);
    expect(active.approvedByUserId).toBe(approver);
  });

  it('audits a failed object delete and retries it', async () => {
    const orgId = await createOrg();
    const dueAt = new Date(Date.now() - (MIN_RETENTION_DAYS + 10) * DAY);
    const [appId] = await insertApps(orgId, 'RETRY', 1, dueAt);
    if (!appId) throw new Error('fixture insert failed');
    await db.insert(schema.evidence).values({
      organisationId: orgId,
      applicationId: appId,
      fileName: 'retry.pdf',
      declaredContentType: 'application/pdf',
      sizeBytes: 10,
      evidenceKey: `${orgId}/retry-object`,
      createdAt: dueAt,
    });
    await addPolicy(orgId, 'evidence', 'purge');
    deleteAllObjectVersions.mockRejectedValueOnce(new Error('s3 denied'));

    await processRetentionSweep({ organisationId: orgId, correlationId: 's3-fail' });

    const [first] = await db
      .select({ deletedAt: schema.evidence.deletedAt })
      .from(schema.evidence)
      .where(drizzle.eq(schema.evidence.applicationId, appId));
    expect(first?.deletedAt).toBeNull();
    const [failure] = await db
      .select({ result: schema.auditEvents.result })
      .from(schema.auditEvents)
      .where(
        drizzle.and(
          drizzle.eq(schema.auditEvents.organisationId, orgId),
          drizzle.eq(schema.auditEvents.action, 'retention.record_purged'),
          drizzle.eq(schema.auditEvents.result, 'failure'),
        ),
      );
    expect(failure?.result).toBe('failure');

    deleteAllObjectVersions.mockResolvedValue(undefined);
    await processRetentionSweep({ organisationId: orgId, correlationId: 's3-retry' });

    const [second] = await db
      .select({ deletedAt: schema.evidence.deletedAt })
      .from(schema.evidence)
      .where(drizzle.eq(schema.evidence.applicationId, appId));
    expect(second?.deletedAt).toBeInstanceOf(Date);
    expect(deleteAllObjectVersions).toHaveBeenCalledWith({
      bucket: 'blakpath-evidence',
      key: `${orgId}/retry-object`,
    });
  });

  it('hard-deletes a tombstone after the grace period', async () => {
    const orgId = await createOrg();
    const old = new Date(Date.now() - 40 * DAY);
    const [appId] = await insertApps(orgId, 'GRACE', 1, old, { deletedAt: old });
    if (!appId) throw new Error('fixture insert failed');
    await db.insert(schema.evidence).values({
      organisationId: orgId,
      applicationId: appId,
      fileName: 'old.pdf',
      declaredContentType: 'application/pdf',
      sizeBytes: 10,
      evidenceKey: `${orgId}/grace-object`,
      deletedAt: old,
      createdAt: old,
    });
    await addPolicy(orgId, 'application', 'purge');

    await processRetentionSweep({ organisationId: orgId, correlationId: 'grace' });

    const rows = await db
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(drizzle.eq(schema.applications.id, appId));
    expect(rows).toEqual([]);
    expect(deleteAllObjectVersions).toHaveBeenCalledWith({
      bucket: 'blakpath-evidence',
      key: `${orgId}/grace-object`,
    });
  });

  it('rejects a hold on a missing record and audits policy deletion', async () => {
    const orgId = await createOrg();
    const userId = await createUser();
    const { placeHold, deletePolicy, RetentionTargetError } =
      await import('@/domains/retention/service');
    const { runWithTenantContext } = await import('@/lib/tenancy/context');
    const ctx = {
      organisationId: orgId,
      userId,
      membershipId: userId,
      permissions: new Set(['retention:manage']),
      roles: ['records-officer'],
      sessionId: userId,
      correlationId: 'hold',
      requestId: 'hold',
    };

    await expect(
      runWithTenantContext(ctx, () =>
        placeHold({
          resourceType: 'application',
          resourceId: '018f5b3a-0000-7000-8000-000000000000',
          reason: 'missing matter',
        }),
      ),
    ).rejects.toBeInstanceOf(RetentionTargetError);

    const [appId] = await insertApps(orgId, 'HOLD', 1, new Date());
    const hold = await runWithTenantContext(ctx, () =>
      placeHold({
        resourceType: 'application',
        resourceId: appId ?? '',
        reason: 'real matter',
      }),
    );
    expect(hold.resourceId).toBe(appId);

    await addPolicy(orgId, 'application', 'anonymise');
    const [policy] = await db
      .select({ id: schema.retentionPolicies.id })
      .from(schema.retentionPolicies)
      .where(drizzle.eq(schema.retentionPolicies.organisationId, orgId));
    await runWithTenantContext(ctx, () => deletePolicy(policy?.id ?? ''));
    const [deletedAudit] = await db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(
        drizzle.and(
          drizzle.eq(schema.auditEvents.organisationId, orgId),
          drizzle.eq(schema.auditEvents.action, 'retention.policy_deleted'),
        ),
      );
    expect(deletedAudit?.action).toBe('retention.policy_deleted');
  });
});
