import { and, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  auditEvents,
  breakGlassRequests,
  membershipRoles,
  memberships,
  rolePermissions,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { auditReason } from '@/domains/audit/hash';
import { recordAudit, type AuditTransaction } from '@/domains/audit/service';
import { createNotification } from '@/domains/notifications';
import { sanitiseError } from '@/lib/http/error-response';
import { logger } from '@/lib/observability/logger';
import { requireTenantContext, type TenantContext } from '@/lib/tenancy/context';
import {
  assertDifferentActor,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import type { Permission } from '@/lib/permissions/catalog';
import {
  denyBreakGlassSchema,
  requestBreakGlassSchema,
  reviewBreakGlassSchema,
  type DenyBreakGlassInput,
  type RequestBreakGlassInput,
  type ReviewBreakGlassInput,
} from './schemas';
import {
  addBusinessDays,
  BREAK_GLASS_REVIEW_BUSINESS_DAYS,
  BREAK_GLASS_REVIEW_TIME_ZONE,
  canApprove,
  canDeny,
  canReview,
  canRevoke,
  isLive,
  isReviewOverdue,
  type BreakGlassStatus,
} from './status';

/**
 * Break-glass service.
 *
 * Two trust boundaries meet here:
 *   - the PLATFORM operator side (request, activate, read under a live grant)
 *     — the actor is a platform user with no membership of the target org; the
 *     ROUTE proves they are a platform operator. Request and activate also
 *     require step-up. These paths write with `db` directly, scoped to the
 *     target organisation id from the grant.
 *   - the TENANT approver side (approve, deny, revoke, review, list) — the
 *     actor is a member of the target org holding `break-glass:approve`.
 *
 * Separation of duties: the approver can never be the requester. A live grant
 * is read-only, time-boxed, and every audit written under it carries the
 * break-glass flag. Activation notifies approvers in the app and by email.
 * A human review is due five business days after activation.
 */

export type BreakGlassRow = typeof breakGlassRequests.$inferSelect;

/** Safe audit row returned to an operator reading under a live grant. */
export interface BreakGlassAuditItem {
  id: string;
  timestamp: Date;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: string;
  actingRole: string | null;
  breakGlass: boolean;
  breakGlassRequestId: string | null;
}

/** The narrow, read-only permissions a live break-glass grant confers. */
const BREAK_GLASS_READ_PERMISSIONS: readonly Permission[] = [
  'application:read-any',
  'evidence:read-assigned',
  'audit:view',
];

const REVIEWABLE_STATUSES = ['active', 'expired', 'revoked'] as const;

/** Generic, non-leaking failure for an unusable grant. */
export class BreakGlassError extends Error {
  readonly code = 'BREAK_GLASS_INVALID';
  readonly status = 403;
  constructor(message = 'This break-glass grant is not available.') {
    super(message);
    this.name = 'BreakGlassError';
  }
}

/** Safe operational failure: nothing here reveals tenant records. */
export class BreakGlassNotifyError extends Error {
  readonly code = 'BREAK_GLASS_NOTIFY_FAILED';
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'BreakGlassNotifyError';
  }
}

/** A used grant for this organisation still has no review after its due date. */
export class BreakGlassReviewOverdueError extends Error {
  readonly code = 'BREAK_GLASS_REVIEW_OVERDUE';
  readonly status = 409;
  constructor() {
    super('A previous emergency-access review is overdue for this organisation.');
    this.name = 'BreakGlassReviewOverdueError';
  }
}

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

function formatReviewDue(due: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: BREAK_GLASS_REVIEW_TIME_ZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(due);
}

async function approverUserIds(organisationId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
    .where(
      and(
        eq(memberships.organisationId, organisationId),
        eq(memberships.status, 'active'),
        eq(rolePermissions.permissionKey, 'break-glass:approve'),
      ),
    );
  return rows.map((row) => row.userId);
}

async function notifyApprovers(input: {
  organisationId: string;
  correlationId: string;
  requestId: string;
  type: 'break_glass.requested' | 'break_glass.activated';
  title: string;
  body: string;
}): Promise<void> {
  const userIds = await approverUserIds(input.organisationId);
  if (userIds.length === 0) {
    throw new BreakGlassNotifyError('No tenant approver is available to notify.');
  }
  for (const userId of userIds) {
    await createNotification(
      {
        organisationId: input.organisationId,
        userId,
        type: input.type,
        title: input.title,
        body: input.body,
        resourceType: 'break_glass_request',
        resourceId: input.requestId,
      },
      input.correlationId,
    );
  }
}

async function auditExpiries(
  rows: readonly { id: string; organisationId: string }[],
  tx: AuditTransaction,
): Promise<void> {
  for (const row of rows) {
    await recordAudit(
      {
        action: 'break_glass.expired',
        resourceType: 'break_glass_request',
        resourceId: row.id,
        result: 'success',
        organisationId: row.organisationId,
        actorUserId: null,
        actingRole: 'system',
        sessionId: null,
      },
      tx,
    );
  }
}

/** Move elapsed active grants to `expired`. System actor, not whoever listed them. */
async function expireElapsedInTenant(): Promise<void> {
  const scope = currentScope();
  await scope.db.transaction(async (tx) => {
    const stale = await tx
      .update(breakGlassRequests)
      .set({ status: 'expired' })
      .where(
        scope.where(
          breakGlassRequests.organisationId,
          eq(breakGlassRequests.status, 'active'),
          lt(breakGlassRequests.expiresAt, new Date()),
        ),
      )
      .returning({
        id: breakGlassRequests.id,
        organisationId: breakGlassRequests.organisationId,
      });
    await auditExpiries(stale, tx);
  });
}

async function assertNoOverdueReview(organisationId: string): Promise<void> {
  const rows = await db
    .select({ id: breakGlassRequests.id })
    .from(breakGlassRequests)
    .where(
      and(
        eq(breakGlassRequests.organisationId, organisationId),
        isNull(breakGlassRequests.reviewedAt),
        isNotNull(breakGlassRequests.reviewDueAt),
        lt(breakGlassRequests.reviewDueAt, new Date()),
        inArray(breakGlassRequests.status, [...REVIEWABLE_STATUSES]),
      ),
    )
    .limit(1);
  if (rows[0]) throw new BreakGlassReviewOverdueError();
}

/* --------------------------------------------------------------------------
 * Platform-operator side (cross-tenant; route proves operator + step-up)
 * ------------------------------------------------------------------------ */

export async function requestBreakGlass(params: {
  requestedByUserId: string;
  correlationId: string;
  input: RequestBreakGlassInput;
}): Promise<BreakGlassRow> {
  const input = requestBreakGlassSchema.parse(params.input);
  await assertNoOverdueReview(input.organisationId);
  const approvers = await approverUserIds(input.organisationId);
  if (approvers.length === 0) {
    throw new BreakGlassNotifyError('No tenant approver is available to notify.');
  }

  const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60 * 1000);
  const row = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(breakGlassRequests)
      .values({
        organisationId: input.organisationId,
        supportCaseRef: input.supportCaseRef,
        requestedByUserId: params.requestedByUserId,
        purpose: input.purpose,
        scope: input.scope,
        status: 'requested',
        stepUpVerified: true,
        expiresAt,
      })
      .returning();
    const row = must(inserted[0], 'break-glass request');

    await recordAudit(
      {
        action: 'break_glass.requested',
        resourceType: 'break_glass_request',
        resourceId: row.id,
        result: 'success',
        organisationId: input.organisationId,
        actorUserId: params.requestedByUserId,
        actingRole: 'platform-operator',
        sessionId: null,
        correlationId: params.correlationId,
        after: {
          data: { supportCaseRef: input.supportCaseRef },
          allow: ['supportCaseRef'],
        },
      },
      tx,
    );
    return row;
  });

  try {
    await notifyApprovers({
      organisationId: row.organisationId,
      correlationId: params.correlationId,
      requestId: row.id,
      type: 'break_glass.requested',
      title: 'Emergency access requested',
      body: `A platform operator requested emergency read access for support case ${row.supportCaseRef}. Open Break-glass in BlakPath to approve or deny it. This does not decide Aboriginality.`,
    });
  } catch (error) {
    logger.error(
      { err: sanitiseError(error), requestId: row.id },
      'break-glass request notification failed',
    );
    if (error instanceof BreakGlassNotifyError) throw error;
    throw new BreakGlassNotifyError('Tenant notification could not be sent.');
  }
  return row;
}

