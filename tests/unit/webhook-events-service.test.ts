import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Service-level wiring: revoking a certificate emits a `certificate.revoked`
 * webhook, and a manual redelivery is permission-checked, race-safe, audited
 * and re-queued.
 */

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  permissions: new Set<string>(),
  audits: [] as Array<Record<string, unknown>>,
  emitted: [] as Array<Record<string, unknown>>,
  requeued: [] as Array<Record<string, unknown>>,
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
  const db = { select: () => chain(), update: () => chain(), insert: () => chain() };
  return {
    currentScope: () => ({ db, where: vi.fn(), assertOwned: <T>(row: T) => row }),
    scopeFor: () => ({ db }),
  };
});

vi.mock('@/db/client', () => ({ db: {} }));

vi.mock('@/lib/tenancy/context', () => ({
  requireTenantContext: () => ({
    organisationId: 'org-a',
    userId: 'staff-a',
    correlationId: 'corr-1',
    permissions: state.permissions,
  }),
}));

vi.mock('@/domains/audit/service', () => ({
  recordAudit: vi.fn(async (input: Record<string, unknown>) => {
    state.audits.push(input);
  }),
}));

vi.mock('@/domains/applications', () => ({ getApplication: vi.fn() }));
vi.mock('@/lib/storage/s3', () => ({
  EVIDENCE_BUCKET: 'bucket',
  objectKey: vi.fn(),
  presignDownload: vi.fn(),
  putObjectBytes: vi.fn(),
}));
vi.mock('@/domains/certificates/render', () => ({ renderCertificatePdf: vi.fn() }));

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
});

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
      [{ id: 'cert-1', status: 'signed', deletedAt: null }],
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
    expect(state.requeued).toEqual([
      { organisationId: 'org-a', deliveryId: 'delivery-1', correlationId: 'corr-1' },
    ]);
  });
});
