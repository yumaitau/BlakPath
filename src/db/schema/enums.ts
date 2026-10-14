import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Shared enumerated types.
 *
 * These are Postgres native enums so invalid states are rejected at the
 * database boundary as well as in application code. Enum *values* here describe
 * lifecycle and outcome states only — nothing in this platform ever encodes a
 * judgement about a person's Aboriginality. Determination authority always
 * rests with authorised humans in the organisation.
 */

/** Lifecycle of a tenant organisation on the platform. */
export const organisationStatus = pgEnum('organisation_status', [
  'draft',
  'onboarding',
  'active',
  'suspended',
  'closed',
]);

/** Lifecycle of a person's membership within an organisation. */
export const membershipStatus = pgEnum('membership_status', [
  'invited',
  'active',
  'suspended',
  'revoked',
]);

/** Lifecycle of an email invitation to join one organisation. */
export const membershipInvitationStatus = pgEnum('membership_invitation_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
]);

/** Lifecycle of a representative-authorisation grant. */
export const authorisationStatus = pgEnum('authorisation_status', [
  'pending',
  'active',
  'suspended',
  'revoked',
  'expired',
]);

/**
 * Lifecycle of a Confirmation of Aboriginality application.
 *
 * These are process states only — where the application sits in the human
 * workflow. NONE of them encodes a judgement about the person's Aboriginality;
 * `decided` merely records that authorised humans have recorded their outcome
 * elsewhere. The determination itself is never made by this software.
 */
export const applicationStatus = pgEnum('application_status', [
  'draft',
  'submitted',
  'intake_review',
  'awaiting_evidence',
  'in_review',
  'ready_for_committee',
  'in_committee',
  'decided',
  'withdrawn',
  'closed',
]);

/** Lifecycle of a single worker assignment on an application. */
export const assignmentStatus = pgEnum('assignment_status', ['active', 'released']);

/** Operational handling priority of an application (never an eligibility signal). */
export const applicationPriority = pgEnum('application_priority', [
  'low',
  'normal',
  'high',
]);

/**
 * Outcome recorded on an audit event. `denied` distinguishes an
 * authorisation refusal from a `failure` (an error). Every sensitive action is
 * permission-checked and logged with one of these outcomes.
 */
export const auditResult = pgEnum('audit_result', ['success', 'failure', 'denied']);

/**
 * Lifecycle of a piece of uploaded evidence. Fail-secure: only `clean` is ever
 * servable. `infected` (malware found) and `rejected` (policy reject, e.g. a
 * spoofed content type) are never served; a file whose scan cannot complete
 * stays `quarantined` and is retried, never promoted.
 */
export const evidenceStatus = pgEnum('evidence_status', [
  'pending',
  'quarantined',
  'clean',
  'infected',
  'rejected',
]);

/** Lifecycle of a request for further evidence from an applicant. */
export const evidenceRequestStatus = pgEnum('evidence_request_status', [
  'open',
  'fulfilled',
  'cancelled',
]);

/**
 * How a file was received when staff record it for an applicant.
 * Absent when the applicant uploaded the file themselves. This is a receipt
 * fact, not a judgement about the person.
 */
export const EVIDENCE_RECEIPT_CHANNELS = ['post', 'in_person', 'email', 'other'] as const;
export const evidenceReceiptChannel = pgEnum(
  'evidence_receipt_channel',
  EVIDENCE_RECEIPT_CHANNELS,
);

/**
 * Lifecycle of a review of an application. A review records a human reviewer's
 * observations for the committee — never a determination. `finalised` means the
 * observations are locked into the record put before the committee.
 */
export const reviewStatus = pgEnum('review_status', ['draft', 'finalised']);

/**
 * Lifecycle of a recorded family connection. `approved` means an authorised
 * human (genealogy officer / cultural authority) confirmed the connection after
 * appropriate records and cultural checks — it is not a determination of
 * Aboriginality, only that this specific relationship is recorded.
 */
