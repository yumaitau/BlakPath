import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import {
  applicationAssignments,
  applications,
  clients,
  conflictDeclarations,
  evidenceRequests,
  membershipRoles,
  memberships,
  rolePermissions,
  teamMemberships,
} from '@/db/schema';
import { scopeFor } from '@/db/tenant-db';
import { isPermission } from '@/lib/permissions/catalog';
import { logger } from '@/lib/observability/logger';
import { createNotification } from './service';
import {
  isOverdueEvidenceRequest,
  planWorkflowNotifications,
  type CaseAudience,
  type PlannedNotification,
  type StaffMember,
  type WorkflowEvent,
  type WorkflowNotice,
} from './workflow';

/**
 * Deliver staff workflow notifications.
 *
 * Loads the tenant's active members (with their permission grants and email
 * preference) and the case's assignee and team, then records one in-app notice
 * per planned recipient. Email delivery stays inside `createNotification`, which
 * honours the same preference. A failure here is logged and swallowed: losing a
 * notice must not roll back the human act that caused it, and must not change
 * a fail-secure evidence outcome.
 *
 * Safe to call from a request (after the write commits) and from the worker.
 */

export interface NotifyWorkflowInput {
  readonly organisationId: string;
  readonly correlationId: string;
  readonly event: WorkflowNotice;
}

async function loadStaff(organisationId: string): Promise<StaffMember[]> {
  const scope = scopeFor(organisationId);
  const rows = await scope.db
    .select({
      userId: memberships.userId,
      permissionKey: rolePermissions.permissionKey,
      emailNotifications: memberships.emailNotifications,
    })
    .from(memberships)
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
    .where(
      and(
        eq(memberships.organisationId, organisationId),
        eq(memberships.status, 'active'),
      ),
    );

  const byUser = new Map<
    string,
    { permissions: Set<string>; emailNotifications: boolean }
  >();
  for (const row of rows) {
    const existing = byUser.get(row.userId) ?? {
      permissions: new Set<string>(),
      emailNotifications: row.emailNotifications,
    };
    if (isPermission(row.permissionKey)) existing.permissions.add(row.permissionKey);
    existing.emailNotifications = row.emailNotifications;
    byUser.set(row.userId, existing);
  }

  return [...byUser.entries()].map(([userId, value]) => ({
    userId,
    permissions: value.permissions,
    emailNotifications: value.emailNotifications,
  }));
}

async function loadCaseAudience(
  organisationId: string,
  applicationId: string,
): Promise<CaseAudience | null> {
  const scope = scopeFor(organisationId);
  const applicationRows = await scope.db
    .select({
      applicantUserId: applications.applicantUserId,
      clientId: applications.clientId,
      currentAssigneeUserId: applications.currentAssigneeUserId,
    })
    .from(applications)
    .where(
      scope.where(
        applications.organisationId,
        eq(applications.id, applicationId),
        isNull(applications.deletedAt),
      ),
    )
    .limit(1);
  const application = applicationRows[0];
  if (!application) return null;

  const assigneeRows = await scope.db
    .select({ userId: applicationAssignments.assigneeUserId })
    .from(applicationAssignments)
    .where(
      scope.where(
        applicationAssignments.organisationId,
        eq(applicationAssignments.applicationId, applicationId),
        eq(applicationAssignments.status, 'active'),
      ),
    );

  let teamMemberUserIds: string[] = [];
  if (application.clientId) {
    const teamRows = await scope.db
      .select({ userId: teamMemberships.userId })
      .from(clients)
      .innerJoin(
        teamMemberships,
        and(
          eq(teamMemberships.teamId, clients.assignedTeamId),
          eq(teamMemberships.organisationId, clients.organisationId),
        ),
      )
      .where(
        scope.where(
          clients.organisationId,
          eq(clients.id, application.clientId),
          isNull(clients.deletedAt),
        ),
      );
    teamMemberUserIds = [...new Set(teamRows.map((row) => row.userId))];
  }

  const assigneeUserIds = [
    ...new Set([
      ...assigneeRows.map((row) => row.userId),
      ...(application.currentAssigneeUserId ? [application.currentAssigneeUserId] : []),
    ]),
  ];

  return {
    applicantUserId: application.applicantUserId,
    assigneeUserIds,
    teamMemberUserIds,
  };
}

