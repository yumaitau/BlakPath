import { addJob, getQueue, QueueName } from '@/lib/queues';
import { webhookJobOptions } from './retry';

/**
 * Re-enqueue a webhook delivery job without duplicating live work.
 *
 * Delivery jobs use the delivery id as their BullMQ job id, so a fresh `add`
 * with that id is silently de-duplicated while an old completed/failed job is
 * still retained. This helper therefore checks the existing job first: a live
 * job (waiting, delayed, active) is left alone; a finished one is removed and a
 * new job added under the same id. Shared by the stale-delivery sweeper and the
 * manual redeliver action.
 */

/** Queue states in which a job will still run without intervention. */
const LIVE_STATES = new Set([
  'waiting',
  'waiting-children',
  'delayed',
  'active',
  'prioritized',
]);

interface ExistingJob {
  getState(): Promise<string>;
  remove(): Promise<void>;
}

/** The subset of the webhook Queue this helper needs (injectable for tests). */
export interface DeliveryJobLookup {
  getJob(id: string): Promise<ExistingJob | undefined | null>;
}

export interface RequeueInput {
  organisationId: string;
  deliveryId: string;
  correlationId: string;
}

export type RequeueResult = 'queued' | 'in_flight';

export async function requeueDelivery(
  input: RequeueInput,
  queue: DeliveryJobLookup = getQueue(QueueName.Webhook),
): Promise<RequeueResult> {
  const existing = await queue.getJob(input.deliveryId);
  if (existing) {
    const state = await existing.getState();
    if (LIVE_STATES.has(state)) return 'in_flight';
    await existing.remove();
  }
  await addJob(
    QueueName.Webhook,
    'deliver',
    {
      organisationId: input.organisationId,
      correlationId: input.correlationId,
      deliveryId: input.deliveryId,
    },
    webhookJobOptions(input.deliveryId),
  );
  return 'queued';
}
