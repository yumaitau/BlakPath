/**
 * Fields of a webhook endpoint that are safe to return from management APIs.
 * The signing secret is intentionally absent.
 */
export interface WebhookEndpointView {
  id: string;
  organisationId: string;
  url: string;
  events: unknown;
  active: boolean;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export function toWebhookEndpointView(row: WebhookEndpointView): WebhookEndpointView {
  return {
    id: row.id,
    organisationId: row.organisationId,
    url: row.url,
    events: row.events,
    active: row.active,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}
