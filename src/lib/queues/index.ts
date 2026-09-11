import { Queue, type JobsOptions, type QueueOptions } from 'bullmq';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/**
 * BullMQ queue factory.
 *
 * Every background job operates on behalf of exactly one organisation. Its
 * payload MUST carry `organisationId` so the worker can establish a verified
 * TenantContext before touching data — a job with no tenant is rejected at
 * enqueue time. Job payloads must never embed applicant PII or evidence
 * content; pass opaque ids and let the worker fetch tenant-scoped rows.
 */

/** Phase-1 queues. Values are the concrete Redis queue names. */
export enum QueueName {
  MalwareScan = 'malware-scan',
  Email = 'email',
  Notification = 'notification',
  AuditVerify = 'audit-verify',
  Retention = 'retention',
  Export = 'export',
  Webhook = 'webhook',
  Reminder = 'reminder',
}

/** Base shape every job payload must satisfy: it is bound to one tenant. */
export interface TenantJob {
  organisationId: string;
  /** Correlation id threaded from the originating request for tracing. */
  correlationId: string;
}

const connection = redis;

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  // Keep the queue tidy but retain a window for operational inspection.
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const queueOptions: QueueOptions = {
  connection,
  prefix: 'bp:queue',
  defaultJobOptions,
};

const registry = new Map<QueueName, Queue>();

/** Get (or lazily create) the shared Queue instance for a given name. */
export function getQueue<T extends TenantJob = TenantJob>(
  name: QueueName,
): Queue<T, unknown, string> {
  const existing = registry.get(name);
  if (existing) return existing as Queue<T, unknown, string>;
  const queue = new Queue<T, unknown, string>(name, queueOptions);
  registry.set(name, queue as Queue);
  return queue;
}

/**
 * Enforce the tenant invariant on any payload before it enters a queue.
 *
 * @throws when `organisationId` (or `correlationId`) is missing so a
 * mis-constructed job can never run without a tenant context.
 */
export function assertTenantJob<T extends TenantJob>(payload: T): T {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Job payload must be an object');
  }
  if (!payload.organisationId) {
    throw new Error('Job payload is missing organisationId — refusing to enqueue');
  }
  if (!payload.correlationId) {
    throw new Error('Job payload is missing correlationId — refusing to enqueue');
  }
  return payload;
}

export interface AddJobOptions extends JobsOptions {
  /**
   * Stable id for idempotency/uniqueness. When two producers add the same
   * logical job, supply the same `jobId` so BullMQ de-duplicates it.
   */
  jobId?: string;
}

/**
 * Add a job to a queue after validating the tenant invariant. Prefer supplying
 * a deterministic `jobId` (e.g. derived from the entity id) so retries and
 * duplicate triggers do not create duplicate work.
 */
export async function addJob<T extends TenantJob>(
  name: QueueName,
  jobName: string,
  payload: T,
  options: AddJobOptions = {},
): Promise<string | undefined> {
  const safe: TenantJob = assertTenantJob(payload);
  // Use the concretely-typed queue (T resolved to TenantJob) so BullMQ's
  // `ExtractNameType` for the job name resolves to `string` rather than an
  // unresolved conditional over the generic parameter.
  const queue = getQueue(name);
  const job = await queue.add(jobName, safe, options);
  logger.debug(
    {
      queue: name,
      jobName,
      jobId: job.id,
      organisationId: safe.organisationId,
      correlationId: safe.correlationId,
    },
    'Job enqueued',
  );
  return job.id;
}

/** Close all open queue connections (used on graceful shutdown). */
export async function closeQueues(): Promise<void> {
  await Promise.all([...registry.values()].map((q) => q.close()));
  registry.clear();
}

export { connection as queueConnection };
