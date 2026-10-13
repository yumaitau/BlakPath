import { relations } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  integer,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  softDelete,
  timestamps,
} from './_helpers';
import { webhookDeliveryStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * Webhook tables (Phase 7).
 *
 * An organisation registers HTTPS endpoints that receive signed event
 * notifications (an application submitted, a decision finalised, a certificate
 * signed, …). Each dispatch is recorded as a delivery with its own status and
 * attempt count so failures are visible and retryable. Tenant-owned.
 *
 * SECURITY: `secret` is the per-endpoint HMAC signing secret shared with the
 * receiver so it can verify authenticity. It is stored as given because the
 * receiver must know it; a follow-up will envelope-encrypt it at rest. Payloads
 * carry only ids and non-sensitive fields — never applicant PII or evidence.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    url: text('url').notNull(),
    /** Per-endpoint HMAC-SHA256 signing secret. */
    secret: text('secret').notNull(),
    /** Event types this endpoint subscribes to. */
    events: jsonb('events').notNull().default([]),
    active: boolean('active').notNull().default(true),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    unique('webhook_endpoints_org_id_unique').on(table.organisationId, table.id),
    index('webhook_endpoints_org_idx').on(table.organisationId),
    index('webhook_endpoints_created_by_idx').on(table.createdByUserId),
  ],
);

/** A single delivery attempt record for one event to one endpoint. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    endpointId: refId('endpoint_id').notNull(),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    status: webhookDeliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastResponseCode: integer('last_response_code'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: 'webhook_deliveries_endpoint_same_org_fk',
      columns: [table.organisationId, table.endpointId],
      foreignColumns: [webhookEndpoints.organisationId, webhookEndpoints.id],
    }).onDelete('cascade'),
    index('webhook_deliveries_org_endpoint_idx').on(
      table.organisationId,
      table.endpointId,
    ),
    index('webhook_deliveries_org_status_idx').on(table.organisationId, table.status),
  ],
);

export const webhookEndpointsRelations = relations(webhookEndpoints, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [webhookEndpoints.organisationId],
    references: [organisations.id],
  }),
  createdBy: one(users, {
    fields: [webhookEndpoints.createdByUserId],
    references: [users.id],
  }),
  deliveries: many(webhookDeliveries),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  organisation: one(organisations, {
    fields: [webhookDeliveries.organisationId],
    references: [organisations.id],
  }),
  endpoint: one(webhookEndpoints, {
    fields: [webhookDeliveries.endpointId],
    references: [webhookEndpoints.id],
  }),
}));
