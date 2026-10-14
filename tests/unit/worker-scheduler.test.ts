import { describe, expect, it, vi } from 'vitest';

// Reconciliation receives queue dependencies directly. Mock the production
// factory and DB module so this unit test cannot open infrastructure clients.
vi.mock('@/lib/queues', () => ({
  QueueName: {
    AuditVerify: 'audit-verify',
    Retention: 'retention',
    Reminder: 'reminder',
    Webhook: 'webhook',
    KeyHealth: 'key-health',
    MalwareScan: 'malware-scan',
  },
  getQueue: vi.fn(),
}));

vi.mock('@/db/client', () => ({ db: {} }));

import { QueueName } from '@/lib/queues';
import { reconcileTenantSchedules, tenantSchedulerId } from '@worker/scheduler';

type Call = {
  id: string;
  every: number;
  name: string;
  organisationId: string;
  platformChain?: boolean;
  attempts?: number;
};

function fakeQueue(existing: string[] = []) {
  const upserts: Call[] = [];
  const removed: string[] = [];
  return {
    upserts,
    removed,
    async upsertJobScheduler(
      id: string,
      repeat: { every: number },
      template: {
        name: string;
        data: { organisationId: string; platformChain?: boolean };
        opts?: { attempts?: number };
      },
    ) {
      upserts.push({
        id,
        every: repeat.every,
        name: template.name,
        organisationId: template.data.organisationId,
        ...(template.data.platformChain ? { platformChain: true } : {}),
        ...(template.opts?.attempts !== undefined
          ? { attempts: template.opts.attempts }
          : {}),
      });
    },
    async getJobSchedulers() {
      return existing.map((id) => ({ id }));
    },
    async removeJobScheduler(id: string) {
      removed.push(id);
      return true;
    },
  };
}

