import { and, asc, eq, lt } from 'drizzle-orm';
import { webhookDeliveries } from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { logger } from '@/lib/observability/logger';
import { requeueDelivery, type DeliveryJobLookup } from './requeue';
import { WEBHOOK_STALE_PENDING_MS } from './retry';

/**
 * Stale-delivery sweeper (worker side, per tenant).
 *
 * Recording a delivery and enqueueing its job are two separate writes (Postgres
 * then Redis), so a crash or Redis outage between them leaves a `pending` row
 * with no job. This sweep finds `pending` deliveries untouched for longer than
 * `WEBHOOK_STALE_PENDING_MS` and re-queues any that have no live job. A delivery
 * merely waiting out a long backoff still has a delayed job and is left alone.
 */

/** Upper bound per sweep so one backlog cannot monopolise the worker. */
const SWEEP_BATCH = 200;

export interface SweepInput {
  organisationId: string;
  correlationId: string;
  /** Injectable clock for tests. */
  now?: Date;
  /** Injectable queue lookup for tests. */
  queue?: DeliveryJobLookup;
}

export interface SweepResult {
  stale: number;
  requeued: number;
}

export async function sweepStaleWebhookDeliveries(
  input: SweepInput,
): Promise<SweepResult> {
  const { organisationId, correlationId } = input;
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - WEBHOOK_STALE_PENDING_MS);
  const scope = scopeFor(organisationId);

  const stale = await scope.db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organisationId, organisationId),
        eq(webhookDeliveries.status, 'pending'),
        lt(webhookDeliveries.updatedAt, cutoff),
      ),
    )
    .orderBy(asc(webhookDeliveries.updatedAt))
    .limit(SWEEP_BATCH);

  let requeued = 0;
  for (const row of stale) {
    const result = await requeueDelivery(
      { organisationId, correlationId, deliveryId: row.id },
      input.queue,
    );
    if (result === 'queued') requeued += 1;
  }

  if (requeued > 0) {
    logger.warn(
      { organisationId, correlationId, stale: stale.length, requeued },
      're-queued stale pending webhook deliveries',
    );
  }
  return { stale: stale.length, requeued };
}
