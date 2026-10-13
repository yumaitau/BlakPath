import { Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';
import {
  isSendThrottled,
  THROTTLE_BACKOFF_MS,
  type QueueRateLimit,
} from '@/lib/email/rate-limit';
import type { TenantJob } from '@/lib/queues';
import type { ProcessorFn } from './processors';

/**
 * Build one BullMQ Worker for a queue. Kept separate from the bootstrap (which
 * has process-level side effects) so the pacing behaviour can be exercised
 * against a real Redis in integration tests.
 *
 * With a `limiter`, the queue is paced by BullMQ's Redis-backed rate limiter
 * (shared by every replica). If the sender still reports throttling — e.g. its
 * live quota is lower than configured — the queue pauses and the job is
 * re-queued WITHOUT consuming a retry attempt, so a burst never exhausts into
 * failures.
 */
export function createQueueWorker(options: {
  queueName: string;
  processor: ProcessorFn;
  logger: Logger;
  connection: ConnectionOptions;
  prefix: string;
  concurrency: number;
  limiter?: QueueRateLimit;
  throttleBackoffMs?: number;
  autorun?: boolean;
}): Worker<TenantJob> {
  const { processor, logger, limiter } = options;
  const pauseMs = options.throttleBackoffMs ?? THROTTLE_BACKOFF_MS;

  const worker: Worker<TenantJob> = new Worker<TenantJob>(
    options.queueName,
    async (job) => {
      try {
        await processor(job, logger);
      } catch (err) {
        if (limiter && isSendThrottled(err)) {
          logger.warn({ jobId: job.id, pauseMs }, 'sender throttled — pausing queue');
          await worker.rateLimit(pauseMs);
          throw Worker.RateLimitError();
        }
        throw err;
      }
    },
    {
      connection: options.connection,
      prefix: options.prefix,
      concurrency: options.concurrency,
      ...(limiter ? { limiter } : {}),
      autorun: options.autorun ?? false,
    },
  );
  return worker;
}
