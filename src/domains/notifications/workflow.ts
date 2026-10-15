import { hasAny, hasPermission, type Subject } from '@/lib/permissions/check';
import type { Permission } from '@/lib/permissions/catalog';
import {
  canReadAnyApplication,
  canReadAssignedApplication,
  canReadTeamApplication,
  type ApplicationReadResource,
} from '@/domains/applications/policies';

/**
 * Staff workflow notification planning.
 *
 * Pure: no database and no email transport. Callers load the tenant's active
 * members and the case's assignees and team, then this module decides who may
 * hear about the event.
 *
 * A recipient must be able to read the case as staff (organisation-wide read,
 * active assignment, or membership of the team that owns the client). An
 * applicant's `application:read-own` grant is never enough. That is the team
 * scoping rule: a notice is not created for someone who cannot open the case.
 *
 * Copy names the kind of work and nothing else. No applicant name, reference,
 * evidence description, file name, review note, or proposed outcome. These
 * notices record that a person needs to act. They do not score, rank, predict,
 * or decide Aboriginality.
 */

/** Permissions that mean "this person works with evidence", not merely reads cases. */
const EVIDENCE_NOTICE_PERMISSIONS = [
  'evidence:read-assigned',
  'evidence:classify',
  'evidence:download',
  'evidence:request',
] as const satisfies readonly Permission[];

export interface StaffMember {
  readonly userId: string;
  readonly permissions: ReadonlySet<string>;
  /** Membership preference. In-app notices are created either way. */
  readonly emailNotifications: boolean;
}

/** The facts a read decision needs. Mirrors {@link ApplicationReadResource}. */
export interface CaseAudience {
  readonly applicantUserId: string | null;
  readonly assigneeUserIds: readonly string[];
  readonly teamMemberUserIds: readonly string[];
}

export type WorkflowEvent =
  | {
      readonly kind: 'assignment';
      readonly applicationId: string;
      readonly assigneeUserId: string;
      readonly actorUserId: string;
    }
  | {
      readonly kind: 'evidence_clean';
      readonly applicationId: string;
      readonly evidenceId: string;
    }
  | {
      readonly kind: 'review_needed';
      readonly applicationId: string;
      readonly actorUserId: string;
    }
  | {
      readonly kind: 'vote_open';
      readonly applicationId: string;
      readonly decisionId: string;
      readonly actorUserId: string;
      readonly conflictedUserIds: readonly string[];
    }
  | {
      readonly kind: 'evidence_overdue';
      readonly applicationId: string;
      readonly requestId: string;
      readonly requestedByUserId: string | null;
    };

/**
 * A workflow event as a caller sees it. Conflicted voters are loaded by the
 * dispatcher, so a proposal does not have to know that set itself.
 */
export type WorkflowNotice =
  | Exclude<WorkflowEvent, { kind: 'vote_open' }>
  | {
      readonly kind: 'vote_open';
      readonly applicationId: string;
      readonly decisionId: string;
      readonly actorUserId: string;
    };

export interface PlannedNotification {
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly resourceType: string;
  readonly resourceId: string;
  /** Whether this member wants the email copy. */
  readonly email: boolean;
}

export interface EvidenceRequestDueState {
  readonly status: string;
  readonly dueAt: Date | null;
  readonly fulfilledAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly overdueNotifiedAt: Date | null;
}

/** True only for an explicit opt-in. A missing membership does not get email. */
export function wantsNotificationEmail(
  emailNotifications: boolean | null | undefined,
): boolean {
  return emailNotifications === true;
}

/**
 * An open request whose due time has passed and which has not already produced
 * an overdue notice. Fulfilled and cancelled requests are never overdue.
 */
export function isOverdueEvidenceRequest(
  request: EvidenceRequestDueState,
  now: Date,
): boolean {
  return (
    request.status === 'open' &&
    request.dueAt !== null &&
    request.dueAt.getTime() < now.getTime() &&
    request.fulfilledAt === null &&
    request.cancelledAt === null &&
    request.overdueNotifiedAt === null
  );
}

function asResource(audience: CaseAudience): ApplicationReadResource {
  return {
    applicantUserId: audience.applicantUserId,
    assigneeUserIds: audience.assigneeUserIds,
    teamMemberUserIds: audience.teamMemberUserIds,
  };
}

function asSubject(member: StaffMember): Subject {
  return { userId: member.userId, permissions: member.permissions };
}

