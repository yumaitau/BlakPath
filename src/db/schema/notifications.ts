import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  timestamps,
} from './_helpers';
import { users } from './auth';
import { organisations } from './tenancy';
import { tenantIsolationPolicy } from './_rls';

/**
 * In-app notifications.
 *
 * A notification tells a member that something needs their attention (evidence
 * flagged, a form response arrived, a decision awaits a vote). Tenant-owned and
 * org-leading indexed. The notification worker delivers a copy by email; this
 * row is the durable, in-app record. Bodies carry no secrets — links point back
 * into the permission-checked app, never to a bearer URL.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** The member the notification is for. */
    userId: refId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stable event type, e.g. 'evidence.infected' or 'form.response_submitted'. */
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** Optional deep-link target within the app (a resource type + id). */
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** When an email copy was dispatched by the notification worker. */
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('notifications_org_user_read_idx').on(
      table.organisationId,
      table.userId,
      table.readAt,
    ),
    tenantIsolationPolicy(),
  ],
).enableRLS();

export const notificationsRelations = relations(notifications, ({ one }) => ({
  organisation: one(organisations, {
    fields: [notifications.organisationId],
    references: [organisations.id],
  }),
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));
