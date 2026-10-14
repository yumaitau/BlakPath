import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';

const state = vi.hoisted(() => ({
  staleRows: [] as Array<{ id: string }>,
  addJob: vi.fn(async (..._args: unknown[]) => 'job-id'),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return { ...actual, lt: vi.fn(actual.lt) };
});

vi.mock('@/lib/queues', () => ({
  QueueName: { Webhook: 'webhook' },
  addJob: state.addJob,
  getQueue: vi.fn(() => {
    throw new Error('unit tests must inject a queue');
  }),
}));

vi.mock('@/db/tenant-db', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy']) chain[method] = () => chain;
  chain.limit = () => Promise.resolve(state.staleRows);
  return { scopeFor: () => ({ db: { select: () => chain } }) };
});

const { lt } = await import('drizzle-orm');
const { webhookDeliveries } = await import('@/db/schema');
const { requeueDelivery, sweepStaleWebhookDeliveries, WEBHOOK_STALE_PENDING_MS } =
  await import('@/domains/webhooks');

function fakeQueue(jobs: Record<string, string>) {
  const removed: string[] = [];
  return {
    removed,
    async getJob(id: string) {
      const jobState = jobs[id];
      if (!jobState) return undefined;
      return {
        getState: async () => jobState,
        remove: async () => {
          removed.push(id);
        },
      };
    },
  };
}

const base = { organisationId: 'org-a', correlationId: 'corr-1' };

beforeEach(() => {
  state.staleRows = [];
  state.addJob.mockClear();
  vi.mocked(lt).mockClear();
});

describe('requeueDelivery', () => {
  it('leaves a live (delayed/active) job alone so it is never duplicated', async () => {
    const queue = fakeQueue({ d1: 'delayed', d2: 'active' });
    await expect(requeueDelivery({ ...base, deliveryId: 'd1' }, queue)).resolves.toBe(
      'in_flight',
    );
    await expect(requeueDelivery({ ...base, deliveryId: 'd2' }, queue)).resolves.toBe(
      'in_flight',
    );
    expect(state.addJob).not.toHaveBeenCalled();
    expect(queue.removed).toEqual([]);
  });

  it('replaces a finished job (BullMQ would otherwise de-duplicate the id)', async () => {
    const queue = fakeQueue({ d1: 'completed' });
    await expect(requeueDelivery({ ...base, deliveryId: 'd1' }, queue)).resolves.toBe(
      'queued',
    );
    expect(queue.removed).toEqual(['d1']);
    expect(state.addJob).toHaveBeenCalledWith(
      'webhook',
      'deliver',
      { organisationId: 'org-a', correlationId: 'corr-1', deliveryId: 'd1' },
      expect.objectContaining({ jobId: 'd1', backoff: { type: 'webhook' } }),
    );
  });

  it('enqueues a delivery whose job was never created', async () => {
    const queue = fakeQueue({});
    await expect(requeueDelivery({ ...base, deliveryId: 'lost' }, queue)).resolves.toBe(
      'queued',
    );
    expect(state.addJob).toHaveBeenCalledOnce();
  });
});

describe('sweepStaleWebhookDeliveries', () => {
  it('re-queues pending deliveries older than 1h that have no live job', async () => {
    const now = new Date('2026-10-14T12:00:00Z');
    state.staleRows = [{ id: 'lost' }, { id: 'backing-off' }, { id: 'failed-job' }];
    const queue = fakeQueue({ 'backing-off': 'delayed', 'failed-job': 'failed' });

    const result = await sweepStaleWebhookDeliveries({ ...base, now, queue });

    expect(result).toEqual({ stale: 3, requeued: 2 });
    expect(state.addJob.mock.calls.map((call) => call[2])).toEqual([
      { organisationId: 'org-a', correlationId: 'corr-1', deliveryId: 'lost' },
      { organisationId: 'org-a', correlationId: 'corr-1', deliveryId: 'failed-job' },
    ]);
    expect(WEBHOOK_STALE_PENDING_MS).toBe(3_600_000);
    expect(lt).toHaveBeenCalledWith(
      webhookDeliveries.updatedAt,
      new Date(now.getTime() - WEBHOOK_STALE_PENDING_MS),
    );
  });

  it('does nothing when no delivery is stale', async () => {
    const result = await sweepStaleWebhookDeliveries({ ...base, queue: fakeQueue({}) });
    expect(result).toEqual({ stale: 0, requeued: 0 });
    expect(state.addJob).not.toHaveBeenCalled();
  });
});
