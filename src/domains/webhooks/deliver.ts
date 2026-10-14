import { and, eq } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints } from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { auditReason } from '@/domains/audit/hash';
import { recordAudit, type AuditTransaction } from '@/domains/audit/service';
import { openWebhookSecret } from '@/lib/encryption/tenant-fields';
import { logger } from '@/lib/observability/logger';
import { isDestinationRejection } from './destination';
import { deliverWebhookRequest, deliveryDisposition } from './dispatch';
import { WEBHOOK_MAX_ATTEMPTS } from './retry';
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
 * delivery THROWS so BullMQ retries with the webhook backoff (hours, see
 * `retry.ts`), until `MAX_ATTEMPTS`, after which the delivery is marked `failed`
 * and left for operator inspection or manual redelivery — it is never silently
 * dropped and never "succeeds" without a 2xx. A destination that fails the
 * public-HTTPS policy is terminal: it is not retried and it is not dialled.
 */

export const MAX_ATTEMPTS = WEBHOOK_MAX_ATTEMPTS;
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
  tx?: AuditTransaction,
) {
  return recordAudit(
    {
      ...fields,
      organisationId,
      actorUserId: null,
      actingRole: 'system',
      sessionId: null,
      correlationId,
    },
    tx,
  );
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
  // The delivery row change and its audit commit or roll back together.
  const settle = (
    patch: Partial<typeof webhookDeliveries.$inferInsert>,
    audit?: Parameters<typeof recordAudit>[0],
  ) =>
    scope.db.transaction(async (tx) => {
      await tx
        .update(webhookDeliveries)
        .set(patch)
        .where(
          and(
            eq(webhookDeliveries.organisationId, organisationId),
            eq(webhookDeliveries.id, deliveryId),
          ),
        );
      if (audit) await systemAudit(organisationId, correlationId, audit, tx);
    });

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let signingSecret: string;
    try {
      signingSecret = await openWebhookSecret(
        organisationId,
        endpoint.id,
        endpoint.secretCiphertext,
      );
    } catch {
      await settle(
        {
          status: 'failed',
          attempts,
          lastError: 'endpoint secret unavailable',
        },
        {
          action: 'integration.call_failed',
          resourceType: 'integration',
          resourceId: endpoint.id,
          result: 'failure',
          reason: 'webhook.secret_unavailable',
        },
      );
      return;
    }

    const signature = signPayload(signingSecret, body);
    const res = await deliverWebhookRequest(
      endpoint.url,
      body,
      {
        'content-type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_EVENT_HEADER]: delivery.event,
        [WEBHOOK_DELIVERY_HEADER]: delivery.id,
      },
      controller.signal,
    );

    const disposition = deliveryDisposition(res.status);
    if (disposition === 'delivered') {
      await settle(
        {
          status: 'delivered',
          attempts,
          lastResponseCode: res.status,
          deliveredAt: new Date(),
        },
        {
          action: 'integration.call_succeeded',
          resourceType: 'integration',
          resourceId: endpoint.id,
          result: 'success',
        },
      );
      return;
    }

    // 3xx is terminal: the redirect target is never requested. Other non-2xx
    // responses retry until the cap, then stay failed for an operator.
    const terminal = disposition === 'redirect' || attempts >= MAX_ATTEMPTS;
    const reason =
      disposition === 'redirect' ? 'redirect not followed' : `HTTP ${res.status}`;
    await settle(
      {
        status: terminal ? 'failed' : 'pending',
        attempts,
        lastResponseCode: res.status,
        lastError: reason,
      },
      {
        action: 'integration.call_failed',
        resourceType: 'integration',
        resourceId: endpoint.id,
        result: 'failure',
        reason:
          disposition === 'redirect'
            ? 'webhook.redirect_not_followed'
            : auditReason('webhook.http_status', String(res.status)),
      },
    );
    if (!terminal) throw new Error(`webhook delivery failed: HTTP ${res.status}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('webhook delivery failed')) {
      throw err; // already recorded above; rethrow so BullMQ retries.
    }
    if (isDestinationRejection(err)) {
      await settle(
        { status: 'failed', attempts, lastError: 'destination not allowed' },
        {
          action: 'integration.call_failed',
          resourceType: 'integration',
          resourceId: endpoint.id,
          result: 'failure',
          reason: 'webhook.destination_not_allowed',
        },
      );
      return;
    }
    const giveUp = attempts >= MAX_ATTEMPTS;
    await settle(
      {
        status: giveUp ? 'failed' : 'pending',
        attempts,
        lastError: 'network error',
      },
      {
        action: 'integration.call_failed',
        resourceType: 'integration',
        resourceId: endpoint.id,
        result: 'failure',
        reason: 'webhook.network_error',
      },
    );
    logger.warn({ organisationId, deliveryId, attempts }, 'webhook delivery error');
    if (!giveUp) throw err instanceof Error ? err : new Error('webhook delivery error');
  } finally {
    clearTimeout(timer);
  }
}