export async function activateBreakGlass(params: {
  requestId: string;
  activatingUserId: string;
  correlationId: string;
}): Promise<BreakGlassRow> {
  const rows = await db
    .select()
    .from(breakGlassRequests)
    .where(eq(breakGlassRequests.id, params.requestId))
    .limit(1);
  const request = rows[0];
  if (
    !request ||
    request.status !== 'approved' ||
    request.requestedByUserId !== params.activatingUserId ||
    (request.expiresAt && request.expiresAt.getTime() < Date.now())
  ) {
    throw new BreakGlassError();
  }

  const approvers = await approverUserIds(request.organisationId);
  if (approvers.length === 0) {
    throw new BreakGlassNotifyError('No tenant approver is available to notify.');
  }

  const now = new Date();
  const reviewDueAt = addBusinessDays(now, BREAK_GLASS_REVIEW_BUSINESS_DAYS);
  const updated = await db
    .update(breakGlassRequests)
    .set({ status: 'active', activatedAt: now, reviewDueAt })
    .where(
      and(
        eq(breakGlassRequests.id, params.requestId),
        eq(breakGlassRequests.status, 'approved'),
        eq(breakGlassRequests.requestedByUserId, params.activatingUserId),
      ),
    )
    .returning();
  const activated = updated[0];
  if (!activated) throw new BreakGlassError();

  try {
    await notifyApprovers({
      organisationId: activated.organisationId,
      correlationId: params.correlationId,
      requestId: activated.id,
      type: 'break_glass.activated',
      title: 'Emergency access is active',
      body: `Emergency read access is active for support case ${activated.supportCaseRef}. It is read-only and ends at expiry. A review record is due by ${formatReviewDue(reviewDueAt)} (5 business days, Australia/Sydney, weekends excluded). Open Break-glass in BlakPath. This does not decide Aboriginality.`,
    });
  } catch (error) {
    await db
      .update(breakGlassRequests)
      .set({ status: 'approved', activatedAt: null, reviewDueAt: null })
      .where(
        and(
          eq(breakGlassRequests.id, activated.id),
          eq(breakGlassRequests.status, 'active'),
          isNull(breakGlassRequests.tenantNotifiedAt),
        ),
      );
    logger.error(
      { err: sanitiseError(error), requestId: activated.id },
      'break-glass activation notification failed',
    );
    if (error instanceof BreakGlassNotifyError) throw error;
    throw new BreakGlassNotifyError('Tenant notification could not be sent.');
  }

  // The grant is not usable until `tenantNotifiedAt` is set (see
  // resolveBreakGlassContext). Setting it and both audit events commit together.
  return db.transaction(async (tx) => {
    const notified = await tx
      .update(breakGlassRequests)
      .set({ tenantNotifiedAt: new Date() })
      .where(eq(breakGlassRequests.id, activated.id))
      .returning();
    const row = must(notified[0], 'break-glass request');

    for (const action of [
      'break_glass.activated',
      'break_glass.tenant_notified',
    ] as const) {
      await recordAudit(
        {
          action,
          resourceType: 'break_glass_request',
          resourceId: row.id,
          result: 'success',
          organisationId: row.organisationId,
          actorUserId: params.activatingUserId,
          actingRole: 'platform-operator',
          sessionId: null,
          correlationId: params.correlationId,
          after: {
            data: { reviewDueAt: reviewDueAt.toISOString() },
            allow: ['reviewDueAt'],
          },
        },
        tx,
      );
    }
    return row;
  });
}

