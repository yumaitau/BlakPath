/**
 * Webhooks domain (Phase 7).
 *
 *   - `events`  — the closed set of subscribable event types.
 *   - `signing` — pure HMAC-SHA256 payload signing/verification.
 *   - `schemas` — zod v4 endpoint validation.
 *   - `service` — tenant-scoped management + `emitWebhookEvent` (worker-safe).
 *   - `deliver` — the worker-side signed delivery with fail-secure retries.
 *   - `retry`   — the hours-long webhook backoff schedule (pure).
 *   - `sweep`   — worker-side re-queue of stale `pending` deliveries.
 */
export { WEBHOOK_EVENTS, isWebhookEvent, type WebhookEvent } from './events';

export {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  signPayload,
  verifyPayload,
} from './signing';

export { createEndpointSchema, type CreateEndpointInput } from './schemas';

export {
  createEndpoint,
  deleteEndpoint,
  emitWebhookEvent,
  emitWebhookEventSafe,
  listDeliveries,
  listEndpoints,
  redeliverDelivery,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from './service';

export { MAX_ATTEMPTS, processWebhookDelivery, type DeliverInput } from './deliver';

export {
  WEBHOOK_BACKOFF_TYPE,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_SCHEDULE_MS,
  WEBHOOK_STALE_PENDING_MS,
  webhookAttemptOffsetMs,
  webhookBackoffStrategy,
  webhookJobOptions,
  webhookRetryDelayMs,
} from './retry';

export { requeueDelivery, type DeliveryJobLookup, type RequeueResult } from './requeue';

export { sweepStaleWebhookDeliveries, type SweepInput, type SweepResult } from './sweep';
