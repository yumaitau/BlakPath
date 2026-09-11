/**
 * Audit vocabulary — the closed set of actions, resource types and outcomes
 * that may appear in the tamper-evident audit trail.
 *
 * These unions are the SINGLE source of truth for what an audit event can say.
 * They are intentionally exhaustive and closed: recording an action that is not
 * listed here is a type error, which keeps the trail describing a well-known,
 * reviewable set of sensitive operations rather than free-form strings.
 *
 * Nothing in this vocabulary encodes a judgement about a person's
 * Aboriginality. Actions describe access, movement and human decisions only —
 * the software never determines, scores, ranks or infers eligibility. Even
 * `decision.finalised` records that an authorised human recorded their outcome;
 * it never represents a machine-made determination.
 */

/** Outcome recorded on every audit event. Mirrors the `audit_result` pg enum. */
export type AuditResult = 'success' | 'failure' | 'denied';

/**
 * The exhaustive set of audited actions. Grouped by area for readability; the
 * string values are stable identifiers and MUST NOT be renamed once emitted
 * (they are part of the immutable, hashed trail).
 */
export type AuditAction =
  // Authentication.
  | 'auth.sign_in'
  | 'auth.sign_out'
  | 'auth.sign_in_failed'
  | 'auth.password_changed'
  | 'auth.password_reset_requested'
  | 'auth.password_reset_completed'
  | 'auth.email_verified'
  | 'auth.account_locked'
  | 'auth.account_unlocked'
  | 'auth.step_up_challenged'
  | 'auth.step_up_verified'
  | 'auth.step_up_failed'
  // Multi-factor authentication.
  | 'mfa.enrolled'
  | 'mfa.removed'
  | 'mfa.challenge_succeeded'
  | 'mfa.challenge_failed'
  | 'mfa.recovery_codes_regenerated'
  | 'mfa.recovery_code_used'
  | 'mfa.passkey_registered'
  | 'mfa.passkey_removed'
  // Session lifecycle.
  | 'session.created'
  | 'session.revoked'
  | 'session.expired'
  | 'session.active_organisation_changed'
  | 'session.impersonation_started'
  | 'session.impersonation_ended'
  // Permission / role / membership changes.
  | 'permission.granted'
  | 'permission.revoked'
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'role.permissions_changed'
  | 'membership.invited'
  | 'membership.invitation_accepted'
  | 'membership.invitation_revoked'
  | 'membership.role_assigned'
  | 'membership.role_removed'
  | 'membership.suspended'
  | 'membership.reinstated'
  | 'membership.revoked'
  // Application access and lifecycle.
  | 'application.created'
  | 'application.viewed'
  | 'application.updated'
  | 'application.deleted'
  | 'application.submitted'
  | 'application.withdrawn'
  | 'application.reopened'
  // Evidence / document access.
  | 'evidence.requested'
  | 'evidence.uploaded'
  | 'evidence.viewed'
  | 'evidence.downloaded'
  | 'evidence.metadata_viewed'
  | 'evidence.classified'
  | 'evidence.scan_started'
  | 'evidence.scan_clean'
  | 'evidence.scan_infected'
  | 'evidence.scan_failed'
  | 'evidence.rejected'
  | 'evidence.deleted'
  | 'evidence.quarantined'
  | 'evidence.restored'
  // API keys (public REST API credentials).
  | 'api_key.created'
  | 'api_key.revoked'
  // Custom forms & tokenised responses.
  | 'form.created'
  | 'form.updated'
  | 'form.published'
  | 'form.closed'
  | 'form.invitation_sent'
  | 'form.invitation_opened'
  | 'form.invitation_revoked'
  | 'form.response_submitted'
  // Search.
  | 'search.performed'
  | 'search.result_opened'
  // Record CRUD (people, families, notes).
  | 'record.created'
  | 'record.viewed'
  | 'record.updated'
  | 'record.deleted'
  | 'record.restored'
  // Workflow transitions.
  | 'workflow.transitioned'
  | 'workflow.stage_entered'
  | 'workflow.stage_completed'
  | 'workflow.returned'
  | 'workflow.reopened'
  // Work-board tasks (Kanban).
  | 'task.created'
  | 'task.updated'
  | 'task.assigned'
  | 'task.moved'
  | 'task.completed'
  | 'task.deleted'
  // Assignments.
  | 'assignment.assigned'
  | 'assignment.reassigned'
  | 'assignment.unassigned'
  | 'assignment.accepted'
  | 'assignment.declined'
  // Reviews.
  | 'review.started'
  | 'review.comment_added'
  | 'review.completed'
  | 'review.reopened'
  // Family-link records.
  | 'family_link.created'
  | 'family_link.viewed'
  | 'family_link.updated'
  | 'family_link.removed'
  | 'family_link.confirmed'
  | 'family_link.disputed'
  // Consent.
  | 'consent.recorded'
  | 'consent.viewed'
  | 'consent.updated'
  | 'consent.withdrawn'
  | 'consent.expired'
  // Messages / communications.
  | 'message.sent'
  | 'message.viewed'
  | 'message.deleted'
  | 'notification.sent'
  | 'email.suppressed'
  | 'email.suppression_cleared'
  // Meeting lifecycle & agenda.
  | 'meeting.created'
  | 'meeting.updated'
  | 'meeting.cancelled'
  | 'meeting.agenda_changed'
  // Calendar events (RangerOS parity).
  | 'calendar.created'
  | 'calendar.updated'
  | 'calendar.deleted'
  // Teams, groups, clients (council tenant model).
  | 'team.created'
  | 'team.member_added'
  | 'group.created'
  | 'group.member_added'
  | 'client.created'
  | 'client.assigned'
  // Meeting-pack access (panel materials).
  | 'meeting_pack.generated'
  | 'meeting_pack.viewed'
  | 'meeting_pack.downloaded'
  | 'meeting_pack.access_revoked'
  // Conflicts of interest.
  | 'conflict.declared'
  | 'conflict.cleared'
  | 'conflict.recused'
  // Votes (panel voting).
  | 'vote.cast'
  | 'vote.changed'
  | 'vote.withdrawn'
  // Decision proposal, finalisation and reversal (recorded by authorised humans).
  | 'decision.proposed'
  | 'decision.withdrawn'
  | 'decision.finalised'
  | 'decision.reversed'
  | 'decision.reason_recorded'
  // Certificate generation / download.
  | 'certificate.generated'
  | 'certificate.signed'
  | 'certificate.viewed'
  | 'certificate.downloaded'
  | 'certificate.reissued'
  | 'certificate.revoked'
  // Data export.
  | 'export.requested'
  | 'export.generated'
  | 'export.downloaded'
  | 'export.failed'
  // Retention / lifecycle of data.
  | 'retention.policy_applied'
  | 'retention.record_purged'
  | 'retention.record_anonymised'
  | 'retention.hold_placed'
  | 'retention.hold_released'
  // Break-glass (emergency cross-tenant access).
  | 'break_glass.requested'
  | 'break_glass.approved'
  | 'break_glass.denied'
  | 'break_glass.activated'
  | 'break_glass.revoked'
  | 'break_glass.expired'
  | 'break_glass.tenant_notified'
  | 'break_glass.reviewed'
  // Integrations.
  | 'integration.connected'
  | 'integration.disconnected'
  | 'integration.credentials_rotated'
  | 'integration.call_succeeded'
  | 'integration.call_failed'
  // Admin / configuration.
  | 'admin.organisation_updated'
  | 'admin.settings_updated'
  | 'admin.feature_flag_changed'
  | 'admin.domain_added'
  | 'admin.domain_verified'
  | 'admin.domain_removed'
  | 'admin.terminology_updated'
  // Audit self-events (integrity).
  | 'audit.chain_verified'
  | 'audit.checkpoint_created'
  | 'audit.divergence_detected';