/** Grants raised by this operator. No other operator's requests are included. */
export async function listOwnBreakGlassRequests(
  userId: string,
): Promise<BreakGlassRow[]> {
  return db
    .select()
    .from(breakGlassRequests)
    .where(eq(breakGlassRequests.requestedByUserId, userId))
    .orderBy(desc(breakGlassRequests.createdAt));
}

/* --------------------------------------------------------------------------
 * Tenant approver side (normal tenant context; break-glass:approve)
 * ------------------------------------------------------------------------ */

async function loadInTenant(id: string): Promise<BreakGlassRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(breakGlassRequests)
    .where(scope.where(breakGlassRequests.organisationId, eq(breakGlassRequests.id, id)))
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

export async function approveBreakGlass(requestId: string): Promise<BreakGlassRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'break-glass:approve');

  const request = await loadInTenant(requestId);
  if (!request) throw new AuthorizationError('POLICY_DENIED');
  if (!canApprove(request.status as BreakGlassStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This request cannot be approved.');
  }
  // Separation of duties: an approver must not be the requester.
  assertDifferentActor(ctx.userId, request.requestedByUserId);

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(breakGlassRequests)
      .set({ status: 'approved', approvedByUserId: ctx.userId })
      .where(
        scope.where(
          breakGlassRequests.organisationId,
          eq(breakGlassRequests.id, requestId),
        ),
      )
      .returning();
    const row = must(updated[0], 'break-glass request');

    await recordAudit(
      {
        action: 'break_glass.approved',
        resourceType: 'break_glass_request',
        resourceId: requestId,
        result: 'success',
      },
      tx,
    );
    return row;
  });
}

