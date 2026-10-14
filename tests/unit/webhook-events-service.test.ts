import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Service-level wiring: revoking or re-issuing a certificate emits a
 * `certificate.revoked` webhook after the commit, and a manual redelivery is
 * permission-checked, race-safe, audited and re-queued.
 */

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  permissions: new Set<string>(),
  audits: [] as Array<Record<string, unknown>>,
  emitted: [] as Array<Record<string, unknown>>,
  requeued: [] as Array<Record<string, unknown>>,
  auditTx: [] as unknown[],
  tx: null as unknown,
  inserted: [] as unknown[],
}));

vi.mock('@/db/tenant-db', () => {
  function chain() {
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'orderBy', 'limit', 'set']) {
      builder[method] = () => builder;
    }
    builder.returning = () => Promise.resolve(state.results.shift() ?? []);
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(state.results.shift() ?? []).then(resolve, reject);
    return builder;
  }
  const db: Record<string, unknown> = {
    select: () => chain(),
    update: () => chain(),
    insert: () => {
      const builder = chain();
      builder.values = (row: unknown) => {
        state.inserted.push(row);
        return builder;
      };
      return builder;
    },
  };
  // A transaction runs its callback against a handle the audit mock can see.
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(state.tx);
  state.tx = db;
  return {
    currentScope: () => ({
      db,
      organisationId: 'org-a',
      where: vi.fn(),
      assertOwned: <T>(row: T) => row,
      insertValues: <T extends object>(row: T) => ({ ...row, organisationId: 'org-a' }),
    }),
    scopeFor: () => ({ db }),
  };
});

vi.mock('@/db/client', () => {
  // Root reads (organisation name and ABN) share the scoped result queue.
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit']) builder[method] = () => builder;
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(state.results.shift() ?? []).then(resolve);
  return { db: { select: () => builder } };
});

vi.mock('@/lib/encryption/tenant-fields', () => ({
  openApplicantName: vi.fn(async (_org: string, _row: string, stored: string) => stored),
}));

vi.mock('@/lib/tenancy/context', () => ({
  requireTenantContext: () => ({
    organisationId: 'org-a',
    userId: 'staff-a',
    correlationId: 'corr-1',
    permissions: state.permissions,
  }),
}));

vi.mock('@/domains/audit/service', () => ({
  recordAudit: vi.fn(async (input: Record<string, unknown>, tx?: unknown) => {
    state.audits.push(input);
    state.auditTx.push(tx);
  }),
}));

vi.mock('@/domains/applications', () => ({ getApplication: vi.fn() }));
vi.mock('@/lib/storage/s3', () => ({
  EVIDENCE_BUCKET: 'bucket',
  getObjectBytes: vi.fn(),
  objectKey: vi.fn((...parts: string[]) => parts.join('/')),
  presignDownload: vi.fn(),
  putObjectBytes: vi.fn(),
}));
vi.mock('@/domains/certificates/render', () => ({
  renderCertificatePdf: vi.fn(async () => Buffer.from('%PDF-draft')),
}));

vi.mock('@/domains/webhooks/requeue', () => ({
  requeueDelivery: vi.fn(async (input: Record<string, unknown>) => {
    state.requeued.push(input);
    return 'queued';
  }),
}));

vi.mock('@/lib/queues', () => ({
  QueueName: { Webhook: 'webhook' },
  addJob: vi.fn(),
  getQueue: vi.fn(),
}));

beforeEach(() => {
  state.results = [];
  state.permissions = new Set();
  state.audits = [];
  state.emitted = [];
  state.requeued = [];
  state.auditTx = [];
  state.inserted = [];
});

/** A signed certificate as the versioned claim read returns it. */
const SIGNED_CERT = {
  id: 'cert-1',
  status: 'signed',
  deletedAt: null,
  versionText: '2026-10-14 00:00:00+00',
};

