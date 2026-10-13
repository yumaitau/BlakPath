import { Worker, type ConnectionOptions } from 'bullmq';
import { env } from '@/lib/env';
import { pingRedis, redis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';
import { closeQueues, QUEUE_PREFIX, type TenantJob } from '@/lib/queues';
import { clearHeartbeat, heartbeatExists, recordHeartbeat } from './heartbeat';
import { queueFailureSignal } from './operational-signals';
import { PROCESSORS, REGISTERED_QUEUES } from './processors';
import { HEARTBEAT_INTERVAL_MS, SHUTDOWN_GRACE_MS } from './runtime';
import { startTenantScheduleSync } from './scheduler';
import { shutdown } from './shutdown';

/**
 * BlakPath background worker bootstrap.
 *
 * Runs one BullMQ Worker per registered queue, delegating to the processor
 * registry. Responsibilities:
 *   - Reuse the shared, validated Redis connection (`@/lib/redis`) — never read
 *     process.env directly, never open a second uncoordinated pool.
 *   - Handle SIGTERM/SIGINT for GRACEFUL SHUTDOWN: stop accepting new jobs, let
 *     in-flight jobs finish (up to a hard deadline), close the queues and the
 *     Redis connection, then exit 0. tini is PID 1 in the image and forwards
 *     SIGTERM; the pod must not override the container command.
 *   - Rewrite a heartbeat file after each successful Redis ping. The liveness
 *     probe fails when the file is missing, which is how a lost Redis
 *     connection restarts the pod.
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

const workers: Worker<TenantJob>[] = REGISTERED_QUEUES.map((queueName) => {
  const processor = PROCESSORS[queueName];
  const childLogger = workerLogger.child({ queue: queueName });

  const worker = new Worker<TenantJob>(
    queueName,
    async (job) => processor(job, childLogger),
    {
      connection,
      prefix: QUEUE_PREFIX,
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

let stopTenantScheduleSync: (() => void) | null = null;
let stopHeartbeat: (() => void) | null = null;

function armDeadline(fire: () => void, ms: number): { clear: () => void } {
  const timer = setTimeout(fire, ms);
  // Do not keep the event loop alive solely for the deadline timer.
  timer.unref();
  return { clear: () => clearTimeout(timer) };
}

process.on('SIGTERM', () => void onSignal('SIGTERM'));
process.on('SIGINT', () => void onSignal('SIGINT'));

async function onSignal(signal: NodeJS.Signals): Promise<void> {
  const heartbeatPresent = await heartbeatExists(env.WORKER_HEARTBEAT_PATH);
  await shutdown(signal, {
    graceMs: SHUTDOWN_GRACE_MS,
    heartbeatPresent,
    workers,
    stopScheduler: () => stopTenantScheduleSync?.(),
    stopHeartbeat: () => stopHeartbeat?.(),
    closeQueues,
    quitRedis: async () => {
      await redis.quit();
    },
    log: workerLogger,
    exit: (code) => process.exit(code),
    setDeadline: armDeadline,
  });
}

function startHeartbeat(): () => void {
  const path = env.WORKER_HEARTBEAT_PATH;
  let stopped = false;

  async function beat(): Promise<void> {
    if (stopped) return;
    try {
      const reachable = await pingRedis();
      const fresh = await recordHeartbeat(path, reachable);
      if (!fresh) {
        workerLogger.error('redis unreachable — withholding heartbeat');
      }
    } catch (err) {
      workerLogger.error({ err }, 'heartbeat update failed');
      await clearHeartbeat(path).catch(() => undefined);
    }
  }

  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  timer.unref();
  void beat();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

process.on('unhandledRejection', (reason) => {
  workerLogger.error({ err: reason }, 'unhandled rejection');
});

async function main(): Promise<void> {
  // Heartbeat starts first so a Redis outage fails the probe even if schedule
  // sync is still running. A missing file is what the liveness script checks.
  stopHeartbeat = startHeartbeat();
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
