import { and, asc, eq } from 'drizzle-orm';
import { applications, clients, memberships, rightsRequests } from '@/db/schema';
import { currentScope, type TenantScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import {
  canTransition,
  daysRemaining,
  escalationTextFor,
  isClosedStatus,
  isOverdue,
  statutoryDueDate,
  STATUTORY_PERIODS,
  type RightsRequestStatus,
  type RightsRequestType,
} from './rules';
import {
  logRequestSchema,
  updateRequestSchema,
  type LogRequestInput,
  type UpdateRequestInput,
} from './schemas';

/**
 * Rights-request register — tenant-scoped, permission-checked, audited.
 *
 * Staff with `privacy:manage` log a request the moment it arrives; it is given
 * its statutory due date and tracked until a human closes it. Audit metadata
 * carries types, statuses and dates only — never the requester's words.
 */

export type RightsRequestRow = typeof rightsRequests.$inferSelect;

/** A request as shown in the register: the row plus its clock. */
export interface RightsRequestView extends RightsRequestRow {
  readonly daysRemaining: number;
  readonly overdue: boolean;
  readonly legalBasis: string;
  /** Regulator escalation wording for complaints; null otherwise. */
  readonly escalation: string | null;
}

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

export function toView(row: RightsRequestRow, now = new Date()): RightsRequestView {
  const type = row.type as RightsRequestType;
  return {
    ...row,
    daysRemaining: daysRemaining(row.dueAt, now),
    overdue: isOverdue(
      { status: row.status as RightsRequestStatus, dueAt: row.dueAt },
      now,
    ),
    legalBasis: STATUTORY_PERIODS[type].basis,
    escalation: escalationTextFor(type),
  };
}

/** The subject must be someone this organisation actually holds records about. */
async function assertSubjectInTenant(input: {
  subjectClientId?: string | undefined;
  subjectUserId?: string | undefined;
}): Promise<void> {
  const scope = currentScope();
  if (input.subjectClientId) {
    const rows = await scope.db
      .select({ id: clients.id })
      .from(clients)
      .where(scope.where(clients.organisationId, eq(clients.id, input.subjectClientId)))
      .limit(1);
    if (rows.length === 0) throw new AuthorizationError('POLICY_DENIED');
  }
  if (input.subjectUserId) {
    const userId = input.subjectUserId;
    const [member, applicant, client] = await Promise.all([
      scope.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(scope.where(memberships.organisationId, eq(memberships.userId, userId)))
        .limit(1),
      scope.db
        .select({ id: applications.id })
        .from(applications)
        .where(
          scope.where(
            applications.organisationId,
            eq(applications.applicantUserId, userId),
          ),
        )
        .limit(1),
      scope.db
        .select({ id: clients.id })
        .from(clients)
        .where(scope.where(clients.organisationId, eq(clients.linkedUserId, userId)))
        .limit(1),
    ]);
    if (member.length + applicant.length + client.length === 0) {
      throw new AuthorizationError('POLICY_DENIED');
    }
  }
}

/** Log a request and start its statutory clock. Requires `privacy:manage`. */
export async function logRequest(rawInput: LogRequestInput): Promise<RightsRequestView> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  const input = logRequestSchema.parse(rawInput);
  await assertSubjectInTenant(input);

  const receivedAt = input.receivedAt ?? new Date();
  const dueAt = statutoryDueDate(input.type, receivedAt);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(rightsRequests)
    .values(
      scope.insertValues({
        type: input.type,
        subjectClientId: input.subjectClientId ?? null,
        subjectUserId: input.subjectUserId ?? null,
        requesterName: input.requesterName,
        requesterContact: input.requesterContact ?? null,
        details: input.details ?? null,
        receivedAt,
        dueAt,
        loggedByUserId: ctx.userId,
      }),
    )
    .returning();
  const row = must(inserted[0], 'rights request');

  await recordAudit({
    action: 'privacy.request_logged',
    resourceType: 'rights_request',
    resourceId: row.id,
    result: 'success',
    after: {
      data: { type: row.type, dueAt: row.dueAt.toISOString() },
      allow: ['type', 'dueAt'],
    },
  });
  return toView(row);
}

