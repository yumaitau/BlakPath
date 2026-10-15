import { ACTIVE_STATUSES, type ApplicationStatus } from '@/domains/applications/workflow';

/**
 * Applicant portal projection.
 *
 * This is the only shape the portal renders. It is a record of what authorised
 * people have already written down: status changes, requests, notes they marked
 * shared, and a finalised outcome. It has no progress fraction, likelihood,
 * score, rank, or prediction. BlakPath does not determine Aboriginality.
 */

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  draft: 'Started, not yet sent',
  submitted: 'Sent to the organisation',
  intake_review: 'With the organisation for intake',
  awaiting_evidence: 'The organisation has asked for more information',
  in_review: 'Being reviewed by the organisation',
  ready_for_committee: "Ready for the organisation's committee",
  in_committee: "With the organisation's committee",
  decided: 'The organisation has recorded an outcome',
  withdrawn: 'Withdrawn',
  closed: 'Closed',
};

const ACTION_SUMMARIES: Record<string, string> = {
  create: 'The application was started',
  submit: 'The application was sent to the organisation',
  begin_intake: 'The organisation started intake',
  request_evidence: 'The organisation asked for more information',
  provide_evidence: 'Information was marked as provided',
  start_review: 'The organisation started review',
  ready_for_committee: 'The organisation marked it ready for committee',
  schedule_committee: 'The organisation recorded a committee sitting',
  record_decision: 'The organisation recorded that a decision was made',
  withdraw: 'The application was withdrawn',
  reopen: 'The organisation reopened the application',
  close: 'The organisation closed the record',
};

const OUTCOME_LABELS = {
  confirmed: 'The organisation recorded a confirmation.',
  not_confirmed: 'The organisation recorded that it did not confirm this application.',
  deferred: 'The organisation recorded that this application is deferred.',
} as const;

export type RecordedOutcome = keyof typeof OUTCOME_LABELS;

export interface PortalApplicationSource {
  readonly id: string;
  readonly reference: string;
  readonly applicantName: string;
  readonly applicantUserId: string | null;
  readonly status: string;
}

/** History row. Transition notes are intentionally absent: they are not shared. */
export interface PortalHistorySource {
  readonly id: string;
  readonly toStatus: string;
  readonly action: string;
  readonly createdAt: Date;
}

export interface PortalNoteSource {
  readonly id: string;
  readonly body: string;
  readonly visibility: string;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

export interface PortalRequestSource {
  readonly id: string;
  readonly description: string;
  readonly status: string;
  readonly dueAt: Date | null;
  readonly createdAt: Date;
}

/** Finalised human outcome only. Votes and tallies are not accepted here. */
export interface PortalDecisionSource {
  readonly status: string;
  readonly finalOutcome: string | null;
  readonly rationale: string | null;
  readonly finalisedAt: Date | null;
}

export interface ApplicantTimelineEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly statusLabel: string;
  readonly summary: string;
}

export interface ApplicantSharedNote {
  readonly id: string;
  readonly body: string;
  readonly sharedAt: string;
}

export interface ApplicantOpenRequest {
  readonly id: string;
  readonly description: string;
  readonly dueAt: string | null;
  readonly askedAt: string;
}

export interface ApplicantRecordedOutcome {
  readonly outcome: RecordedOutcome;
  readonly label: string;
  readonly rationale: string | null;
  readonly recordedAt: string | null;
}

export interface ApplicantPortalView {
  readonly id: string;
  readonly reference: string;
  readonly applicantName: string;
  readonly status: ApplicationStatus;
  readonly statusLabel: string;
  readonly timeline: readonly ApplicantTimelineEntry[];
  readonly sharedNotes: readonly ApplicantSharedNote[];
  readonly openRequests: readonly ApplicantOpenRequest[];
  readonly outcome: ApplicantRecordedOutcome | null;
  readonly canWithdraw: boolean;
}

export interface ApplicantPortalSummary {
  readonly id: string;
  readonly reference: string;
  readonly applicantName: string;
  readonly statusLabel: string;
}

function isApplicationStatus(value: string): value is ApplicationStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, value);
}

function isRecordedOutcome(value: string | null): value is RecordedOutcome {
  return value !== null && Object.prototype.hasOwnProperty.call(OUTCOME_LABELS, value);
}

export function statusLabel(status: string): string {
  return isApplicationStatus(status)
    ? STATUS_LABELS[status]
    : 'Recorded by the organisation';
}

function latestOutcome(
  decisions: readonly PortalDecisionSource[],
): ApplicantRecordedOutcome | null {
  const finalised = decisions.filter(
    (decision) =>
      decision.status === 'finalised' && isRecordedOutcome(decision.finalOutcome),
  );
  if (finalised.length === 0) return null;
  const latest = [...finalised].sort((a, b) => {
    const aTime = a.finalisedAt?.getTime() ?? 0;
    const bTime = b.finalisedAt?.getTime() ?? 0;
    return bTime - aTime;
  })[0];
  if (!latest || !isRecordedOutcome(latest.finalOutcome)) return null;
  const rationale = latest.rationale?.trim();
  return {
    outcome: latest.finalOutcome,
    label: OUTCOME_LABELS[latest.finalOutcome],
    rationale: rationale ? rationale : null,
    recordedAt: latest.finalisedAt ? latest.finalisedAt.toISOString() : null,
  };
}

/**
 * Project one application for its applicant. Returns null when the actor is
 * not the applicant, including when the link is missing. Callers must treat
 * null the same as "not available" and must not fall back to a wider read.
 */
export function projectApplicantPortal(input: {
  readonly actorUserId: string;
  readonly application: PortalApplicationSource;
  readonly history: readonly PortalHistorySource[];
  readonly notes: readonly PortalNoteSource[];
  readonly requests: readonly PortalRequestSource[];
  readonly decisions: readonly PortalDecisionSource[];
}): ApplicantPortalView | null {
  if (input.application.applicantUserId !== input.actorUserId) return null;
  const status = input.application.status;
  const timeline = [...input.history]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((entry) => ({
      id: entry.id,
      occurredAt: entry.createdAt.toISOString(),
      statusLabel: statusLabel(entry.toStatus),
      summary: ACTION_SUMMARIES[entry.action] ?? 'The organisation recorded a change',
    }));

  return {
    id: input.application.id,
    reference: input.application.reference,
    applicantName: input.application.applicantName,
    status: isApplicationStatus(status) ? status : 'draft',
    statusLabel: statusLabel(status),
    timeline,
    sharedNotes: input.notes
      .filter((note) => note.visibility === 'shared' && note.deletedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((note) => ({
        id: note.id,
        body: note.body,
        sharedAt: note.createdAt.toISOString(),
      })),
    openRequests: input.requests
      .filter((request) => request.status === 'open')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((request) => ({
        id: request.id,
        description: request.description,
        dueAt: request.dueAt ? request.dueAt.toISOString() : null,
        askedAt: request.createdAt.toISOString(),
      })),
    outcome: latestOutcome(input.decisions),
    canWithdraw: isApplicationStatus(status) && ACTIVE_STATUSES.has(status),
  };
}

export function projectApplicantSummary(
  actorUserId: string,
  application: PortalApplicationSource,
): ApplicantPortalSummary | null {
  if (application.applicantUserId !== actorUserId) return null;
  return {
    id: application.id,
    reference: application.reference,
    applicantName: application.applicantName,
    statusLabel: statusLabel(application.status),
  };
}
