import type { SendBlock } from './compose';

/**
 * Expected correspondence refusals.
 *
 * Messages are safe to show to staff. They describe the send rule that
 * failed, not applicant evidence or the letter body.
 */

export type CorrespondenceErrorCode =
  | SendBlock
  | 'unknown_merge_field'
  | 'template_inactive'
  | 'template_kind_mismatch'
  | 'email_suppressed'
  | 'duplicate_template_name'
  | 'letter_not_ready';

const MESSAGES: Record<CorrespondenceErrorCode, string> = {
  not_draft: 'This letter has already been sent.',
  decision_not_finalised:
    'An outcome letter cannot be sent until an authorised person has finalised the decision.',
  certificate_not_issued:
    'A certificate letter cannot be sent until the certificate has been signed.',
  certificate_not_revoked:
    'A revocation letter cannot be sent until an authorised person has revoked the certificate.',
  evidence_due_date_required:
    'An evidence request notice needs a due date before it can be sent.',
  recipient_email_required:
    'Add an email address for the applicant, or send a printed letter instead.',
  missing_merge_values:
    'This letter is missing information for one or more merge fields.',
  related_record_required:
    'Choose the decision, request or certificate this letter is about.',
  unknown_merge_field: 'A template uses a merge field that is not allowed.',
  template_inactive: 'That template is not active.',
  template_kind_mismatch: 'That template is for a different kind of letter.',
  email_suppressed:
    'That email address cannot receive mail. Send a printed letter instead.',
  duplicate_template_name: 'A template with that name already exists.',
  letter_not_ready: 'The printed letter is not ready yet.',
};

export class CorrespondenceError extends Error {
  readonly status = 409;
  readonly code: CorrespondenceErrorCode;

  constructor(code: CorrespondenceErrorCode, detail?: string) {
    const base = MESSAGES[code];
    const extra = detail?.trim().slice(0, 40);
    super(extra ? `${base} (${extra})` : base);
    this.name = 'CorrespondenceError';
    this.code = code;
  }
}
