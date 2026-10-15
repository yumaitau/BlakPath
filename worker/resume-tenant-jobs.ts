import { getQueue, QueueName } from '@/lib/queues';
import { rememberPausedJob, takePausedJobs } from './tenant-pause-ledger';

function splitRef(ref: string): { queueName: QueueName; jobId: string } | null {
  const split = ref.indexOf(':');
  if (split <= 0) return null;
  const queueName = ref.slice(0, split);
  const jobId = ref.slice(split + 1);
  if (!jobId || !Object.values(QueueName).includes(queueName as QueueName)) return null;
  return { queueName: queueName as QueueName, jobId };
}

/** Move jobs delayed by a tenant key back to waiting. */
export async function promotePausedTenantJobs(organisationId: string): Promise<number> {
  const refs = takePausedJobs(organisationId);
  let promoted = 0;
  for (const ref of refs) {
    const parsed = splitRef(ref);
    if (!parsed) continue;
    try {
      const job = await getQueue(parsed.queueName).getJob(parsed.jobId);
      if (!job) continue;
      await job.promote();
      promoted += 1;
    } catch {
      rememberPausedJob(organisationId, ref);
    }
  }
  return promoted;
}