export const familyLinkStatus = pgEnum('family_link_status', [
  'requested',
  'approved',
  'disputed',
  'withdrawn',
]);

/** Lifecycle of a committee meeting. */
export const meetingStatus = pgEnum('meeting_status', [
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
]);

/** Lifecycle of a declared conflict of interest. */
export const conflictStatus = pgEnum('conflict_status', [
  'declared',
  'cleared',
  'recused',
]);

/** Lifecycle of a proposed committee decision. */
export const decisionStatus = pgEnum('decision_status', [
  'proposed',
  'finalised',
  'withdrawn',
]);

/**
 * The outcome a committee (authorised humans) RECORDS on an application. The
 * software never computes this — it stores the decision the committee reached.
 * `confirmed` means the organisation's authorised people recorded confirmation;
 * it is not, and can never be, a machine determination of Aboriginality.
 */
export const decisionOutcome = pgEnum('decision_outcome', [
  'confirmed',
  'not_confirmed',
  'deferred',
]);

/** A committee member's vote on a proposed decision. */
export const voteChoice = pgEnum('vote_choice', ['for', 'against', 'abstain']);

/** Kanban board column a work task sits in. */
export const boardTaskStatus = pgEnum('board_task_status', [
  'todo',
  'in_progress',
  'blocked',
  'done',
]);

/** Handling priority of a board task (operational only). */
export const boardTaskPriority = pgEnum('board_task_priority', [
  'low',
  'normal',
  'high',
  'urgent',
]);

/**
 * Lifecycle of a Confirmation of Aboriginality certificate. Only a `signed`
 * (and not revoked) certificate is valid or downloadable. A certificate records
 * a decision authorised humans finalised — the software never determines it.
 */
export const certificateStatus = pgEnum('certificate_status', [
  'draft',
  'signed',
  'revoked',
]);

/** What a retention policy does to a record once it is past its retention period. */
export const retentionAction = pgEnum('retention_action', ['purge', 'anonymise']);

/** Lifecycle of an export request. */
export const exportStatus = pgEnum('export_status', [
  'pending',
  'processing',
  'ready',
  'failed',
]);

/** Delivery state of a single webhook dispatch. */
export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'delivered',
  'failed',
]);

/** Lifecycle of a custom form. */
export const formStatus = pgEnum('form_status', ['draft', 'published', 'closed']);

/** Lifecycle of a tokenised form invitation sent to a recipient. */
export const formInvitationStatus = pgEnum('form_invitation_status', [
  'pending',
  'opened',
  'completed',
  'expired',
  'revoked',
]);

/** Lifecycle of a break-glass (emergency access) request. */
export const breakGlassStatus = pgEnum('break_glass_status', [
  'requested',
  'approved',
  'denied',
  'active',
  'expired',
  'revoked',
]);

/**
 * Who holds the tenant's key-encryption key. These are custody arrangements,
 * not judgements about a person. `client_owned` is a CMK in the client's
 * account or an external key store (XKS) key. Escrow is a separate flag.
 */
export const keyCustodyMode = pgEnum('key_custody_mode', [
  'blakpath_managed',
  'client_owned',
  'client_owned_escrow',
]);

/**
 * Whether a tenant key may wrap or unwrap data.
 * `pending_validation` is not usable: the handshake has not passed.
 */
export const organisationKeyStatus = pgEnum('organisation_key_status', [
  'active',
  'disabled',
  'pending_deletion',
  'unavailable',
  'pending_validation',
]);

/** Result of the GenerateDataKey / Decrypt handshake for a tenant key. */
export const organisationKeyValidationStatus = pgEnum(
  'organisation_key_validation_status',
  ['pending', 'passed', 'failed'],
);

/** Background re-wrap of fields and objects onto a replacement CMK. */
export const organisationKeyRewrapStatus = pgEnum('organisation_key_rewrap_status', [
  'running',
  'completed',
  'failed',
]);
