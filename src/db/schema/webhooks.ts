import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
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
 * SECURITY: `secret` stores envelope ciphertext (AES-256-GCM), never the
 * signing secret itself. Plaintext is returned once on create and on rotation,
 * then decrypted only inside the delivery worker to compute the HMAC. Payloads
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
    /**
     * Envelope ciphertext of the HMAC signing secret. The column name stays
     * `secret` so existing rows keep their place; the value must be ciphertext.
     */
    secretCiphertext: text('secret').notNull(),
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
    index('webhook_endpoints_org_idx').on(table.organisationId),
    // `sealWebhookSecret` always emits this prefix. Legacy plaintext cannot be
    // written once the constraint is in place.
    check(
      'webhook_endpoints_secret_is_ciphertext',
      sql`${table.secretCiphertext} ~ '^\\{"v":[0-9]+,'`,
    ),
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
    endpointId: refId('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
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