/**
 * The exhaustive set of resource types an audit event may reference. Stable
 * identifiers; do not rename once emitted.
 */
export type ResourceType =
  | 'user'
  | 'session'
  | 'mfa_method'
  | 'passkey'
  | 'organisation'
  | 'organisation_settings'
  | 'organisation_domain'
  | 'feature_flag'
  | 'role'
  | 'permission'
  | 'membership'
  | 'application'
  | 'evidence'
  | 'record'
  | 'family_link'
  | 'consent'
  | 'representative_authorisation'
  | 'workflow'
  | 'assignment'
  | 'task'
  | 'api_key'
  | 'form'
  | 'form_invitation'
  | 'form_response'
  | 'review'
  | 'meeting'
  | 'agenda_item'
  | 'calendar_event'
  | 'team'
  | 'group'
  | 'client'
  | 'message'
  | 'notification'
  | 'email_suppression'
  | 'meeting_pack'
  | 'conflict'
  | 'vote'
  | 'decision'
  | 'certificate'
  | 'export'
  | 'retention_policy'
  | 'break_glass_request'
  | 'integration'
  | 'search'
  | 'audit_chain';

/** All audit results, useful for runtime validation and enumeration. */
export const AUDIT_RESULTS: readonly AuditResult[] = [
  'success',
  'failure',
  'denied',
] as const;

/** Type guard for {@link AuditResult}. */
export function isAuditResult(value: unknown): value is AuditResult {
  return value === 'success' || value === 'failure' || value === 'denied';
}