export async function denyBreakGlass(
  requestId: string,
  rawInput: DenyBreakGlassInput,
): Promise<BreakGlassRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'break-glass:approve');

  const input = denyBreakGlassSchema.parse(rawInput);
  const request = await loadInTenant(requestId);
  if (!request) throw new AuthorizationError('POLICY_DENIED');
  if (!canDeny(request.status as BreakGlassStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This request cannot be denied.');
  }

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(breakGlassRequests)
      .set({ status: 'denied', denialReason: input.reason })
      .where(
        scope.where(
          breakGlassRequests.organisationId,
          eq(breakGlassRequests.id, requestId),
        ),
      )
      .returning();
    const row = must(updated[0], 'break-glass request');

    await recordAudit(
      {
        action: 'break_glass.denied',
        resourceType: 'break_glass_request',
        resourceId: requestId,
        result: 'success',
        reason: auditReason('break_glass.denied', requestId),
      },
      tx,
    );
    return row;
  });
}

export async function revokeBreakGlass(requestId: string): Promise<BreakGlassRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'break-glass:approve');

  const request = await loadInTenant(requestId);
  if (!request) throw new AuthorizationError('POLICY_DENIED');
  if (!canRevoke(request.status as BreakGlassStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This request cannot be revoked.');
  }

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(breakGlassRequests)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(
        scope.where(
          breakGlassRequests.organisationId,
          eq(breakGlassRequests.id, requestId),
        ),
      )
      .returning();
    const row = must(updated[0], 'break-glass request');

    await recordAudit(
      {
        action: 'break_glass.revoked',
        resourceType: 'break_glass_request',
        resourceId: requestId,
        result: 'success',
      },
      tx,
    );
    return row;
  });
}

/**
 * Record the human review of a used grant. Notes are required. The requester
 * cannot review their own access. Filing the review does not judge identity.
 */
export async function reviewBreakGlass(
  requestId: string,
  rawInput: ReviewBreakGlassInput,
): Promise<BreakGlassRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'break-glass:approve');

  const input = reviewBreakGlassSchema.parse(rawInput);
  const request = await loadInTenant(requestId);
  if (!request) throw new AuthorizationError('POLICY_DENIED');
  // Review is post-use: the grant must have been activated. Revoking an
  // approval before activation does not create a review obligation.
  if (
    !canReview(request.status as BreakGlassStatus) ||
    request.reviewedAt ||
    !request.activatedAt
  ) {
    throw new AuthorizationError('POLICY_DENIED', 'This request cannot be reviewed.');
  }
  assertDifferentActor(ctx.userId, request.requestedByUserId);

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(breakGlassRequests)
      .set({
        reviewedAt: new Date(),
        reviewedByUserId: ctx.userId,
        reviewNotes: input.notes,
      })
      .where(
        scope.where(
          breakGlassRequests.organisationId,
          eq(breakGlassRequests.id, requestId),
          isNull(breakGlassRequests.reviewedAt),
        ),
      )
      .returning();
    const row = updated[0];
    if (!row)
      throw new AuthorizationError('POLICY_DENIED', 'This request cannot be reviewed.');

    // The notes stay on the mutable row. The append-only trail gets a code.
    await recordAudit(
      {
        action: 'break_glass.reviewed',
        resourceType: 'break_glass_request',
        resourceId: requestId,
        result: 'success',
        reason: auditReason('break_glass.reviewed'),
      },
      tx,
    );
    return row;
  });
}

export async function listBreakGlassRequests(): Promise<BreakGlassRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'break-glass:approve');
  await expireElapsedInTenant();
  const scope = currentScope();
  return scope.db
    .select()
    .from(breakGlassRequests)
    .where(scope.where(breakGlassRequests.organisationId))
    .orderBy(desc(breakGlassRequests.createdAt));
}

/** Whether the tenant still owes a review. Used by the approval screen. */
export function breakGlassReviewOverdue(row: BreakGlassRow, now = new Date()): boolean {
  return isReviewOverdue(
    row.status as BreakGlassStatus,
    row.reviewDueAt,
    row.reviewedAt,
    now,
  );
}

/* --------------------------------------------------------------------------
 * The read grant
 * ------------------------------------------------------------------------ */

