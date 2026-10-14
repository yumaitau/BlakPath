import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { uuidv7 } from 'uuidv7';
import { webhookDeliveries, webhookEndpoints } from '@/db/schema';
import { currentScope, scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { addJob, QueueName } from '@/lib/queues';
import { sealWebhookSecret } from '@/lib/encryption/tenant-fields';
import { logger } from '@/lib/observability/logger';
import { assertWebhookDestinationForCreate } from './destination';
import { requeueDelivery } from './requeue';
import { webhookJobOptions } from './retry';
import type { WebhookEvent } from './events';
import { createEndpointSchema, type CreateEndpointInput } from './schemas';
import { toWebhookEndpointView, type WebhookEndpointView } from './view';

/**
 * Webhook management + event emission.
 *
 * Managing endpoints requires `tenant:configure`. Emission is callable from
 * domain services and the worker, so it uses `scopeFor` (no ambient context):
 * it finds the active endpoints subscribed to an event, records a delivery per
 * endpoint, and enqueues each for the delivery worker. Payloads carry ids and
 * non-sensitive fields only. A delivery whose enqueue fails stays `pending` and
 * is picked up by the stale-delivery sweeper (see `sweep.ts`).
 */

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type { WebhookEndpointView };

/** Returned once, on create. `secret` is plaintext; it is not stored. */
export interface WebhookEndpointCreated {
  id: string;
  url: string;
  events: unknown;
  secret: string;
}

const secretGen = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  48,
);

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

/** Create an endpoint. The signing secret is returned once; only ciphertext is stored. */
export async function createEndpoint(
  rawInput: CreateEndpointInput,
): Promise<WebhookEndpointCreated> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');

  const input = createEndpointSchema.parse(rawInput);
  await assertWebhookDestinationForCreate(input.url);
  const secret = secretGen();
  const scope = currentScope();
  // The id is fixed before sealing so the ciphertext is bound to this row.
  const id = uuidv7();
  const secretCiphertext = await sealWebhookSecret(scope.organisationId, id, secret);
  const row = await scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(webhookEndpoints)
      .values(
        scope.insertValues({
          id,
          url: input.url,
          secretCiphertext,
          events: input.events,
          active: true,
          createdByUserId: ctx.userId,
        }),
      )
      .returning({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        events: webhookEndpoints.events,
      });
    const created = must(inserted[0], 'webhook endpoint');

    await recordAudit(
      {
        action: 'integration.connected',
        resourceType: 'integration',
        resourceId: created.id,
        result: 'success',
        after: { data: { url: input.url }, allow: ['url'] },
      },
      tx,
    );
    return created;
  });
  return { id: row.id, url: row.url, events: row.events, secret };
}

export async function listEndpoints(): Promise<WebhookEndpointView[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();
  const rows = await scope.db
    .select({
      id: webhookEndpoints.id,
      organisationId: webhookEndpoints.organisationId,
      url: webhookEndpoints.url,
      events: webhookEndpoints.events,
      active: webhookEndpoints.active,
      createdByUserId: webhookEndpoints.createdByUserId,
      createdAt: webhookEndpoints.createdAt,
      updatedAt: webhookEndpoints.updatedAt,
      deletedAt: webhookEndpoints.deletedAt,
    })
    .from(webhookEndpoints)
    .where(
      scope.where(webhookEndpoints.organisationId, isNull(webhookEndpoints.deletedAt)),
    )
    .orderBy(desc(webhookEndpoints.createdAt));
  return rows.map((row) => toWebhookEndpointView(row));
}

/**
 * Replace the signing secret. The new plaintext is returned once. A missing
 * endpoint is refused with the same error as a permission failure.
 */
export async function rotateEndpointSecret(
  id: string,
): Promise<{ id: string; secret: string }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const secret = secretGen();
  const scope = currentScope();
  const secretCiphertext = await sealWebhookSecret(scope.organisationId, id, secret);
  const row = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(webhookEndpoints)
      .set({ secretCiphertext, updatedAt: new Date() })
      .where(
        scope.where(
          webhookEndpoints.organisationId,
          eq(webhookEndpoints.id, id),
          isNull(webhookEndpoints.deletedAt),
        ),
      )
      .returning({ id: webhookEndpoints.id });
    const rotated = updated[0];
    if (!rotated) throw new AuthorizationError('PERMISSION_DENIED');

    await recordAudit(
      {
        action: 'integration.credentials_rotated',
        resourceType: 'integration',
        resourceId: rotated.id,
        result: 'success',
      },
      tx,
    );
    return rotated;
  });
  return { id: row.id, secret };
}

export async function deleteEndpoint(id: string): Promise<void> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();
  await scope.db.transaction(async (tx) => {
    await tx
      .update(webhookEndpoints)
      .set({ active: false, deletedAt: new Date() })
      .where(scope.where(webhookEndpoints.organisationId, eq(webhookEndpoints.id, id)));

    await recordAudit(
      {
        action: 'integration.disconnected',
        resourceType: 'integration',
        resourceId: id,
        result: 'success',
      },
      tx,
    );
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

    try {
      await addJob(
        QueueName.Webhook,
        'deliver',
        { organisationId: input.organisationId, correlationId, deliveryId: delivery.id },
        webhookJobOptions(delivery.id),
      );
    } catch (err) {
      // The row is recorded as `pending`; the sweeper re-queues it. Keep going
      // so one enqueue failure does not starve the remaining endpoints.
      logger.warn(
        { err, organisationId: input.organisationId, deliveryId: delivery.id },
        'webhook enqueue failed; left pending for the sweeper',
      );
    }
  }
}

/**
 * Manually redeliver a settled (delivered or failed) delivery. Requires
 * `tenant:configure`. Resets the attempt count so the full retry schedule
 * applies again, re-enqueues it, and audits the request. A delivery that is
 * still `pending` is already being retried and is refused, so a double click
 * cannot send two copies.
 */
export async function redeliverDelivery(
  endpointId: string,
  deliveryId: string,
): Promise<WebhookDeliveryRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();

  const [endpoint] = await scope.db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      scope.where(
        webhookEndpoints.organisationId,
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.active, true),
        isNull(webhookEndpoints.deletedAt),
      ),
    )
    .limit(1);
  if (!endpoint) throw new AuthorizationError('POLICY_DENIED');

  // Conditional update: only a settled delivery flips back to pending, which
  // also makes concurrent redeliver requests race-safe. The audit commits with
  // the state change; the job is enqueued only after both are durable (a
  // failed enqueue leaves the row pending for the sweeper).
  const row = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(webhookDeliveries)
      .set({
        status: 'pending',
        attempts: 0,
        lastError: null,
        lastResponseCode: null,
        deliveredAt: null,
      })
      .where(
        scope.where(
          webhookDeliveries.organisationId,
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.endpointId, endpointId),
          ne(webhookDeliveries.status, 'pending'),
        ),
      )
      .returning();
    const reset = updated[0];
    if (!reset) {
      throw new AuthorizationError(
        'POLICY_DENIED',
        'This delivery cannot be redelivered right now.',
      );
    }

    await recordAudit(
      {
        action: 'integration.redelivery_requested',
        resourceType: 'integration',
        resourceId: endpointId,
        result: 'success',
        after: {
          data: { deliveryId, event: reset.event },
          allow: ['deliveryId', 'event'],
        },
      },
      tx,
    );
    return reset;
  });

  await requeueDelivery({
    organisationId: ctx.organisationId,
    deliveryId,
    correlationId: ctx.correlationId,
  });
  return row;
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
