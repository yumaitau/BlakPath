import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  timestamps,
} from './_helpers';
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * Per-user, per-tenant UI preferences.
 *
 * Currently holds the dashboard widget order so a member's board layout follows
 * them across devices instead of living only in one browser's localStorage.
 * Tenant-owned: one row per (organisation, user).
 */
export const userDashboardLayouts = pgTable(
  'user_dashboard_layouts',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    userId: refId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Ordered list of dashboard widget ids. */
    widgetOrder: jsonb('widget_order').notNull().default([]),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('user_dashboard_layouts_org_user_unique').on(
      table.organisationId,
      table.userId,
    ),
    index('user_dashboard_layouts_user_idx').on(table.userId),
  ],
);

export const userDashboardLayoutsRelations = relations(
  userDashboardLayouts,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [userDashboardLayouts.organisationId],
      references: [organisations.id],
    }),
    user: one(users, {
      fields: [userDashboardLayouts.userId],
      references: [users.id],
    }),
  }),
);