/**
 * Staff read of this case. Applicant-only access does not qualify, so an
 * applicant is not told about internal assignment, review, vote, or scan work.
 */
export function canReadCaseAsStaff(member: StaffMember, audience: CaseAudience): boolean {
  const subject = asSubject(member);
  const resource = asResource(audience);
  return (
    canReadAnyApplication(subject, resource) ||
    canReadAssignedApplication(subject, resource) ||
    canReadTeamApplication(subject, resource)
  );
}

function notice(
  member: StaffMember,
  type: string,
  title: string,
  body: string,
  resourceType: string,
  resourceId: string,
): PlannedNotification {
  return {
    userId: member.userId,
    type,
    title,
    body,
    resourceType,
    resourceId,
    email: wantsNotificationEmail(member.emailNotifications),
  };
}

function readers(
  staff: readonly StaffMember[],
  audience: CaseAudience,
  include: (member: StaffMember) => boolean,
  exclude: ReadonlySet<string>,
): StaffMember[] {
  const seen = new Set<string>();
  const chosen: StaffMember[] = [];
  for (const member of staff) {
    if (seen.has(member.userId) || exclude.has(member.userId)) continue;
    if (!canReadCaseAsStaff(member, audience)) continue;
    if (!include(member)) continue;
    seen.add(member.userId);
    chosen.push(member);
  }
  chosen.sort((left, right) => left.userId.localeCompare(right.userId));
  return chosen;
}

/**
 * Who should hear about this event, and the exact in-app / email copy.
 * Returns an empty list when nobody who can read the case should be told.
 */
export function planWorkflowNotifications(
  event: WorkflowEvent,
  staff: readonly StaffMember[],
  audience: CaseAudience,
): PlannedNotification[] {
  switch (event.kind) {
    case 'assignment': {
      if (event.assigneeUserId === event.actorUserId) return [];
      const member = staff.find((candidate) => candidate.userId === event.assigneeUserId);
      if (!member || !canReadCaseAsStaff(member, audience)) return [];
      return [
        notice(
          member,
          'workflow.assigned',
          'A case was assigned to you',
          'Open BlakPath to see the case. This message does not include case details.',
          'application',
          event.applicationId,
        ),
      ];
    }
    case 'evidence_clean': {
      return readers(
        staff,
        audience,
        (member) => hasAny(asSubject(member), EVIDENCE_NOTICE_PERMISSIONS),
        new Set(),
      ).map((member) =>
        notice(
          member,
          'workflow.evidence_clean',
          'Evidence on a case is ready to view',
          'A safety check finished. Open BlakPath to view the case. This message does not include the file or any case details.',
          'evidence',
          event.evidenceId,
        ),
      );
    }
    case 'review_needed': {
      return readers(
        staff,
        audience,
        (member) => hasPermission(asSubject(member), 'review:create'),
        new Set([event.actorUserId]),
      ).map((member) =>
        notice(
          member,
          'workflow.review_needed',
          'A case needs review',
          'A case you can access is ready for a human review. Open BlakPath to record it. This message does not include case details.',
          'application',
          event.applicationId,
        ),
      );
    }
    case 'vote_open': {
      const exclude = new Set([event.actorUserId, ...event.conflictedUserIds]);
      return readers(
        staff,
        audience,
        (member) => hasPermission(asSubject(member), 'decision:vote'),
        exclude,
      ).map((member) =>
        notice(
          member,
          'workflow.vote_open',
          'A committee vote is open',
          'A vote is open on a case you can access. Open BlakPath to record your vote. This message does not include the proposal.',
          'decision',
          event.decisionId,
        ),
      );
    }
    case 'evidence_overdue': {
      const responsible = new Set<string>(audience.assigneeUserIds);
      if (event.requestedByUserId) responsible.add(event.requestedByUserId);
      return readers(
        staff,
        audience,
        (member) => responsible.has(member.userId),
        new Set(),
      ).map((member) =>
        notice(
          member,
          'workflow.evidence_overdue',
          'An evidence request is overdue',
          'An evidence request on a case you can access is past its due date. Open BlakPath to follow it up. This message does not include what was requested.',
          'evidence_request',
          event.requestId,
        ),
      );
    }
    default: {
      const unreachable: never = event;
      throw new Error(`Unknown workflow event: ${JSON.stringify(unreachable)}`);
    }
  }
}
