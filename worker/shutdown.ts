import type { Logger } from 'pino';

export interface Deadline {
  clear: () => void;
}

export interface CloseableWorker {
  close: (force?: boolean) => Promise<void>;
}

export interface ShutdownDeps {
  graceMs: number;
  /** When the heartbeat file is already gone, Redis is down: do not wait. */
  heartbeatPresent: boolean;
  /** Cap for queue/redis close on the forced path. Default 5s. */
  forceStepMs?: number;
  workers: readonly CloseableWorker[];
  stopScheduler: () => void;
  stopHeartbeat: () => void;
  closeQueues: () => Promise<void>;
  quitRedis: () => Promise<void>;
  log: Pick<Logger, 'info' | 'error'>;
  exit: (code: number) => void;
  setDeadline: (fire: () => void, ms: number) => Deadline;
}

const DEFAULT_FORCE_STEP_MS = 5_000;

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('shutdown step timed out')), ms);
    timer.unref();
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let shuttingDown = false;

/** Test hook. Production has one process lifetime. */
export function __resetShutdownForTests(): void {
  shuttingDown = false;
}

/**
 * Drain in-flight jobs, then close queues and Redis.
 *
 * A normal stop (heartbeat still fresh) waits for active jobs. A liveness
 * failure has already removed the heartbeat because Redis did not answer, so
 * the close is forced and cannot sit on the grace deadline.
 */
export async function shutdown(
  signal: NodeJS.Signals,
  deps: ShutdownDeps,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  deps.stopHeartbeat();
  deps.log.info({ signal }, 'shutdown requested — draining workers');

  const deadline = deps.setDeadline(() => {
    deps.log.error(
      { graceMs: deps.graceMs },
      'shutdown deadline exceeded — forcing exit',
    );
    deps.exit(1);
  }, deps.graceMs);

  const force = !deps.heartbeatPresent;
  try {
    if (force) {
      deps.log.info('redis heartbeat missing — forcing worker close');
    }
    deps.stopScheduler();
    await Promise.all(
      deps.workers.map((worker) => (force ? worker.close(true) : worker.close())),
    );
    if (force) {
      const stepMs = deps.forceStepMs ?? DEFAULT_FORCE_STEP_MS;
      await withTimeout(deps.closeQueues(), stepMs).catch((err: unknown) => {
        deps.log.error({ err }, 'queue close timed out during forced shutdown');
      });
      await withTimeout(deps.quitRedis(), stepMs).catch((err: unknown) => {
        deps.log.error({ err }, 'redis quit timed out during forced shutdown');
      });
    } else {
      await deps.closeQueues();
      await deps.quitRedis();
    }
    deadline.clear();
    deps.log.info('shutdown complete');
    deps.exit(0);
  } catch (err) {
    deps.log.error({ err }, 'error during shutdown');
    deps.exit(1);
  }
}
