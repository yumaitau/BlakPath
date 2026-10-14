import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * "Your keys" against a migrated PostgreSQL database, one organisation per
 * custody mode. Key calls use the local provider (no KMS in CI). Gated like the
 * other integration suites.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, keys] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/organisation-keys'),
  ]);
  return { ...client, schema, tenancy, keys };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type TenantContext = Parameters<Runtime['tenancy']['runWithTenantContext']>[0];

const MODES = ['blakpath_managed', 'client_owned', 'client_owned_escrow'] as const;

const ARN_FOR: Record<(typeof MODES)[number], string> = {
  blakpath_managed:
    'arn:aws:kms:ap-southeast-2:111111111111:key/aaaaaaaa-0000-4000-8000-000000000001',
  client_owned:
    'arn:aws:kms:ap-southeast-2:222222222222:key/bbbbbbbb-0000-4000-8000-000000000002',
  client_owned_escrow:
    'arn:aws:kms:ap-southeast-2:333333333333:key/cccccccc-0000-4000-8000-000000000003',
};

integration('key custody settings per custody mode', () => {
  let runtime: Runtime;
  let userId: string;
  const orgFor = new Map<(typeof MODES)[number], string>();

  function adminContext(organisationId: string): TenantContext {
    return {
      organisationId,
      userId,
      membershipId: randomUUID(),
      permissions: new Set(['tenant:configure']),
      roles: ['organisation-admin'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
  }

  beforeAll(async () => {
    runtime = await loadRuntime();
    userId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await runtime.db.insert(runtime.schema.users).values({
      id: userId,
      name: 'Key Custody Administrator',
      email: `key-admin-${suffix}@example.test`,
      emailVerified: true,
    });
    for (const mode of MODES) {
      const id = randomUUID();
      orgFor.set(mode, id);
      await runtime.db.insert(runtime.schema.organisations).values({
        id,
        legalName: `Key custody ${mode}`,
        slug: `key-custody-${mode.replace(/_/g, '-')}-${suffix}`,
        status: 'active',
      });
      await runtime.keys.registerOrganisationKey({
        organisationId: id,
        custodyMode: mode,
        kmsKeyArn: ARN_FOR[mode],
      });
      await runtime.keys.validateOrganisationKey(id, ARN_FOR[mode]);
    }
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  it.each(MODES)('shows live status for a %s key and audits the view', async (mode) => {
    const organisationId = orgFor.get(mode) as string;
    const ctx = adminContext(organisationId);

    const outcome = await runtime.tenancy.runWithTenantContext(ctx, () =>
      runtime.keys.runKeyHealthCheck(),
    );
    expect(outcome).toMatchObject({ ok: true, restored: false });

    const overview = await runtime.tenancy.runWithTenantContext(ctx, () =>
      runtime.keys.getKeyCustodyOverview(),
    );
    expect(overview).toMatchObject({
      organisationId,
      custodyMode: mode,
      kmsKeyArn: ARN_FOR[mode],
      status: 'active',
      escrow: { enrolled: mode === 'client_owned_escrow' },
      cloudTrail: { clientCanQuery: mode !== 'blakpath_managed' },
      lastHealthCheck: { ok: true },
    });
    expect(overview?.history.map((entry) => entry.summary)).toEqual([
      'Health check passed',
      'Key validated',
      'Key registered',
    ]);
    expect(overview?.history[0]?.actor).toBe('Key Custody Administrator');

    const { auditEvents } = runtime.schema;
    const { and, eq } = await import('drizzle-orm');
    const views = await runtime.db
      .select({ actor: auditEvents.actorUserId, result: auditEvents.result })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, organisationId),
          eq(auditEvents.action, 'key.viewed'),
        ),
      );
    expect(views).toEqual([{ actor: userId, result: 'success' }]);
  });

  it('restores an unavailable key after a passing check, with every step audited', async () => {
    const organisationId = orgFor.get('client_owned') as string;
    const ctx = adminContext(organisationId);
    await runtime.keys.markOrganisationKeyUnavailable(
      organisationId,
      'DisabledException',
    );

    const locked = await runtime.tenancy.runWithTenantContext(ctx, () =>
      runtime.keys.getKeyCustodyOverview(),
    );
    expect(locked?.status).toBe('unavailable');

    const outcome = await runtime.tenancy.runWithTenantContext(ctx, () =>
      runtime.keys.runKeyHealthCheck({ restore: true }),
    );
    expect(outcome).toMatchObject({ ok: true, restored: true });

    const after = await runtime.tenancy.runWithTenantContext(ctx, () =>
      runtime.keys.getKeyCustodyOverview(),
    );
    expect(after?.status).toBe('active');
    expect(after?.history.slice(0, 3).map((entry) => entry.summary)).toEqual([
      'Status changed to active',
      'Health check passed',
      'KMS refused the key',
    ]);
  });

  it('keeps each administrator on their own organisation key', async () => {
    const managed = orgFor.get('blakpath_managed') as string;
    const overview = await runtime.tenancy.runWithTenantContext(
      adminContext(managed),
      () => runtime.keys.getKeyCustodyOverview(),
    );
    expect(overview?.kmsKeyArn).toBe(ARN_FOR.blakpath_managed);
    expect(overview?.history.every((entry) => entry.keyVersion === 1)).toBe(true);
  });
});
