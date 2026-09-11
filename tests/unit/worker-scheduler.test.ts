import { describe, expect, it, vi } from 'vitest';

// Reconciliation receives queue dependencies directly. Mock the production
// factory and DB module so this unit test cannot open infrastructure clients.
vi.mock('@/lib/queues', () => ({
  QueueName: {
    AuditVerify: 'audit-verify',
    Retention: 'retention',
    Reminder: 'reminder',
  },
  getQueue: vi.fn(),
}));

vi.mock('@/db/client', () => ({ db: {} }));

import { QueueName } from '@/lib/queues';
import { reconcileTenantSchedules, tenantSchedulerId } from '@worker/scheduler';

type Call = { id: string; every: number; name: string; organisationId: string };

function fakeQueue(existing: string[] = []) {
  const upserts: Call[] = [];
  const removed: string[] = [];
  return {
    upserts,
    removed,
    async upsertJobScheduler(
      id: string,
      repeat: { every: number },
      template: { name: string; data: { organisationId: string } },
    ) {
      upserts.push({
        id,
        every: repeat.every,
        name: template.name,
        organisationId: template.data.organisationId,
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
    expect(report.removedSchedulers).toBe(0);
  });
});
