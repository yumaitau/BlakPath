import { and, desc, eq, isNull } from 'drizzle-orm';
import { reviews, reviewComments } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import {
  beforeConditionalWrite,
  nextRowVersion,
  takeVersionText,
  versionedSelection,
  versionMatches,
} from '@/lib/concurrency/claim';
import { ConcurrencyConflictError } from '@/lib/concurrency/error';
import { recordAudit } from '@/domains/audit/service';
import { getApplication } from '@/domains/applications';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import {
  addReviewCommentSchema,
  createReviewSchema,
  type AddReviewCommentInput,
  type CreateReviewInput,
} from './schemas';
import { canComment, canFinalise, canReopen, type ReviewStatus } from './status';

/**
 * Reviews service — tenant-scoped, permission-checked, audited.
 *
 * A review records a worker's observations for the committee. Creating and
 * finalising are separate capabilities; finalising only locks the human record
 * and never decides the application (that is Phase 5, and always a human act).
 */

export type ReviewRow = typeof reviews.$inferSelect;
export type ReviewCommentRow = typeof reviewComments.$inferSelect;

/** Load a live review within the active tenant scope. */
async function loadReview(id: string): Promise<ReviewRow | null> {
  const loaded = await loadReviewClaim(id);
  return loaded?.row ?? null;
}

async function loadReviewClaim(
  id: string,
): Promise<{ row: ReviewRow; versionText: string } | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select(versionedSelection(reviews))
    .from(reviews)
    .where(
      scope.where(reviews.organisationId, eq(reviews.id, id), isNull(reviews.deletedAt)),
    )
    .limit(1);
  const owned = scope.assertOwned(rows[0]);
  if (!owned) return null;
  const split = takeVersionText(owned);
  if (!split) return null;
  return { row: split.record as ReviewRow, versionText: split.versionText };
}

/** Create a draft review on an application the actor may read. */
export async function createReview(
  applicationId: string,
  rawInput: CreateReviewInput,
): Promise<ReviewRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'review:create');

  const input = createReviewSchema.parse(rawInput);
  // Enforce readability of the application (audits the view).
  await getApplication(applicationId);

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(reviews)
      .values(
        scope.insertValues({
          applicationId,
          reviewerUserId: ctx.userId,
          status: 'draft',
          content: input.content,
        }),
      )
      .returning();
    const row = expectRow(inserted[0], 'review');

    await recordAudit(
      {
        action: 'review.started',
        resourceType: 'review',
        resourceId: row.id,
        result: 'success',
        after: { data: { applicationId }, allow: ['applicationId'] },
      },
      tx,
    );

    return row;
  });
}

/** Add a comment to a draft review. */
export async function addReviewComment(
  reviewId: string,
  rawInput: AddReviewCommentInput,
): Promise<ReviewCommentRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'review:create');

  const input = addReviewCommentSchema.parse(rawInput);
  const review = await loadReview(reviewId);
  if (!review) throw new AuthorizationError('POLICY_DENIED');
  if (!canComment(review.status as ReviewStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This review is finalised.');
  }

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(reviewComments)
      .values(
        scope.insertValues({
          reviewId,
          authorUserId: ctx.userId,
          body: input.body,
        }),
      )
      .returning();
    const row = expectRow(inserted[0], 'review comment');

    await recordAudit(
      {
        action: 'review.comment_added',
        resourceType: 'review',
        resourceId: reviewId,
        result: 'success',
      },
      tx,
    );

    return row;
  });
}

/** Finalise a draft review, locking it into the committee record. */
export async function finaliseReview(reviewId: string): Promise<ReviewRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'review:finalise');

  const loaded = await loadReviewClaim(reviewId);
  if (!loaded) throw new AuthorizationError('POLICY_DENIED');
  const review = loaded.row;
  if (!canFinalise(review.status as ReviewStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This review cannot be finalised.');
  }

  const scope = currentScope();
  await beforeConditionalWrite();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(reviews)
      .set({
        status: 'finalised',
        finalisedAt: new Date(),
        finalisedByUserId: ctx.userId,
        version: nextRowVersion(),
      })
      .where(
        scope.where(
          reviews.organisationId,
          eq(reviews.id, reviewId),
          eq(reviews.status, 'draft'),
          versionMatches(reviews.version, loaded.versionText),
        ),
      )
      .returning();
    if (updated.length === 0) {
      throw new ConcurrencyConflictError(
        'This review changed while you were working. Refresh and try again.',
      );
    }
    const row = expectRow(updated[0], 'review');

    await recordAudit(
      {
        action: 'review.completed',
        resourceType: 'review',
        resourceId: reviewId,
        result: 'success',
        before: { data: { status: 'draft' }, allow: ['status'] },
        after: { data: { status: 'finalised' }, allow: ['status'] },
      },
      tx,
    );

    return row;
  });
}

/** Reopen a finalised review back to draft. */
export async function reopenReview(reviewId: string): Promise<ReviewRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'review:finalise');

  const loaded = await loadReviewClaim(reviewId);
  if (!loaded) throw new AuthorizationError('POLICY_DENIED');
  const review = loaded.row;
  if (!canReopen(review.status as ReviewStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This review is not finalised.');
  }

  const scope = currentScope();
  await beforeConditionalWrite();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(reviews)
      .set({ status: 'draft', reopenedAt: new Date(), version: nextRowVersion() })
      .where(
        scope.where(
          reviews.organisationId,
          eq(reviews.id, reviewId),
          eq(reviews.status, 'finalised'),
          versionMatches(reviews.version, loaded.versionText),
        ),
      )
      .returning();
    if (updated.length === 0) {
      throw new ConcurrencyConflictError(
        'This review changed while you were working. Refresh and try again.',
      );
    }
    const row = expectRow(updated[0], 'review');

    await recordAudit(
      {
        action: 'review.reopened',
        resourceType: 'review',
        resourceId: reviewId,
        result: 'success',
      },
      tx,
    );

    return row;
  });
}

/** List reviews for an application the actor may read. */
export async function listReviewsForApplication(
  applicationId: string,
): Promise<ReviewRow[]> {
  // Enforces the application read policy and audits the view.
  await getApplication(applicationId);

  const scope = currentScope();
  return scope.db
    .select()
    .from(reviews)
    .where(
      scope.where(
        reviews.organisationId,
        eq(reviews.applicationId, applicationId),
        isNull(reviews.deletedAt),
      ),
    )
    .orderBy(desc(reviews.createdAt));
}

/** List comments on a review. */
export async function listReviewComments(reviewId: string): Promise<ReviewCommentRow[]> {
  const review = await loadReview(reviewId);
  if (!review) throw new AuthorizationError('POLICY_DENIED');
  // Reading a review's comments requires being able to read its application.
  await getApplication(review.applicationId);

  const scope = currentScope();
  return scope.db
    .select()
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.organisationId, scope.organisationId),
        eq(reviewComments.reviewId, reviewId),
        isNull(reviewComments.deletedAt),
      ),
    )
    .orderBy(desc(reviewComments.createdAt));
}
