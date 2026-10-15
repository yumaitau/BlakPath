import { beforeEach, describe, expect, it, vi } from 'vitest';
import { script } from './helpers/scripted-db';

/**
 * Overdue evidence sweep: deliver first, then mark the request notified. A
 * failed delivery leaves the request unmarked so the next sweep retries, and
 * the per-recipient dedupe key stops that retry from repeating a notice.
 */

const deps = vi.hoisted(() => ({
  createNotification: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock('@/domains/notifications/service', () => ({
  createNotification: deps.createNotification,
}));
vi.mock('@/db/tenant-db', async () => {
  const { scriptedTenantModule } = await import('./helpers/scripted-db');
  const tenant = scriptedTenantModule('org-1');
  const scope = tenant.currentScope();
  return { ...tenant, scopeFor: () => scope };
});

const { processOverdueEvidenceSweep } = await import('@/domains/notifications/dispatch');

const now = new Date('2026-10-15T00:00:00Z');

function queueSweep(): void {
  script.results.push(
    // Overdue, unmarked request.
    [
      {
        id: 'req-1',
        applicationId: 'app-1',
        requestedByUserId: 'requester',
        status: 'open',
        dueAt: new Date('2026-10-01T00:00:00Z'),
        fulfilledAt: null,
        cancelledAt: null,
        overdueNotifiedAt: null,
      },
    ],
    // Active staff with their grants.
    [
      {
        userId: 'requester',
        permissionKey: 'application:read-any',
        emailNotifications: true,
      },
      {
        userId: 'assignee',
        permissionKey: 'application:read-assigned',
        emailNotifications: false,
      },
    ],
    // Case audience: application row, then active assignments.
    [{ applicantUserId: null, clientId: null, currentAssigneeUserId: 'assignee' }],
    [],
  );
}

beforeEach(() => {
  script.reset();
  deps.createNotification.mockReset();
  deps.createNotification.mockResolvedValue({});
});

describe('processOverdueEvidenceSweep', () => {
  it('leaves the request unmarked when a delivery fails, then marks it after a clean retry', async () => {
    queueSweep();
    deps.createNotification
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('database blip'));
    await expect(
      processOverdueEvidenceSweep({ organisationId: 'org-1', correlationId: 'c-1', now }),
    ).resolves.toEqual({ notified: 0 });
    expect(script.ops).not.toContain('update');

    script.reset();
    queueSweep();
    script.results.push([{ id: 'req-1' }]); // the mark succeeds
    await expect(
      processOverdueEvidenceSweep({ organisationId: 'org-1', correlationId: 'c-2', now }),
    ).resolves.toEqual({ notified: 2 });
    expect(script.ops.at(-1)).toBe('update');

    const keys = deps.createNotification.mock.calls.map(
      (call) => (call as unknown as [{ dedupeKey?: string }])[0].dedupeKey,
    );
    // Both runs used the same per-recipient keys, so the retry cannot duplicate.
    expect(new Set(keys)).toEqual(
      new Set(['evidence-overdue:req-1:assignee', 'evidence-overdue:req-1:requester']),
    );
  });

  it('does not count a request another sweep already marked', async () => {
    queueSweep();
    script.results.push([]); // lost the race to mark it
    await expect(
      processOverdueEvidenceSweep({ organisationId: 'org-1', correlationId: 'c-1', now }),
    ).resolves.toEqual({ notified: 0 });
    expect(deps.createNotification).toHaveBeenCalledTimes(2);
  });
});