/** The register, soonest-due first. Requires `privacy:manage`. */
export async function listRequests(): Promise<RightsRequestView[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(rightsRequests)
    .where(scope.where(rightsRequests.organisationId))
    .orderBy(asc(rightsRequests.dueAt));
  const now = new Date();
  return rows.map((row) => toView(row, now));
}

/** Load one request in the active tenant, or throw a non-leaking denial. */
export async function loadRequest(id: string): Promise<RightsRequestRow> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(rightsRequests)
    .where(scope.where(rightsRequests.organisationId, eq(rightsRequests.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AuthorizationError('POLICY_DENIED');
  return row;
}

/** Load an open request of one of `types` for acting on. */
export async function loadOpenRequest(
  id: string,
  types: readonly RightsRequestType[],
): Promise<RightsRequestRow> {
  const row = await loadRequest(id);
  if (!types.includes(row.type as RightsRequestType)) {
    throw new AuthorizationError(
      'POLICY_DENIED',
      'This request does not allow that action.',
    );
  }
  if (isClosedStatus(row.status as RightsRequestStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This request is closed.');
  }
  return row;
}

export async function getRequest(id: string): Promise<RightsRequestView> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  return toView(await loadRequest(id));
}

/** Mark an open request in progress once someone has acted on it. */
export async function markInProgress(
  row: RightsRequestRow,
  scope: TenantScope = currentScope(),
): Promise<void> {
  if (row.status !== 'received') return;
  await scope.db
    .update(rightsRequests)
    .set({ status: 'in_progress' })
    .where(
      scope.where(
        rightsRequests.organisationId,
        eq(rightsRequests.id, row.id),
        eq(rightsRequests.status, 'received'),
      ),
    );
}

/** Update status, assignee, outcome or due date. Requires `privacy:manage`. */
export async function updateRequest(
  id: string,
  rawInput: UpdateRequestInput,
): Promise<RightsRequestView> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  const input = updateRequestSchema.parse(rawInput);
  const existing = await loadRequest(id);
  const from = existing.status as RightsRequestStatus;

  if (isClosedStatus(from)) {
    throw new AuthorizationError('POLICY_DENIED', 'This request is closed.');
  }
  if (input.status && !canTransition(from, input.status)) {
    throw new AuthorizationError('POLICY_DENIED', 'That status change is not allowed.');
  }
  if (input.dueAt && input.dueAt.getTime() < existing.dueAt.getTime()) {
    throw new AuthorizationError('POLICY_DENIED', 'A due date can only be extended.');
  }

  const patch: Partial<typeof rightsRequests.$inferInsert> = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.assignedToUserId !== undefined)
    patch.assignedToUserId = input.assignedToUserId;
  if (input.outcome !== undefined) patch.outcome = input.outcome;
  if (input.dueAt !== undefined) {
    patch.dueAt = input.dueAt;
    patch.extensionReason = input.extensionReason ?? null;
  }
  if (input.status && isClosedStatus(input.status)) patch.closedAt = new Date();

  const scope = currentScope();
  const updated = await scope.db
    .update(rightsRequests)
    .set(patch)
    .where(
      scope.where(
        rightsRequests.organisationId,
        and(eq(rightsRequests.id, id), eq(rightsRequests.status, from)),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row)
    throw new AuthorizationError('POLICY_DENIED', 'The request changed; reload it.');

  await recordAudit({
    action: 'privacy.request_updated',
    resourceType: 'rights_request',
    resourceId: id,
    result: 'success',
    before: {
      data: { status: from, dueAt: existing.dueAt.toISOString() },
      allow: ['status', 'dueAt'],
    },
    after: {
      data: {
        status: row.status,
        dueAt: row.dueAt.toISOString(),
        extended: input.dueAt !== undefined,
      },
      allow: ['status', 'dueAt', 'extended'],
    },
  });
  return toView(row);
}
