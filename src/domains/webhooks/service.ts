import { and, desc, eq, isNull } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { webhookDeliveries, webhookEndpoints } from '@/db/schema';
import { currentScope, scopeFor } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { addJob, QueueName } from '@/lib/queues';
import { logger } from '@/lib/observability/logger';
import { createEndpointSchema, type CreateEndpointInput } from './schemas';
import type { WebhookEvent } from './events';

/**
 * Webhook management + event emission.
 *
 * Managing endpoints requires `tenant:configure`. Emission is callable from
 * domain services and the worker, so it uses `scopeFor` (no ambient context):
 * it finds the active endpoints subscribed to an event, records a delivery per
 * endpoint, and enqueues each for the delivery worker. Payloads carry ids and
 * non-sensitive fields only.
 */

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

const secretGen = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  48,
);

/** Create an endpoint. The signing secret is returned so it can be configured. */
export async function createEndpoint(
  rawInput: CreateEndpointInput,
): Promise<WebhookEndpointRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');

  const input = createEndpointSchema.parse(rawInput);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(webhookEndpoints)
    .values(
      scope.insertValues({
        url: input.url,
        secret: secretGen(),
        events: input.events,
        active: true,
        createdByUserId: ctx.userId,
      }),
    )
    .returning();
  const row = expectRow(inserted[0], 'webhook endpoint');

  await recordAudit({
    action: 'integration.connected',
    resourceType: 'integration',
    resourceId: row.id,
    result: 'success',
    after: { data: { url: input.url }, allow: ['url'] },
  });
  return row;
}

export async function listEndpoints(): Promise<WebhookEndpointRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();
  return scope.db
    .select()
    .from(webhookEndpoints)
    .where(
      scope.where(webhookEndpoints.organisationId, isNull(webhookEndpoints.deletedAt)),
    )
    .orderBy(desc(webhookEndpoints.createdAt));
}

export async function deleteEndpoint(id: string): Promise<void> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();
  await scope.db
    .update(webhookEndpoints)
    .set({ active: false, deletedAt: new Date() })
    .where(scope.where(webhookEndpoints.organisationId, eq(webhookEndpoints.id, id)));

  await recordAudit({
    action: 'integration.disconnected',
    resourceType: 'integration',
    resourceId: id,
    result: 'success',
  });
}

export async function listDeliveries(endpointId: string): Promise<WebhookDeliveryRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();
  return scope.db
    .select()
    .from(webhookDeliveries)
    .where(
      scope.where(
        webhookDeliveries.organisationId,
        eq(webhookDeliveries.endpointId, endpointId),
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt));
}

export interface EmitInput {
  organisationId: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  correlationId?: string;
}

/**
 * Emit an event: record a delivery per subscribed active endpoint and enqueue
 * each for the delivery worker. Worker/domain-safe (uses `scopeFor`). Never
 * throws into the caller's critical path — a webhook problem must not fail the
 * business action that triggered it.
 */
export async function emitWebhookEvent(input: EmitInput): Promise<void> {
  const correlationId = input.correlationId ?? globalThis.crypto.randomUUID();
  const scope = scopeFor(input.organisationId);

  const endpoints = await scope.db
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organisationId, input.organisationId),
        eq(webhookEndpoints.active, true),
        isNull(webhookEndpoints.deletedAt),
      ),
    );

  for (const endpoint of endpoints) {
    const subscribed = Array.isArray(endpoint.events)
      ? (endpoint.events as unknown[]).includes(input.event)
      : false;
    if (!subscribed) continue;

    const inserted = await scope.db
      .insert(webhookDeliveries)
      .values(
        scope.insertValues({
          endpointId: endpoint.id,
          event: input.event,
          payload: input.payload,
          status: 'pending',
        }),
      )
      .returning({ id: webhookDeliveries.id });
    const delivery = inserted[0];
    if (!delivery) continue;

    await addJob(
      QueueName.Webhook,
      'deliver',
      { organisationId: input.organisationId, correlationId, deliveryId: delivery.id },
      { jobId: delivery.id },
    );
  }
}

/** Convenience: emit but swallow any error (for non-critical call sites). */
export async function emitWebhookEventSafe(input: EmitInput): Promise<void> {
  try {
    await emitWebhookEvent(input);
  } catch (err) {
    logger.warn({ err, event: input.event }, 'webhook emit failed (non-fatal)');
  }
}

/** Guard used by the API layer. */
export { AuthorizationError };
