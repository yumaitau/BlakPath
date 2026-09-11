import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db } from '@/db/client';
import { organisations } from '@/db/schema';
import { env } from '@/lib/env';
import { getQueue, QueueName, type TenantJob } from '@/lib/queues';

/**
 * Tenant maintenance schedules.
 *
 * BullMQ Job Schedulers are durable Redis-side job factories. Unlike an
 * in-process timer, the next scheduled run survives a worker restart and is
 * only emitted once even when multiple workers begin at the same time. We
 * reconcile the scheduler ids against the active-organisation list so a
 * suspended or closed organisation cannot keep receiving maintenance jobs.
 */

const SCHEDULER_PREFIX = 'bp:scheduled:';
const PAGE_SIZE = 100;

type ScheduledQueue = {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data: TenantJob },
  ): Promise<unknown>;
  getJobSchedulers(
    start?: number,
    end?: number,
    asc?: boolean,
  ): Promise<Array<{ id?: string | null }>>;
  removeJobScheduler(id: string): Promise<boolean>;
};

export interface SchedulerIntervals {
  auditVerifyMs: number;
  retentionSweepMs: number;
  reminderSweepMs?: number;
}

export interface ReconcileSchedulesInput {
  organisationIds: readonly string[];
  auditQueue: ScheduledQueue;
  retentionQueue: ScheduledQueue;
  reminderQueue?: ScheduledQueue;
  intervals: SchedulerIntervals;
}

export interface ReconcileSchedulesResult {
  auditSchedulers: number;
  retentionSchedulers: number;
  reminderSchedulers: number;
  removedSchedulers: number;
}

/** Stable, namespaced scheduler id for one queue and one tenant. */
export function tenantSchedulerId(queueName: QueueName, organisationId: string): string {
  return `${SCHEDULER_PREFIX}${queueName}:${organisationId}`;
}

function isOurScheduler(id: string, queueName: QueueName): boolean {
  return id.startsWith(`${SCHEDULER_PREFIX}${queueName}:`);
}

async function allSchedulers(
  queue: ScheduledQueue,
): Promise<Array<{ id?: string | null }>> {
  const schedulers: Array<{ id?: string | null }> = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const page = await queue.getJobSchedulers(start, start + PAGE_SIZE - 1, true);
    schedulers.push(...page);
    if (page.length < PAGE_SIZE) return schedulers;
  }
}

async function reconcileQueue(
  queue: ScheduledQueue,
  queueName: QueueName,
  organisationIds: readonly string[],
  every: number,
): Promise<number> {
  const wanted = new Set(
    organisationIds.map((organisationId) => tenantSchedulerId(queueName, organisationId)),
  );

  await Promise.all(
    organisationIds.map((organisationId) => {
      const id = tenantSchedulerId(queueName, organisationId);
      return queue.upsertJobScheduler(
        id,
        { every },
        {
          name: queueName === QueueName.AuditVerify ? 'verify' : 'sweep',
          // The scheduler id is a stable, non-PII correlation value. Each job
          // remains tenant-bound and can safely be retried by BullMQ.
          data: { organisationId, correlationId: id },
        },
      );
    }),
  );

  const existing = await allSchedulers(queue);
  const stale = existing
    .map((scheduler) => scheduler.id)
    .filter(
      (id): id is string =>
        typeof id === 'string' && isOurScheduler(id, queueName) && !wanted.has(id),
    );
  await Promise.all(stale.map((id) => queue.removeJobScheduler(id)));
  return stale.length;
}

/**
 * Reconcile the durable schedules for exactly the supplied active tenants.
 * Exported separately from the DB read so it can be covered without Redis or
 * Postgres, and so operational tooling can reuse the same invariant.
 */
export async function reconcileTenantSchedules(
  input: ReconcileSchedulesInput,
): Promise<ReconcileSchedulesResult> {
  const organisationIds = [...new Set(input.organisationIds)].filter(Boolean);
  const [auditRemoved, retentionRemoved, reminderRemoved] = await Promise.all([
    reconcileQueue(
      input.auditQueue,
      QueueName.AuditVerify,
      organisationIds,
      input.intervals.auditVerifyMs,
    ),
    reconcileQueue(
      input.retentionQueue,
      QueueName.Retention,
      organisationIds,
      input.intervals.retentionSweepMs,
    ),
    input.reminderQueue
      ? reconcileQueue(
          input.reminderQueue,
          QueueName.Reminder,
          organisationIds,
          input.intervals.reminderSweepMs ?? 900_000,
        )
      : Promise.resolve(0),
  ]);

  return {
    auditSchedulers: organisationIds.length,
    retentionSchedulers: organisationIds.length,
    reminderSchedulers: input.reminderQueue ? organisationIds.length : 0,
    removedSchedulers: auditRemoved + retentionRemoved + reminderRemoved,
  };
}

/** Query active tenants and reconcile their audit-verification/retention jobs. */
export async function syncTenantSchedules(): Promise<ReconcileSchedulesResult> {
  const active = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.status, 'active'));

  return reconcileTenantSchedules({
    organisationIds: active.map((organisation) => organisation.id),
    auditQueue: getQueue(QueueName.AuditVerify),
    retentionQueue: getQueue(QueueName.Retention),
    reminderQueue: getQueue(QueueName.Reminder),
    intervals: {
      auditVerifyMs: env.AUDIT_VERIFY_INTERVAL_MS,
      retentionSweepMs: env.RETENTION_SWEEP_INTERVAL_MS,
      reminderSweepMs: env.REMINDER_SWEEP_INTERVAL_MS,
    },
  });
}

/** Start periodic reconciliation and return an idempotent stop function. */
export async function startTenantScheduleSync(logger: Logger): Promise<() => void> {
  const report = await syncTenantSchedules();
  logger.info(report, 'tenant maintenance schedules synchronised');

  let syncing = false;
  const timer = setInterval(() => {
    if (syncing) return;
    syncing = true;
    void syncTenantSchedules()
      .then((next) => logger.debug(next, 'tenant maintenance schedules synchronised'))
      .catch((err: unknown) =>
        logger.error({ err }, 'tenant schedule synchronisation failed'),
      )
      .finally(() => {
        syncing = false;
      });
  }, env.SCHEDULER_SYNC_INTERVAL_MS);
  timer.unref();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