describe('certificate revocation webhook', () => {
  it('emits certificate.revoked with ids only (never the free-text reason)', async () => {
    const webhooks = await import('@/domains/webhooks');
    const emit = vi
      .spyOn(webhooks, 'emitWebhookEventSafe')
      .mockImplementation(async (input) => {
        state.emitted.push(input as unknown as Record<string, unknown>);
      });
    const { revokeCertificate } = await import('@/domains/certificates/service');
    state.permissions = new Set(['certificate:revoke']);
    const revokedAt = new Date('2026-10-14T00:00:00Z');
    state.results.push(
      [{ ...SIGNED_CERT }],
      [
        {
          id: 'cert-1',
          status: 'revoked',
          reference: 'COA-1',
          applicationId: 'app-1',
          revokedAt,
        },
      ],
    );

    await revokeCertificate('cert-1', { reason: 'Issued in error — sensitive detail' });

    expect(emit).toHaveBeenCalledOnce();
    expect(state.emitted[0]).toEqual({
      organisationId: 'org-a',
      event: 'certificate.revoked',
      payload: {
        certificateId: 'cert-1',
        reference: 'COA-1',
        applicationId: 'app-1',
        revokedAt: revokedAt.toISOString(),
      },
      correlationId: 'corr-1',
    });
    expect(JSON.stringify(state.emitted[0])).not.toContain('sensitive detail');
    expect(webhooks.isWebhookEvent('certificate.revoked')).toBe(true);
    emit.mockRestore();
  });

  it('does not emit when the conditional revoke loses a race', async () => {
    const webhooks = await import('@/domains/webhooks');
    const emit = vi
      .spyOn(webhooks, 'emitWebhookEventSafe')
      .mockImplementation(async () => {});
    const { revokeCertificate } = await import('@/domains/certificates/service');
    state.permissions = new Set(['certificate:revoke']);
    // Read sees a signed row; the versioned update then matches nothing.
    state.results.push([{ ...SIGNED_CERT }], []);

    await expect(
      revokeCertificate('cert-1', { reason: 'Issued in error' }),
    ).rejects.toThrow(/already revoked or changed/);
    expect(emit).not.toHaveBeenCalled();
    expect(state.audits).toEqual([]);
    emit.mockRestore();
  });
});

