import { Queue, type JobsOptions } from 'bullmq';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/**
 * Platform password-reset mail.
 *
 * This is not a tenant job: there is no organisation on a reset request, and
 * the tenant queue refuses a payload without one. The body is the address,
 * the greeting name, and the bearer URL. No job id — a second request must
 * send again. Logs carry the job id only.
 */

export const AUTH_EMAIL_QUEUE = 'auth-email';

export const AUTH_EMAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface PasswordResetJob {
  kind: 'password-reset';
  to: string;
  name: string;
  url: string;
}

const connection = redis;

let queue: Queue<PasswordResetJob> | undefined;

function getAuthEmailQueue(): Queue<PasswordResetJob> {
  queue ??= new Queue<PasswordResetJob>(AUTH_EMAIL_QUEUE, {
    connection,
    prefix: 'bp:queue',
    defaultJobOptions: AUTH_EMAIL_JOB_OPTIONS,
  });
  return queue;
}

export async function enqueuePasswordResetEmail(input: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  const job = await getAuthEmailQueue().add('password-reset', {
    kind: 'password-reset',
    to: input.to,
    name: input.name,
    url: input.url,
  });
  logger.debug({ queue: AUTH_EMAIL_QUEUE, jobId: job.id }, 'auth email enqueued');
}

export async function closeAuthEmailQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}
