import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { Worker, type ConnectionOptions } from 'bullmq';
import { redis } from '@/lib/redis';
import { captureException } from '@/lib/observability/errors';
import { jobSpanAttributes } from '@/lib/observability/job-span';
import { logger } from '@/lib/observability/logger';
import { recordScanDuration } from '@/lib/observability/metrics';
import {
  shutdown as shutdownOtel,
  start as startOtel,
  telemetryActive,
} from '@/lib/observability/otel';
import { scrubErrorForLog } from '@/lib/observability/scrub';
import { closeQueues, QueueName, type TenantJob } from '@/lib/queues';
import { PROCESSORS, REGISTERED_QUEUES } from './processors';
import { startTenantScheduleSync } from './scheduler';
import { startOperationalMetrics } from './operational-metrics';
import { queueFailureSignal } from './operational-signals';

/**
 * BlakPath background worker bootstrap.
 *
 * Runs one BullMQ Worker per registered queue, delegating to the processor
 * registry. Responsibilities:
 *   - Reuse the shared, validated Redis connection (`@/lib/redis`) — never read
 *     process.env directly, never open a second uncoordinated pool.
 *   - Handle SIGTERM/SIGINT for GRACEFUL SHUTDOWN: stop accepting new jobs, let
 *     in-flight jobs finish (up to a hard deadline), close the queues and the
 *     Redis connection, then exit 0. Docker/Kubernetes send SIGTERM on stop;
 *     without this an in-flight malware scan could be killed mid-flight.
 *
 * Security posture: this process holds privileged infrastructure access. It
 * performs NO identity determination — see `worker/processors.ts`. Every job is
 * tenant-bound (`TenantJob.organisationId`). Full processors (malware scan,
 * certificate/export rendering, email, audit verification, retention, webhooks)
 * land in later phases.
 */

const workerLogger = logger.child({ component: 'worker' });

/**
 * BullMQ accepts a live ioredis instance as its connection at runtime; the
 * shared client is already configured with `maxRetriesPerRequest: null` as
 * BullMQ requires. The cast bridges ioredis's type to BullMQ's ConnectionOptions
 * union without opening a second connection.
 */
const connection = redis as unknown as ConnectionOptions;

/** Maximum time to wait for in-flight jobs on shutdown before forcing exit. */
const SHUTDOWN_GRACE_MS = 25_000;

const tracer = trace.getTracer('blakpath-worker');

const workers: Worker<TenantJob>[] = REGISTERED_QUEUES.map((queueName) => {
  const processor = PROCESSORS[queueName];
  const childLogger = workerLogger.child({ queue: queueName });

  const worker = new Worker<TenantJob>(
    queueName,
    async (job) => {
      const started = performance.now();
      try {
        await tracer.startActiveSpan(
          `process ${queueName}`,
          {
            kind: SpanKind.CONSUMER,
            attributes: jobSpanAttributes(queueName, job),
          },
          async (span) => {
            try {
              await processor(job, childLogger);
              span.setStatus({ code: SpanStatusCode.OK });
            } catch (err) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: scrubErrorForLog(err).message,
              });
              throw err;
            } finally {
              span.end();
            }
          },
        );
      } finally {
        if (queueName === QueueName.MalwareScan) {
          recordScanDuration(performance.now() - started);
        }
      }
    },
    {
      connection,
      prefix: 'bp:queue',
      // Conservative default; per-queue tuning lands with real processors.
      concurrency: 4,
      // Do not autorun until all workers are constructed and listeners wired.
      autorun: false,
    },
  );

  worker.on('failed', (job, err) => {
    const failure = queueFailureSignal(job);
    childLogger.error(
      { jobId: job?.id, ...failure, err: scrubErrorForLog(err) },
      failure.alert ? 'job retries exhausted' : 'job failed; retry scheduled',
    );
  });

  worker.on('completed', (job) => {
    childLogger.debug({ jobId: job.id }, 'job completed');
  });

  worker.on('error', (err) => {
    captureException(err, { route: queueName });
  });

  return worker;
});

let shuttingDown = false;
let stopTenantScheduleSync: (() => void) | null = null;
let stopOperationalMetrics: (() => void) | null = null;

/**
 * Graceful shutdown: close every worker (waits for active jobs to settle),
 * close the queue producers, then close Redis. A hard deadline guards against a
 * stuck job hanging the container forever.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  workerLogger.info({ signal }, 'shutdown requested — draining workers');

  const deadline = setTimeout(() => {
    workerLogger.error(
      { graceMs: SHUTDOWN_GRACE_MS },
      'shutdown deadline exceeded — forcing exit',
    );
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  // Do not keep the event loop alive solely for the deadline timer.
  deadline.unref();

  try {
    stopTenantScheduleSync?.();
    stopOperationalMetrics?.();
    await Promise.all(workers.map((w) => w.close()));
    await shutdownOtel();
    await closeQueues();
    await redis.quit();
    clearTimeout(deadline);
    workerLogger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    workerLogger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  captureException(reason, { route: 'worker' });
});

async function main(): Promise<void> {
  // Tracing and metrics are best-effort. A collector outage must not stop
  // scans, retention or mail. Gauges register only after the SDK is up.
  try {
    await startOtel();
    if (telemetryActive()) stopOperationalMetrics = startOperationalMetrics();
  } catch (err) {
    captureException(err, { route: 'worker' });
  }

  // Create (or update) the durable per-tenant maintenance schedules before
  // accepting jobs. A startup failure is intentional: a worker without its
  // integrity/retention schedules is not healthy enough to serve.
  stopTenantScheduleSync = await startTenantScheduleSync(workerLogger);
  await Promise.all(workers.map((w) => w.run()));
  workerLogger.info({ queues: REGISTERED_QUEUES }, 'blakpath worker started');
}

main().catch((err) => {
  workerLogger.error({ err }, 'worker failed to start');
  process.exit(1);
});