async function auditDeniedAccess(
  request: BreakGlassRow,
  params: { userId: string; correlationId: string; reqId: string },
  reason: string,
): Promise<void> {
  await recordAudit({
    action: 'break_glass.accessed',
    resourceType: 'break_glass_request',
    resourceId: request.id,
    result: 'denied',
    reason,
    organisationId: request.organisationId,
    actorUserId: params.userId,
    actingRole: 'break-glass',
    sessionId: request.id,
    correlationId: params.correlationId,
    requestId: params.reqId,
    after: {
      data: { breakGlass: true, breakGlassRequestId: request.id },
      allow: ['breakGlass', 'breakGlassRequestId'],
    },
  });
}

/**
 * Build a narrow, time-boxed break-glass TenantContext for the target org, if
 * the grant is LIVE and belongs to `userId`. Every action taken under it is
 * flagged via `breakGlass`. Throws {@link BreakGlassError} otherwise.
 */
export async function resolveBreakGlassContext(params: {
  requestId: string;
  userId: string;
  correlationId: string;
  reqId: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}): Promise<TenantContext> {
  const rows = await db
    .select()
    .from(breakGlassRequests)
    .where(
      and(
        eq(breakGlassRequests.id, params.requestId),
        eq(breakGlassRequests.requestedByUserId, params.userId),
      ),
    )
    .limit(1);
  const request = rows[0];
  const now = new Date();
  if (
    request &&
    request.status === 'active' &&
    request.expiresAt &&
    request.expiresAt.getTime() <= now.getTime()
  ) {
    await db.transaction(async (tx) => {
      const expired = await tx
        .update(breakGlassRequests)
        .set({ status: 'expired' })
        .where(
          and(
            eq(breakGlassRequests.id, request.id),
            eq(breakGlassRequests.status, 'active'),
          ),
        )
        .returning({
          id: breakGlassRequests.id,
          organisationId: breakGlassRequests.organisationId,
        });
      await auditExpiries(expired, tx);
    });
    await auditDeniedAccess(request, params, 'break_glass.grant_expired');
    throw new BreakGlassError();
  }
  // A grant is usable only once the tenant has been notified of activation.
  if (
    !request ||
    !request.tenantNotifiedAt ||
    !isLive(request.status as BreakGlassStatus, request.expiresAt, now)
  ) {
    if (request) await auditDeniedAccess(request, params, 'break_glass.grant_not_live');
    throw new BreakGlassError();
  }

  return {
    organisationId: request.organisationId,
    userId: params.userId,
    membershipId: request.id,
    permissions: new Set<Permission>(BREAK_GLASS_READ_PERMISSIONS),
    roles: ['break-glass'],
    sessionId: request.id,
    correlationId: params.correlationId,
    requestId: params.reqId,
    breakGlass: { requestId: request.id, reason: request.purpose },
    ...(params.ipAddress !== undefined ? { ipAddress: params.ipAddress } : {}),
    ...(params.userAgent !== undefined ? { userAgent: params.userAgent } : {}),
  } satisfies TenantContext;
}

/**
 * Latest audit events for the grant's organisation. Only callable under a live
 * break-glass context that holds `audit:view`. Metadata bodies are omitted;
 * the break-glass flag is projected from `afterMeta`.
 */
export async function listBreakGlassAudit(limit = 50): Promise<BreakGlassAuditItem[]> {
  const ctx = requireTenantContext();
  if (!ctx.breakGlass) throw new AuthorizationError('POLICY_DENIED');
  requirePermission(subjectFromContext(ctx), 'audit:view');

  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const scope = currentScope();
  const rows = await scope.db
    .select({
      id: auditEvents.id,
      timestamp: auditEvents.timestamp,
      action: auditEvents.action,
      resourceType: auditEvents.resourceType,
      resourceId: auditEvents.resourceId,
      result: auditEvents.result,
      actingRole: auditEvents.actingRole,
      afterMeta: auditEvents.afterMeta,
    })
    .from(auditEvents)
    .where(scope.where(auditEvents.organisationId))
    .orderBy(desc(auditEvents.timestamp))
    .limit(safeLimit);

  return rows.map((row) => {
    const meta =
      row.afterMeta && typeof row.afterMeta === 'object' && !Array.isArray(row.afterMeta)
        ? (row.afterMeta as Record<string, unknown>)
        : null;
    const requestId = meta?.breakGlassRequestId;
    return {
      id: row.id,
      timestamp: row.timestamp,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      result: row.result,
      actingRole: row.actingRole,
      breakGlass: meta?.breakGlass === true,
      breakGlassRequestId: typeof requestId === 'string' ? requestId : null,
    };
  });
}
