import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { breakGlassRequests } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit } from '@/domains/audit/service';
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
  type DenyBreakGlassInput,
  type RequestBreakGlassInput,
} from './schemas';
import { canApprove, canDeny, canRevoke, isLive, type BreakGlassStatus } from './status';

/**
 * Break-glass service.
 *
 * Two trust boundaries meet here:
 *   - the PLATFORM operator side (request, activate) — the actor is a platform
 *     user with no membership of the target org; the ROUTE proves they are a
 *     platform operator and have stepped up. These paths write with `db`
 *     directly, scoped to the target organisation id from the request.
 *   - the TENANT approver side (approve, deny, revoke, list) — the actor is a
 *     member of the target org holding `break-glass:approve`; these use the
 *     normal tenant context.
 *
 * Separation of duties: the approver can never be the requester. The read grant
 * (`resolveBreakGlassContext`) is narrow and time-boxed and flags every action.
 */

export type BreakGlassRow = typeof breakGlassRequests.$inferSelect;

/** The narrow, read-only permissions a live break-glass grant confers. */
const BREAK_GLASS_READ_PERMISSIONS: readonly Permission[] = [
  'application:read-any',
  'evidence:read-assigned',
  'audit:view',
];

/** Generic, non-leaking failure for an unusable grant. */
export class BreakGlassError extends Error {
  readonly code = 'BREAK_GLASS_INVALID';
  readonly status = 403;
  constructor(message = 'This break-glass grant is not available.') {
    super(message);
    this.name = 'BreakGlassError';
  }
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
  const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60 * 1000);

  const inserted = await db
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
  const row = expectRow(inserted[0], 'break-glass request');

  await recordAudit({
    action: 'break_glass.requested',
    resourceType: 'break_glass_request',
    resourceId: row.id,
    result: 'success',
    organisationId: input.organisationId,
    actorUserId: params.requestedByUserId,
    actingRole: 'platform-operator',
    sessionId: null,
    correlationId: params.correlationId,
    after: { data: { supportCaseRef: input.supportCaseRef }, allow: ['supportCaseRef'] },
  });
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

  const now = new Date();
  const updated = await db
    .update(breakGlassRequests)
    .set({ status: 'active', activatedAt: now, tenantNotifiedAt: now })
    .where(eq(breakGlassRequests.id, params.requestId))
    .returning();
  const row = expectRow(updated[0], 'break-glass request');

  for (const action of [
    'break_glass.activated',
    'break_glass.tenant_notified',
  ] as const) {
    await recordAudit({
      action,
      resourceType: 'break_glass_request',
      resourceId: row.id,
      result: 'success',
      organisationId: row.organisationId,
      actorUserId: params.activatingUserId,
      actingRole: 'platform-operator',
      sessionId: null,
      correlationId: params.correlationId,
    });
  }
  return row;
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
  const updated = await scope.db
    .update(breakGlassRequests)
    .set({ status: 'approved', approvedByUserId: ctx.userId })
    .where(
      scope.where(
        breakGlassRequests.organisationId,
        eq(breakGlassRequests.id, requestId),
      ),
    )
    .returning();
  const row = expectRow(updated[0], 'break-glass request');

  await recordAudit({
    action: 'break_glass.approved',
    resourceType: 'break_glass_request',
    resourceId: requestId,
    result: 'success',
  });
  return row;
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
  const updated = await scope.db
    .update(breakGlassRequests)
    .set({ status: 'denied' })
    .where(
      scope.where(
        breakGlassRequests.organisationId,
        eq(breakGlassRequests.id, requestId),
      ),
    )
    .returning();
  const row = expectRow(updated[0], 'break-glass request');

  await recordAudit({
    action: 'break_glass.denied',
    resourceType: 'break_glass_request',
    resourceId: requestId,
    result: 'success',
    reason: input.reason,
  });
  return row;
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
  const updated = await scope.db
    .update(breakGlassRequests)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      scope.where(
        breakGlassRequests.organisationId,
        eq(breakGlassRequests.id, requestId),
      ),
    )
    .returning();
  const row = expectRow(updated[0], 'break-glass request');

  await recordAudit({
    action: 'break_glass.revoked',
    resourceType: 'break_glass_request',
    resourceId: requestId,
    result: 'success',
  });
  return row;
}

export async function listBreakGlassRequests(): Promise<BreakGlassRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'break-glass:approve');
  const scope = currentScope();
  return scope.db
    .select()
    .from(breakGlassRequests)
    .where(scope.where(breakGlassRequests.organisationId))
    .orderBy(desc(breakGlassRequests.createdAt));
}

/* --------------------------------------------------------------------------
 * The read grant
 * ------------------------------------------------------------------------ */

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
  if (
    !request ||
    !isLive(request.status as BreakGlassStatus, request.expiresAt, new Date())
  ) {
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
