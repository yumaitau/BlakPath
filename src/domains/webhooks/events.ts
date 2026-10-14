/**
 * The closed set of webhook event types.
 *
 * These name organisation-level occurrences an integrator may subscribe to. The
 * payloads carry ids and non-sensitive fields only — never applicant PII or
 * evidence content. Nothing here scores or determines Aboriginality; events
 * merely announce that authorised humans moved work forward.
 */
export const WEBHOOK_EVENTS = [
  'application.submitted',
  'decision.finalised',
  'certificate.signed',
  'certificate.revoked',
  'form.response_submitted',
  'evidence.scan_infected',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}
