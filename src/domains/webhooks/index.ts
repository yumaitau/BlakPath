/**
 * Webhooks domain (Phase 7).
 *
 *   - `events`  — the closed set of subscribable event types.
 *   - `signing` — pure HMAC-SHA256 payload signing/verification.
 *   - `schemas` — zod v4 endpoint validation.
 *   - `destination` — public-HTTPS address policy, re-checked at connect time.
 *   - `service` — tenant-scoped management + `emitWebhookEvent` (worker-safe).
 *   - `deliver` — the worker-side signed delivery with fail-secure retries.
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
  rotateEndpointSecret,
  type WebhookDeliveryRow,
  type WebhookEndpointCreated,
  type WebhookEndpointRow,
} from './service';

export { type WebhookEndpointView } from './view';

export { MAX_ATTEMPTS, processWebhookDelivery, type DeliverInput } from './deliver';
