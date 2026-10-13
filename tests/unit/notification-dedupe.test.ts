import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Producer idempotency for notifications. A reminder sweep that crashes after
 * notifying some attendees re-runs with the same dedupe keys; the second run
 * must neither create a second row nor schedule a second delivery job.
 *
 * The fake database models the unique (organisation_id, dedupe_key) index and
 * the fake queue models BullMQ's stable-job-id de-duplication.
 */

interface FakeRow {
  id: string;
  organisationId: string;
  userId: string;
  dedupeKey: string | null;
  emailedAt: Date | null;
}

const state = vi.hoisted(() => ({
  rows: [] as FakeRow[],
  jobIds: new Set<string>(),
  addJob: vi.fn(),
  lastLookupKey: null as string | null,
}));

vi.mock('@/db/tenant-db', () => {
  const db = {
    insert: () => ({
      values: (values: FakeRow) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const clash =
              values.dedupeKey !== null &&
              state.rows.some(
                (r) =>
                  r.organisationId === values.organisationId &&
                  r.dedupeKey === values.dedupeKey,
              );
            if (clash) return [];
            const row = { ...values, emailedAt: null };
            state.rows.push(row);
            return [row];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            state.rows.filter((r) => r.dedupeKey === state.lastLookupKey).slice(0, 1),
        }),
      }),
    }),
  };
  return {
    scopeFor: (organisationId: string) => ({
      organisationId,
      db,
      insertValues: <T extends object>(values: T) => ({ ...values, organisationId }),
    }),
    currentScope: vi.fn(),
  };
});

vi.mock('@/lib/tenancy/context', () => ({ requireTenantContext: vi.fn() }));

vi.mock('@/lib/queues', () => ({
  QueueName: { Notification: 'notification' },
  addJob: (...args: unknown[]) => {
    state.addJob(...args);
    const options = args[3] as { jobId: string };
    state.jobIds.add(options.jobId);
    return Promise.resolve(options.jobId);
  },
}));

const { createNotification } = await import('@/domains/notifications');

function notify(userId: string, dedupeKey?: string) {
  state.lastLookupKey = dedupeKey ?? null;
  return createNotification(
    {
      organisationId: 'org-a',
      userId,
      type: 'calendar-reminder',
      title: 'Reminder',
      ...(dedupeKey ? { dedupeKey } : {}),
    },
    'corr-1',
  );
}

beforeEach(() => {
  state.rows.length = 0;
  state.jobIds.clear();
  state.addJob.mockClear();
});

describe('createNotification dedupe', () => {
  it('returns the existing row and re-offers the SAME job on a retried producer', async () => {
    const first = await notify('user-1', 'calendar-reminder:r1:user-1');
    const again = await notify('user-1', 'calendar-reminder:r1:user-1');

    expect(again.id).toBe(first.id);
    expect(state.rows).toHaveLength(1);
    // Two offers, one distinct job id: BullMQ keeps a single delivery.
    expect(state.addJob).toHaveBeenCalledTimes(2);
    expect(state.jobIds).toEqual(new Set([first.id]));
  });

  it('does not re-offer delivery once the existing row was emailed', async () => {
    const first = await notify('user-1', 'calendar-reminder:r1:user-1');
    state.rows[0]!.emailedAt = new Date();
    state.addJob.mockClear();

    const again = await notify('user-1', 'calendar-reminder:r1:user-1');
    expect(again.id).toBe(first.id);
    expect(state.addJob).not.toHaveBeenCalled();
  });

  it('keeps per-user keys distinct and leaves un-keyed notifications alone', async () => {
    await notify('user-1', 'calendar-reminder:r1:user-1');
    await notify('user-2', 'calendar-reminder:r1:user-2');
    await notify('user-3');
    await notify('user-3');
    expect(state.rows).toHaveLength(4);
    expect(state.jobIds.size).toBe(4);
  });
});
