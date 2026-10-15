import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionOptions, Job, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * 500-invitation burst against a real Redis: the paced mail queue drains with
 * NO throttling failures. A fake sender enforces a per-second quota and throws
 * the SES throttling error when it is exceeded; jobs get a single attempt, so
 * any throttled send would surface as a failed job.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

function fakeSender(quotaPerSecond: number) {
  const sentAt: number[] = [];
  let throttled = 0;
  return {
    get throttled() {
      return throttled;
    },
    get sent() {
      return sentAt.length;
    },
    async send(): Promise<void> {
      const now = Date.now();
      const inWindow = sentAt.filter((t) => now - t < 1_000).length;
      if (inWindow >= quotaPerSecond) {
        throttled += 1;
        throw Object.assign(new Error('Maximum sending rate exceeded.'), {
          name: 'TooManyRequestsException',
        });
      }
      sentAt.push(now);
    },
  };
}

integration('email burst pacing', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function run(input: {
    jobs: number;
    senderQuota: number;
    configuredQuota: number;
    throttleBackoffMs?: number;
  }) {
    const [{ Queue }, { Redis: IORedis }, { pino }, { createQueueWorker }, rate] =
      await Promise.all([
        import('bullmq'),
        import('ioredis'),
        import('pino'),
        import('@worker/queue-worker'),
        import('@/lib/email/rate-limit'),
      ]);
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const redis: Redis = new IORedis(url, { maxRetriesPerRequest: null });
    const connection = redis as unknown as ConnectionOptions;
    const queueName = `email-burst-${randomUUID()}`;
    const prefix = 'bp:test';
    const queue: Queue = new Queue(queueName, { connection, prefix });
    const sender = fakeSender(input.senderQuota);

    const worker: Worker = createQueueWorker({
      queueName,
      processor: async (_job: Job) => sender.send(),
      logger: pino({ level: 'silent' }),
      connection,
      prefix,
      concurrency: 4,
      limiter: rate.emailQueueRateLimits(input.configuredQuota).email,
      ...(input.throttleBackoffMs ? { throttleBackoffMs: input.throttleBackoffMs } : {}),
    });
    let completed = 0;
    let failed = 0;
    const done = new Promise<void>((resolve) => {
      const check = () => {
        if (completed + failed >= input.jobs) resolve();
      };
      worker.on('completed', () => {
        completed += 1;
        check();
      });
      worker.on('failed', () => {
        failed += 1;
        check();
      });
    });
    close = async () => {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await redis.quit();
    };

    await queue.addBulk(
      Array.from({ length: input.jobs }, (_, i) => ({
        name: 'send',
        data: { organisationId: 'org', correlationId: `c-${i}` },
        opts: { attempts: 1 },
      })),
    );
    void worker.run();
    await done;
    return { completed, failed, sender };
  }

  it('drains 500 invitations at the configured quota with zero throttling', async () => {
    const { completed, failed, sender } = await run({
      jobs: 500,
      senderQuota: 100,
      configuredQuota: 100,
      throttleBackoffMs: 500,
    });
    expect(failed).toBe(0);
    expect(completed).toBe(500);
    expect(sender.sent).toBe(500);
    // The limiter keeps sends near 60/s. BullMQ windows are fixed, so under a
    // stalled event loop a handful of sends can brush the sender's sliding
    // window; those are re-queued (never failed), so only a few may appear.
    expect(sender.throttled).toBeLessThan(25);
  }, 60_000);

  it('re-queues sender-throttled sends without failing them when the live quota is lower', async () => {
    const { completed, failed, sender } = await run({
      jobs: 120,
      senderQuota: 20,
      configuredQuota: 100,
      throttleBackoffMs: 300,
    });
    expect(sender.throttled).toBeGreaterThan(0);
    expect(failed).toBe(0);
    expect(completed).toBe(120);
    expect(sender.sent).toBe(120);
  }, 60_000);
});
