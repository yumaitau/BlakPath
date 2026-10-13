import { and, eq } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints } from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { auditReason } from '@/domains/audit/hash';
import { recordAudit } from '@/domains/audit/service';
import { logger } from '@/lib/observability/logger';
import {
  signPayload,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from './signing';

/**
 * Webhook delivery (worker side).
 *
 * Runs with an explicit organisation id (no ambient tenant context). Signs the
 * body, POSTs it, and records the outcome. FAIL-SECURE about retries: a failed
 * delivery THROWS so BullMQ retries with backoff, until `MAX_ATTEMPTS`, after
 * which the delivery is marked `failed` and left for operator inspection — it is
 * never silently dropped and never "succeeds" without a 2xx.
 */

export const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;

export interface DeliverInput {
  organisationId: string;
  deliveryId: string;
  correlationId: string;
}

function systemAudit(
  organisationId: string,
  correlationId: string,
  fields: Parameters<typeof recordAudit>[0],
) {
  return recordAudit({
    ...fields,
    organisationId,
    actorUserId: null,
    actingRole: 'system',
    sessionId: null,
    correlationId,
  });
}

export async function processWebhookDelivery(input: DeliverInput): Promise<void> {
  const { organisationId, deliveryId, correlationId } = input;
  const scope = scopeFor(organisationId);

  const deliveryRows = await scope.db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organisationId, organisationId),
        eq(webhookDeliveries.id, deliveryId),
      ),
    )
    .limit(1);
  const delivery = deliveryRows[0];
  if (!delivery || delivery.status !== 'pending') return;

  const endpointRows = await scope.db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organisationId, organisationId),
        eq(webhookEndpoints.id, delivery.endpointId),
      ),
    )
    .limit(1);
  const endpoint = endpointRows[0];

  const attempts = delivery.attempts + 1;
  const settle = (patch: Partial<typeof webhookDeliveries.$inferInsert>) =>
    scope.db
      .update(webhookDeliveries)
      .set(patch)
      .where(
        and(
          eq(webhookDeliveries.organisationId, organisationId),
          eq(webhookDeliveries.id, deliveryId),
        ),
      );

  if (!endpoint || !endpoint.active || endpoint.deletedAt) {
    await settle({ status: 'failed', attempts, lastError: 'endpoint unavailable' });
    return;
  }

  const body = JSON.stringify({
    id: delivery.id,
    event: delivery.event,
    payload: delivery.payload,
    timestamp: new Date().toISOString(),
  });
  const signature = signPayload(endpoint.secret, body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_EVENT_HEADER]: delivery.event,
        [WEBHOOK_DELIVERY_HEADER]: delivery.id,
      },
      body,
      signal: controller.signal,
    });

    if (res.ok) {
      await settle({
        status: 'delivered',
        attempts,
        lastResponseCode: res.status,
        deliveredAt: new Date(),
      });
      await systemAudit(organisationId, correlationId, {
        action: 'integration.call_succeeded',
        resourceType: 'integration',
        resourceId: endpoint.id,
        result: 'success',
      });
      return;
    }

    // Non-2xx: retry until the cap, then give up (marked failed).
    const giveUp = attempts >= MAX_ATTEMPTS;
    await settle({
      status: giveUp ? 'failed' : 'pending',
      attempts,
      lastResponseCode: res.status,
      lastError: `HTTP ${res.status}`,
    });
    await systemAudit(organisationId, correlationId, {
      action: 'integration.call_failed',
      resourceType: 'integration',
      resourceId: endpoint.id,
      result: 'failure',
      reason: auditReason('webhook.http_status', String(res.status)),
    });
    if (!giveUp) throw new Error(`webhook delivery failed: HTTP ${res.status}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('webhook delivery failed')) {
      throw err; // already recorded above; rethrow so BullMQ retries.
    }
    const giveUp = attempts >= MAX_ATTEMPTS;
    await settle({
      status: giveUp ? 'failed' : 'pending',
      attempts,
      lastError: err instanceof Error ? err.message : 'network error',
    });
    await systemAudit(organisationId, correlationId, {
      action: 'integration.call_failed',
      resourceType: 'integration',
      resourceId: endpoint.id,
      result: 'failure',
      reason: 'webhook.network_error',
    });
    logger.warn({ organisationId, deliveryId, attempts }, 'webhook delivery error');
    if (!giveUp) throw err instanceof Error ? err : new Error('webhook delivery error');
  } finally {
    clearTimeout(timer);
  }
}