describe('tenant maintenance scheduler', () => {
  it('uses a stable queue- and tenant-bound scheduler id', () => {
    expect(tenantSchedulerId(QueueName.AuditVerify, 'org-a')).toBe(
      'bp:scheduled:audit-verify:org-a',
    );
    expect(tenantSchedulerId(QueueName.Retention, 'org-a')).toBe(
      'bp:scheduled:retention:org-a',
    );
  });

  it('schedules each active tenant once and removes only stale maintenance schedules', async () => {
    const staleAudit = tenantSchedulerId(QueueName.AuditVerify, 'suspended-org');
    const staleRetention = tenantSchedulerId(QueueName.Retention, 'closed-org');
    const auditQueue = fakeQueue([staleAudit, 'other-system-schedule']);
    const retentionQueue = fakeQueue([staleRetention]);

    const report = await reconcileTenantSchedules({
      // Duplicates from a defensive caller cannot create duplicate schedulers.
      organisationIds: ['org-a', 'org-b', 'org-a'],
      auditQueue,
      retentionQueue,
      intervals: { auditVerifyMs: 60_000, retentionSweepMs: 120_000 },
    });

    expect(auditQueue.upserts).toEqual([
      {
        id: tenantSchedulerId(QueueName.AuditVerify, 'org-a'),
        every: 60_000,
        name: 'verify',
        organisationId: 'org-a',
      },
      {
        id: tenantSchedulerId(QueueName.AuditVerify, 'org-b'),
        every: 60_000,
        name: 'verify',
        organisationId: 'org-b',
      },
    ]);
    expect(retentionQueue.upserts.map((call) => call.every)).toEqual([120_000, 120_000]);
    expect(auditQueue.removed).toEqual([staleAudit]);
    expect(retentionQueue.removed).toEqual([staleRetention]);
    expect(report).toEqual({
      auditSchedulers: 2,
      retentionSchedulers: 2,
      reminderSchedulers: 0,
      webhookSweepSchedulers: 0,
      keyHealthSchedulers: 0,
      scanSchedulers: 0,
      removedSchedulers: 2,
    });
  });

  it('schedules reminder sweeps when a reminder queue is supplied', async () => {
    const auditQueue = fakeQueue();
    const retentionQueue = fakeQueue();
    const reminderQueue = fakeQueue();
    const report = await reconcileTenantSchedules({
      organisationIds: ['org-a'],
      auditQueue,
      retentionQueue,
      reminderQueue,
      intervals: { auditVerifyMs: 60_000, retentionSweepMs: 120_000 },
    });
    expect(reminderQueue.upserts).toEqual([
      {
        id: tenantSchedulerId(QueueName.Reminder, 'org-a'),
        every: 900_000,
        name: 'sweep',
        organisationId: 'org-a',
      },
    ]);
    expect(report.reminderSchedulers).toBe(1);
    expect(report.keyHealthSchedulers).toBe(0);
    expect(report.scanSchedulers).toBe(0);
    expect(report.removedSchedulers).toBe(0);
  });

  it('schedules webhook sweeps and removes stale ones when the webhook queue is supplied', async () => {
    const stale = tenantSchedulerId(QueueName.Webhook, 'closed-org');
    const webhookQueue = fakeQueue([stale]);
    const report = await reconcileTenantSchedules({
      organisationIds: ['org-a'],
      auditQueue: fakeQueue(),
      retentionQueue: fakeQueue(),
      webhookQueue,
      intervals: {
        auditVerifyMs: 60_000,
        retentionSweepMs: 120_000,
        webhookSweepMs: 300_000,
      },
    });
    expect(webhookQueue.upserts).toEqual([
      {
        id: tenantSchedulerId(QueueName.Webhook, 'org-a'),
        every: 300_000,
        name: 'sweep',
        organisationId: 'org-a',
        attempts: 3,
      },
    ]);
    expect(webhookQueue.removed).toEqual([stale]);
    expect(report.webhookSweepSchedulers).toBe(1);
    expect(report.removedSchedulers).toBe(1);
  });

  it('schedules the platform chain without dropping tenant schedules', async () => {
    const auditQueue = fakeQueue();
    const retentionQueue = fakeQueue();
    await reconcileTenantSchedules({
      organisationIds: ['org-a'],
      auditQueue,
      retentionQueue,
      includePlatformChain: true,
      intervals: { auditVerifyMs: 86_400_000, retentionSweepMs: 86_400_000 },
    });
    expect(auditQueue.upserts).toEqual([
      {
        id: tenantSchedulerId(QueueName.AuditVerify, 'platform'),
        every: 86_400_000,
        name: 'verify',
        organisationId: 'platform',
        platformChain: true,
      },
      {
        id: tenantSchedulerId(QueueName.AuditVerify, 'org-a'),
        every: 86_400_000,
        name: 'verify',
        organisationId: 'org-a',
      },
    ]);
    expect(auditQueue.removed).toEqual([]);
  });

  it('schedules a key-health check on the configured interval', async () => {
    const auditQueue = fakeQueue();
    const retentionQueue = fakeQueue();
    const keyHealthQueue = fakeQueue();
    const report = await reconcileTenantSchedules({
      organisationIds: ['org-a'],
      auditQueue,
      retentionQueue,
      keyHealthQueue,
      intervals: {
        auditVerifyMs: 60_000,
        retentionSweepMs: 120_000,
        keyHealthMs: 300_000,
      },
    });
    expect(keyHealthQueue.upserts).toEqual([
      {
        id: tenantSchedulerId(QueueName.KeyHealth, 'org-a'),
        every: 300_000,
        name: 'check',
        organisationId: 'org-a',
      },
    ]);
    expect(report.keyHealthSchedulers).toBe(1);
  });

  it('schedules an evidence-scan sweep that does not inherit the long scan retry', async () => {
    const auditQueue = fakeQueue();
    const retentionQueue = fakeQueue();
    const malwareScanQueue = fakeQueue([
      tenantSchedulerId(QueueName.MalwareScan, 'suspended-org'),
    ]);
    const report = await reconcileTenantSchedules({
      organisationIds: ['org-a'],
      auditQueue,
      retentionQueue,
      malwareScanQueue,
      intervals: {
        auditVerifyMs: 60_000,
        retentionSweepMs: 120_000,
        evidenceScanSweepMs: 300_000,
      },
    });
    expect(malwareScanQueue.upserts).toEqual([
      {
        id: tenantSchedulerId(QueueName.MalwareScan, 'org-a'),
        every: 300_000,
        name: 'sweep',
        organisationId: 'org-a',
        attempts: 3,
      },
    ]);
    expect(malwareScanQueue.removed).toEqual([
      tenantSchedulerId(QueueName.MalwareScan, 'suspended-org'),
    ]);
    expect(report.scanSchedulers).toBe(1);
    expect(report.removedSchedulers).toBe(1);
  });
});
