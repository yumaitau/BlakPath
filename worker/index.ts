import { Worker, type ConnectionOptions } from 'bullmq';
import { getOrganisationKey } from '@/domains/organisation-keys/service';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';
import { closeAuthEmailQueue } from '@/lib/auth/reset-queue';
import { closeQueues, type TenantJob } from '@/lib/queues';
import { startKeyHealthLoop } from './key-health-loop';
import { PROCESSORS, REGISTERED_QUEUES } from './processors';
import { queueFailureSignal } from './operational-signals';
import { startSignatureAgeMonitor } from './signature-age-monitor';
import { startAuthEmailWorker } from './auth-email';
import { startTenantScheduleSync } from './scheduler';
import { rememberPausedJob } from './tenant-pause-ledger';
import { applyTenantJobGate, tenantKeyPauseSignal } from './tenant-key-gate';

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

const workers: Worker<TenantJob>[] = REGISTERED_QUEUES.map((queueName) => {
  const processor = PROCESSORS[queueName];
  const childLogger = workerLogger.child({ queue: queueName });

  const worker = new Worker<TenantJob>(
    queueName,
    async (job, token) => {
      const row = await getOrganisationKey(job.data.organisationId);
      const outcome = await applyTenantJobGate({
        status: row?.status ?? null,
        moveToDelayed: async (timestamp) => {
          if (!token) throw new Error('tenant key pause requires the BullMQ lock token');
          await job.moveToDelayed(timestamp, token);
          if (job.id)
            rememberPausedJob(job.data.organisationId, `${queueName}:${job.id}`);
        },
      });
      if (outcome === 'paused') throw tenantKeyPauseSignal();
      return processor(job, childLogger);
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
      { jobId: job?.id, ...failure, err },
      failure.alert ? 'job retries exhausted' : 'job failed; retry scheduled',
    );
  });

  worker.on('completed', (job) => {
    childLogger.debug({ jobId: job.id }, 'job completed');
  });

  worker.on('error', (err) => {
    childLogger.error({ err }, 'worker error');
  });

  return worker;
});

let shuttingDown = false;
let stopTenantScheduleSync: (() => void) | null = null;
let stopSignatureAgeMonitor: (() => void) | null = null;
const authEmailWorker = startAuthEmailWorker(connection, workerLogger);
let stopKeyHealth: (() => void) | null = null;

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
    stopSignatureAgeMonitor?.();
    stopTenantScheduleSync?.();
    stopKeyHealth?.();
    await Promise.all([authEmailWorker.close(), ...workers.map((w) => w.close())]);
    await closeQueues();
    await closeAuthEmailQueue();
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
  workerLogger.error({ err: reason }, 'unhandled rejection');
});

async function main(): Promise<void> {
  stopSignatureAgeMonitor = startSignatureAgeMonitor(workerLogger);
  // Create (or update) the durable per-tenant maintenance schedules before
  // accepting jobs. A startup failure is intentional: a worker without its
  // integrity/retention schedules is not healthy enough to serve.
  stopTenantScheduleSync = await startTenantScheduleSync(workerLogger);
  stopKeyHealth = startKeyHealthLoop(workerLogger);
  await Promise.all([authEmailWorker.run(), ...workers.map((w) => w.run())]);
  workerLogger.info(
    { queues: [...REGISTERED_QUEUES, 'auth-email'] },
    'blakpath worker started',
  );
}

main().catch((err) => {
  workerLogger.error({ err }, 'worker failed to start');
  process.exit(1);
});
