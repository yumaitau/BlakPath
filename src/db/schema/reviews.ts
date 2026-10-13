import { relations } from 'drizzle-orm';
import { foreignKey, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
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
    applicationId: refId('application_id').notNull(),
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
    foreignKey({
      name: 'reviews_application_same_org_fk',
      columns: [table.organisationId, table.applicationId],
      foreignColumns: [applications.organisationId, applications.id],
    }).onDelete('cascade'),
    unique('reviews_org_id_unique').on(table.organisationId, table.id),
    index('reviews_org_application_idx').on(table.organisationId, table.applicationId),
    index('reviews_org_reviewer_status_idx').on(
      table.organisationId,
      table.reviewerUserId,
      table.status,
    ),
    index('reviews_reviewer_idx').on(table.reviewerUserId),
    index('reviews_finalised_by_idx').on(table.finalisedByUserId),
  ],
);

/** A comment thread entry on a review, before it is finalised. */
export const reviewComments = pgTable(
  'review_comments',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    reviewId: refId('review_id').notNull(),
    authorUserId: refId('author_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    foreignKey({
      name: 'review_comments_review_same_org_fk',
      columns: [table.organisationId, table.reviewId],
      foreignColumns: [reviews.organisationId, reviews.id],
    }).onDelete('cascade'),
    index('review_comments_org_review_idx').on(table.organisationId, table.reviewId),
    index('review_comments_author_idx').on(table.authorUserId),
  ],
);

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
