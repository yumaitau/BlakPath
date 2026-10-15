import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CERTIFICATE_WORDING } from '@/domains/certificates/template';

/**
 * Template publish writes an immutable version and an audit event.
 * Skipped unless RUN_INTEGRATION=true and a migrated database is available.
 * Re-issue is not covered here: it stores a PDF and needs object storage.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, templates, audit] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/certificates/templates'),
    import('@/db/schema/audit'),
  ]);
  return { ...client, schema, tenancy, templates, auditEvents: audit.auditEvents };
}

integration('certificate template versions', () => {
  let runtime: Awaited<ReturnType<typeof loadRuntime>>;
  let organisationId: string;
  let userId: string;
  let membershipId: string;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationId = randomUUID();
    userId = randomUUID();
    membershipId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await runtime.db.insert(runtime.schema.users).values({
      id: userId,
      name: 'Template Integration',
      email: `template-${suffix}@example.test`,
      emailVerified: true,
    });
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Template Integration Organisation',
      slug: `template-${suffix}`,
      status: 'active',
      abn: '51824753556',
    });
    await runtime.db.insert(runtime.schema.memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: 'active',
    });
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  function context(permissions: string[]) {
    return {
      organisationId,
      userId,
      membershipId,
      permissions: new Set(permissions),
      roles: ['organisation-admin'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
  }

  it('versions a change, ignores an identical publish, and audits both writes', async () => {
    const admin = context(['tenant:configure']);
    const first = await runtime.tenancy.runWithTenantContext(admin, () =>
      runtime.templates.publishCertificateTemplate({
        wording: DEFAULT_CERTIFICATE_WORDING,
        signatoryName: 'Ada Brown',
        signatoryRole: 'Chair',
      }),
    );
    expect(first.unchanged).toBe(false);
    expect(first.template.version).toBe(1);

    const same = await runtime.tenancy.runWithTenantContext(admin, () =>
      runtime.templates.publishCertificateTemplate({
        wording: DEFAULT_CERTIFICATE_WORDING,
        signatoryName: 'Ada Brown',
        signatoryRole: 'Chair',
      }),
    );
    expect(same.unchanged).toBe(true);
    expect(same.template.version).toBe(1);

    const second = await runtime.tenancy.runWithTenantContext(admin, () =>
      runtime.templates.publishCertificateTemplate({
        wording: `${DEFAULT_CERTIFICATE_WORDING} The meeting date is printed separately.`,
        signatoryName: 'Ada Brown',
        signatoryRole: 'Chair',
      }),
    );
    expect(second.unchanged).toBe(false);
    expect(second.template.version).toBe(2);
    expect(second.template.contentHash).not.toBe(first.template.contentHash);

    const rows = await runtime.db
      .select({ version: runtime.schema.certificateTemplates.templateVersion })
      .from(runtime.schema.certificateTemplates)
      .where(eq(runtime.schema.certificateTemplates.organisationId, organisationId))
      .orderBy(desc(runtime.schema.certificateTemplates.templateVersion));
    expect(rows.map((row) => row.version)).toEqual([2, 1]);

    const events = await runtime.db
      .select({ action: runtime.auditEvents.action })
      .from(runtime.auditEvents)
      .where(eq(runtime.auditEvents.organisationId, organisationId));
    expect(
      events.filter((event) => event.action === 'certificate.template_published'),
    ).toHaveLength(2);

    const otherOrg = context(['tenant:configure']);
    otherOrg.organisationId = randomUUID();
    const hidden = await runtime.tenancy.runWithTenantContext(otherOrg, () =>
      runtime.templates.getCertificateTemplate(),
    );
    expect(hidden).toBeNull();
  });
});
