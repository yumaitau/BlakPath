import { afterEach, describe, expect, it, vi } from 'vitest';

const { recordAudit, createNotification } = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('@/domains/audit/service', () => ({
  recordAudit: (...args: unknown[]) => recordAudit(...args),
}));

vi.mock('@/domains/notifications', () => ({
  createNotification: (...args: unknown[]) => createNotification(...args),
}));

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const GRANT_ID = '00000000-0000-4000-8000-000000000002';

vi.mock('@/db/client', () => {
  const grant = {
    id: '00000000-0000-4000-8000-000000000002',
    organisationId: '00000000-0000-4000-8000-000000000001',
    supportCaseRef: 'SUP-LOG',
    status: 'requested',
  };
  const database: Record<string, unknown> = {
    // assertNoOverdueReview: no overdue rows.
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    // approverUserIds: one approver.
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({ where: async () => [{ userId: 'approver-1' }] }),
        }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [grant] }) }),
    transaction: (fn: (tx: unknown) => unknown) => fn(database),
  };
  return { db: database };
});

import { BreakGlassNotifyError, requestBreakGlass } from '@/domains/break-glass';
import { logger } from '@/lib/observability/logger';

describe('break-glass notification failure log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    recordAudit.mockReset();
    createNotification.mockReset();
  });

  it('logs a sanitised summary, not the raw error or its message', async () => {
    const secret = 'jane.citizen@example.test failed insert params: [Jane Citizen]';
    const failure = Object.assign(new Error(secret), {
      code: 'NOTIFY_DOWN',
      params: ['Jane Citizen'],
    });
    createNotification.mockRejectedValue(failure);
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(
      requestBreakGlass({
        requestedByUserId: 'operator-1',
        correlationId: 'corr-1',
        input: {
          organisationId: ORG_ID,
          supportCaseRef: 'SUP-LOG',
          purpose: 'Check a stuck upload',
          scope: 'Read application status',
        },
      }),
    ).rejects.toBeInstanceOf(BreakGlassNotifyError);

    expect(spy).toHaveBeenCalledTimes(1);
    const [record, message] = spy.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('break-glass request notification failed');
    expect(record.requestId).toBe(GRANT_ID);
    expect(record.err).not.toBe(failure);
    expect(record.err).not.toBeInstanceOf(Error);
    expect(record.err).toMatchObject({ name: 'Error', code: 'NOTIFY_DOWN' });
    expect(record.err).not.toHaveProperty('message');
    expect(record.err).not.toHaveProperty('params');
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain('jane.citizen');
    expect(serialised).not.toContain('Jane Citizen');
  });
});