async function loadConflictedUserIds(
  organisationId: string,
  applicationId: string,
): Promise<string[]> {
  const scope = scopeFor(organisationId);
  const rows = await scope.db
    .select({ userId: conflictDeclarations.declaredByUserId })
    .from(conflictDeclarations)
    .where(
      scope.where(
        conflictDeclarations.organisationId,
        eq(conflictDeclarations.applicationId, applicationId),
        inArray(conflictDeclarations.status, ['declared', 'recused']),
      ),
    );
  return [...new Set(rows.map((row) => row.userId))];
}

async function deliver(
  organisationId: string,
  correlationId: string,
  planned: readonly PlannedNotification[],
): Promise<number> {
  let sent = 0;
  for (const item of planned) {
    try {
      await createNotification(
        {
          organisationId,
          userId: item.userId,
          type: item.type,
          title: item.title,
          body: item.body,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
        },
        correlationId,
      );
      sent += 1;
    } catch (err) {
      logger.error(
        { err, organisationId, type: item.type },
        'failed to create workflow notification',
      );
    }
  }
  return sent;
}

/** Record in-app notices for one workflow event. Returns how many were stored. */
export async function notifyWorkflowEvent(input: NotifyWorkflowInput): Promise<number> {
  const { organisationId, correlationId, event } = input;
  try {
    const audience = await loadCaseAudience(organisationId, event.applicationId);
    if (!audience) return 0;
    const staff = await loadStaff(organisationId);
    const resolved: WorkflowEvent =
      event.kind === 'vote_open'
        ? {
            ...event,
            conflictedUserIds: await loadConflictedUserIds(
              organisationId,
              event.applicationId,
            ),
          }
        : event;
    const planned = planWorkflowNotifications(resolved, staff, audience);
    return await deliver(organisationId, correlationId, planned);
  } catch (err) {
    logger.error(
      { err, organisationId, kind: event.kind },
      'workflow notification failed',
    );
    return 0;
  }
}

/**
 * Tell the requester and the current assignee, when they can still read the
 * case, that an evidence request is past its due date. Each request is claimed
 * before delivery so a later sweep does not send the notice again.
 */
export async function processOverdueEvidenceSweep(input: {
  organisationId: string;
  correlationId: string;
  now?: Date;
}): Promise<{ notified: number }> {
  const { organisationId, correlationId } = input;
  const now = input.now ?? new Date();
  const scope = scopeFor(organisationId);

  const due = await scope.db
    .select({
      id: evidenceRequests.id,
      applicationId: evidenceRequests.applicationId,
      requestedByUserId: evidenceRequests.requestedByUserId,
      status: evidenceRequests.status,
      dueAt: evidenceRequests.dueAt,
      fulfilledAt: evidenceRequests.fulfilledAt,
      cancelledAt: evidenceRequests.cancelledAt,
      overdueNotifiedAt: evidenceRequests.overdueNotifiedAt,
    })
    .from(evidenceRequests)
    .where(
      and(
        eq(evidenceRequests.organisationId, organisationId),
        eq(evidenceRequests.status, 'open'),
        isNull(evidenceRequests.overdueNotifiedAt),
        isNull(evidenceRequests.fulfilledAt),
        isNull(evidenceRequests.cancelledAt),
        isNotNull(evidenceRequests.dueAt),
        lt(evidenceRequests.dueAt, now),
      ),
    )
    .limit(200);

  const pending = due.filter((request) => isOverdueEvidenceRequest(request, now));
  if (pending.length === 0) return { notified: 0 };

  const staff = await loadStaff(organisationId);
  const audiences = new Map<string, CaseAudience | null>();
  let notified = 0;

  for (const request of pending) {
    const claimed = await scope.db
      .update(evidenceRequests)
      .set({ overdueNotifiedAt: now })
      .where(
        and(
          eq(evidenceRequests.organisationId, organisationId),
          eq(evidenceRequests.id, request.id),
          isNull(evidenceRequests.overdueNotifiedAt),
        ),
      )
      .returning({ id: evidenceRequests.id });
    if (claimed.length === 0) continue;

    try {
      let audience = audiences.get(request.applicationId);
      if (audience === undefined) {
        audience = await loadCaseAudience(organisationId, request.applicationId);
        audiences.set(request.applicationId, audience);
      }
      if (!audience) continue;

      const planned = planWorkflowNotifications(
        {
          kind: 'evidence_overdue',
          applicationId: request.applicationId,
          requestId: request.id,
          requestedByUserId: request.requestedByUserId,
        },
        staff,
        audience,
      );
      notified += await deliver(organisationId, correlationId, planned);
    } catch (err) {
      logger.error(
        { err, organisationId, requestId: request.id },
        'overdue evidence notification failed',
      );
    }
  }

  return { notified };
}
