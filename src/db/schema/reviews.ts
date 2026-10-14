import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  rowVersion,
  softDelete,
  timestamps,
} from './_helpers';
import { reviewStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { applications } from './applications';
import { tenantIsolationPolicy } from './_rls';

/**
 * Review tables (Phase 4).
 *
 * A review captures an authorised worker's observations on an application so the
 * committee has a considered record in front of it. Tenant-owned, org-leading
 * indexed.
 *
 * PRODUCT INVARIANT: a review is a HUMAN's observations and, at most, a
 * recommendation for the committee to weigh — never a machine determination,
 * score or ranking of a person's Aboriginality. Finalising only locks the human
 * record; it decides nothing on its own.
 */

/** A review of one application. `content` holds the reviewer's observations. */
export const reviews = pgTable(
  'reviews',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    reviewerUserId: refId('reviewer_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: reviewStatus('status').notNull().default('draft'),
    /** The reviewer's written observations for the committee. */
    content: text('content').notNull(),
    finalisedAt: timestamp('finalised_at', { withTimezone: true }),
    finalisedByUserId: refId('finalised_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    ...timestamps,
    ...rowVersion,
    ...softDelete,
  },
  (table) => [
    index('reviews_org_application_idx').on(table.organisationId, table.applicationId),
    index('reviews_org_reviewer_status_idx').on(
      table.organisationId,
      table.reviewerUserId,
      table.status,
    ),
    tenantIsolationPolicy(),
  ],
).enableRLS();

/** A comment thread entry on a review, before it is finalised. */
export const reviewComments = pgTable(
  'review_comments',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    reviewId: refId('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    authorUserId: refId('author_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('review_comments_org_review_idx').on(table.organisationId, table.reviewId),
    tenantIsolationPolicy(),
  ],
).enableRLS();

export const reviewsRelations = relations(reviews, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [reviews.organisationId],
    references: [organisations.id],
  }),
  application: one(applications, {
    fields: [reviews.applicationId],
    references: [applications.id],
  }),
  reviewer: one(users, {
    fields: [reviews.reviewerUserId],
    references: [users.id],
  }),
  finalisedBy: one(users, {
    fields: [reviews.finalisedByUserId],
    references: [users.id],
  }),
  comments: many(reviewComments),
}));

export const reviewCommentsRelations = relations(reviewComments, ({ one }) => ({
  organisation: one(organisations, {
    fields: [reviewComments.organisationId],
    references: [organisations.id],
  }),
  review: one(reviews, {
    fields: [reviewComments.reviewId],
    references: [reviews.id],
  }),
  author: one(users, {
    fields: [reviewComments.authorUserId],
    references: [users.id],
  }),
}));
