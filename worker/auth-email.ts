import { Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';
import { deliverPasswordResetEmail } from '@/lib/email/mailer';
import { AUTH_EMAIL_QUEUE, type PasswordResetJob } from '@/lib/auth/reset-queue';
import { logger } from '@/lib/observability/logger';

/**
 * Delivers queued password-reset mail through the SMTP path.
 *
 * Calls `deliverPasswordResetEmail`, not the auth mailer — the mailer
 * enqueues, and calling it here would loop. Malformed jobs are dropped.
 * Failure logs are the job id and the error, never the payload.
 */

function isPasswordResetJob(data: unknown): data is PasswordResetJob {
  if (!data || typeof data !== 'object') return false;
  const job = data as Partial<PasswordResetJob>;
  return (
    job.kind === 'password-reset' &&
    typeof job.to === 'string' &&
    job.to.length > 0 &&
    typeof job.name === 'string' &&
    typeof job.url === 'string' &&
    job.url.length > 0
  );
}

export async function processAuthEmailJob(
  data: unknown,
  deliver: (message: {
    to: string;
    name: string;
    url: string;
  }) => Promise<void> = deliverPasswordResetEmail,
): Promise<void> {
  if (!isPasswordResetJob(data)) {
    logger.error({ scope: 'auth-email' }, 'dropped malformed auth email job');
    return;
  }
  await deliver({ to: data.to, name: data.name, url: data.url });
}

export function startAuthEmailWorker(
  connection: ConnectionOptions,
  workerLogger: Logger,
): Worker<PasswordResetJob> {
  const child = workerLogger.child({ queue: AUTH_EMAIL_QUEUE });
  const worker = new Worker<PasswordResetJob>(
    AUTH_EMAIL_QUEUE,
    async (job) => {
      await processAuthEmailJob(job.data);
    },
    {
      connection,
      prefix: 'bp:queue',
      concurrency: 4,
      autorun: false,
    },
  );

  worker.on('failed', (job, err) => {
    child.error({ jobId: job?.id, err }, 'auth email job failed');
  });

  worker.on('error', (err) => {
    child.error({ err }, 'auth email worker error');
  });

  return worker;
}