describe('certificate re-issue', () => {
  const DECISION = {
    id: 'decision-1',
    status: 'finalised',
    finalOutcome: 'confirmed',
    meetingId: null,
    finalisedAt: new Date('2026-10-02T00:00:00Z'),
  };
  const TEMPLATE = {
    id: 'template-1',
    organisationId: 'org-a',
    wording: 'Recorded by the committee in its own words.',
    signatoryName: 'Ada Brown',
    signatoryRole: 'Chair',
    logoObjectKey: null,
    logoContentType: null,
  };
  const SIGNED = {
    ...SIGNED_CERT,
    reference: 'COA-1',
    applicationId: 'app-1',
    decisionId: 'decision-1',
  };

  function queueReads() {
    state.results.push(
      [{ ...SIGNED }],
      [DECISION],
      [{ applicantName: 'Pat Example', intake: {} }],
      [TEMPLATE],
      [{ legalName: 'Example Org', tradingName: null, abn: null }],
      [],
    );
  }

  it('requires both certificate:generate and certificate:revoke', async () => {
    const { reissueCertificate } = await import('@/domains/certificates/service');
    state.permissions = new Set(['certificate:revoke']);
    await expect(reissueCertificate('cert-1')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('revokes, links the replacement, audits in the transaction, then emits', async () => {
    const webhooks = await import('@/domains/webhooks');
    const emit = vi
      .spyOn(webhooks, 'emitWebhookEventSafe')
      .mockImplementation(async (input) => {
        state.emitted.push(input as unknown as Record<string, unknown>);
      });
    const { reissueCertificate } = await import('@/domains/certificates/service');
    state.permissions = new Set(['certificate:generate', 'certificate:revoke']);
    const revokedAt = new Date('2026-10-14T00:00:00Z');
    queueReads();
    state.results.push(
      [{ ...SIGNED, status: 'revoked', revokedAt }],
      [{ id: 'cert-2', status: 'draft', reference: 'COA-2' }],
    );

    const replacement = await reissueCertificate('cert-1');
    expect(replacement).toMatchObject({ id: 'cert-2', status: 'draft' });

    const row = state.inserted[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      status: 'draft',
      supersedesCertificateId: 'cert-1',
      templateId: 'template-1',
      decisionId: 'decision-1',
      organisationId: 'org-a',
    });
    expect(typeof row.holderNameHash).toBe('string');

    expect(state.audits.map((audit) => audit.action)).toEqual([
      'certificate.revoked',
      'certificate.generated',
      'certificate.reissued',
    ]);
    expect(state.auditTx.every((tx) => tx === state.tx)).toBe(true);
    expect(state.audits[0]?.reason).toMatch(/^certificate\.superseded:/);

    expect(emit).toHaveBeenCalledOnce();
    expect(state.emitted[0]).toMatchObject({
      event: 'certificate.revoked',
      payload: {
        certificateId: 'cert-1',
        reference: 'COA-1',
        applicationId: 'app-1',
        revokedAt: revokedAt.toISOString(),
        supersededByCertificateId: row.id,
      },
    });
    expect(JSON.stringify(state.emitted[0])).not.toContain('Pat Example');
    emit.mockRestore();
  });

  it('does not insert or emit when the conditional revoke loses a race', async () => {
    const webhooks = await import('@/domains/webhooks');
    const emit = vi
      .spyOn(webhooks, 'emitWebhookEventSafe')
      .mockImplementation(async () => {});
    const { reissueCertificate } = await import('@/domains/certificates/service');
    state.permissions = new Set(['certificate:generate', 'certificate:revoke']);
    queueReads();
    state.results.push([]);

    await expect(reissueCertificate('cert-1')).rejects.toThrow(
      /already revoked or changed/,
    );
    expect(state.inserted).toEqual([]);
    expect(state.audits).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    emit.mockRestore();
  });

  it('refuses a certificate that is not signed', async () => {
    const { reissueCertificate } = await import('@/domains/certificates/service');
    state.permissions = new Set(['certificate:generate', 'certificate:revoke']);
    state.results.push([{ ...SIGNED, status: 'draft' }]);
    await expect(reissueCertificate('cert-1')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('requires a published template', async () => {
    const { reissueCertificate } = await import('@/domains/certificates/service');
    state.permissions = new Set(['certificate:generate', 'certificate:revoke']);
    state.results.push(
      [{ ...SIGNED }],
      [DECISION],
      [{ applicantName: 'Pat Example', intake: {} }],
      [],
    );
    await expect(reissueCertificate('cert-1')).rejects.toMatchObject({
      name: 'CertificateTemplateRequiredError',
    });
  });
});

describe('redeliverDelivery', () => {
  it('requires tenant:configure', async () => {
    const { redeliverDelivery } = await import('@/domains/webhooks');
    await expect(redeliverDelivery('endpoint-1', 'delivery-1')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(state.requeued).toEqual([]);
  });

  it('refuses a delivery that is still pending (or not on this endpoint)', async () => {
    const { redeliverDelivery } = await import('@/domains/webhooks');
    state.permissions = new Set(['tenant:configure']);
    state.results.push([{ id: 'endpoint-1' }], []);
    await expect(redeliverDelivery('endpoint-1', 'delivery-1')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(state.audits).toEqual([]);
    expect(state.requeued).toEqual([]);
  });

  it('refuses when the endpoint is inactive or belongs to another tenant', async () => {
    const { redeliverDelivery } = await import('@/domains/webhooks');
    state.permissions = new Set(['tenant:configure']);
    state.results.push([]);
    await expect(redeliverDelivery('endpoint-x', 'delivery-1')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('resets, audits and re-queues a settled delivery', async () => {
    const { redeliverDelivery } = await import('@/domains/webhooks');
    state.permissions = new Set(['tenant:configure']);
    state.results.push(
      [{ id: 'endpoint-1' }],
      [
        {
          id: 'delivery-1',
          status: 'pending',
          attempts: 0,
          event: 'certificate.revoked',
        },
      ],
    );

    const row = await redeliverDelivery('endpoint-1', 'delivery-1');

    expect(row.status).toBe('pending');
    expect(state.audits).toEqual([
      expect.objectContaining({
        action: 'integration.redelivery_requested',
        resourceType: 'integration',
        resourceId: 'endpoint-1',
        result: 'success',
      }),
    ]);
    // The audit joins the reset's transaction.
    expect(state.auditTx).toEqual([state.tx]);
    expect(state.tx).not.toBeNull();
    expect(state.requeued).toEqual([
      { organisationId: 'org-a', deliveryId: 'delivery-1', correlationId: 'corr-1' },
    ]);
  });
});
