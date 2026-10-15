/**
 * Correspondence composition — pure merge, send gates and email minimisation.
 *
 * Nothing here touches the database. The service layer calls these helpers
 * before it stores a letter or queues an email, and unit tests cover every
 * gate without Postgres.
 *
 * PRODUCT INVARIANT: an outcome letter states a decision authorised humans
 * already recorded. These helpers never score, rank, predict, or choose an
 * outcome. `decision.outcome` is a label for a value a person stored.
 *
 * Email bodies are deliberately short. The letter detail (outcome wording,
 * evidence description, certificate reference) stays on the case and on the
 * secure link. A bearer link is never written into a stored email copy.
 */

export const CORRESPONDENCE_KINDS = [
  'outcome',
  'evidence_request',
  'revocation',
  'certificate',
  'general',
] as const;

export type CorrespondenceKind = (typeof CORRESPONDENCE_KINDS)[number];

export const CORRESPONDENCE_CHANNELS = ['email', 'letter'] as const;

export type CorrespondenceChannel = (typeof CORRESPONDENCE_CHANNELS)[number];

export const CORRESPONDENCE_STATUSES = ['draft', 'sent'] as const;

export type CorrespondenceStatus = (typeof CORRESPONDENCE_STATUSES)[number];

/**
 * Merge fields an organisation may use in a template. Closed set: unknown
 * tokens are rejected at save time so a template cannot pull arbitrary data.
 */
export const MERGE_FIELDS = [
  'applicant.name',
  'application.reference',
  'organisation.name',
  'decision.outcome',
  'decision.finalised_on',
  'evidence.due_date',
  'evidence.summary',
  'certificate.reference',
  'portal.url',
] as const;

export type MergeField = (typeof MERGE_FIELDS)[number];

/** How long a secure applicant link remains valid after Send. */
export const PORTAL_LINK_DAYS = 14;

/**
 * Placeholder stored on the case in place of the bearer link. The real link
 * is emailed or printed; it is not kept in the correspondence row.
 */
export const STORED_PORTAL_TEXT = 'the secure link sent with this letter';

/** Shown in a staff preview. Replaced with the real link only at Send. */
export const PREVIEW_PORTAL_TEXT = 'A secure link is added here when you send.';

/**
 * Labels for a human-recorded outcome. The software does not choose among
 * these; it only spells a value an authorised person already stored.
 */
export const RECORDED_OUTCOME_LABELS = {
  confirmed: 'Confirmed',
  not_confirmed: 'Not confirmed',
  deferred: 'Deferred',
} as const;

export type RecordedOutcome = keyof typeof RECORDED_OUTCOME_LABELS;

const MERGE_FIELD_SET: ReadonlySet<string> = new Set(MERGE_FIELDS);
const TOKEN = /\{\{\s*([^{}]{1,60})\s*\}\}/g;
const FIELD_NAME = /^[a-z][a-z0-9._]{0,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface StarterTemplate {
  readonly name: string;
  readonly kind: CorrespondenceKind;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
}

/** Organisation-editable defaults. Copied into a tenant; never sent on their own. */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    name: 'Outcome letter',
    kind: 'outcome',
    subjectTemplate: 'Letter about application {{application.reference}}',
    bodyTemplate: [
      'Dear {{applicant.name}},',
      '',
      '{{organisation.name}} has recorded an outcome on application {{application.reference}}.',
      '',
      'The outcome recorded by authorised people in the organisation is: {{decision.outcome}}.',
      'Recorded on: {{decision.finalised_on}}.',
      '',
      'This letter states a decision people in the organisation made and recorded. It is not a determination made by software.',
      '',
      'You can read this letter at {{portal.url}}.',
    ].join('\n'),
  },
  {
    name: 'Evidence request',
    kind: 'evidence_request',
    subjectTemplate: 'More information for application {{application.reference}}',
    bodyTemplate: [
      'Dear {{applicant.name}},',
      '',
      '{{organisation.name}} needs more information for application {{application.reference}}.',
      '',
      'Please provide:',
      '{{evidence.summary}}',
      '',
      'Please provide it by {{evidence.due_date}}.',
      '',
      'You can read this request at {{portal.url}}.',
    ].join('\n'),
  },
  {
    name: 'Certificate letter',
    kind: 'certificate',
    subjectTemplate: 'Certificate for application {{application.reference}}',
    bodyTemplate: [
      'Dear {{applicant.name}},',
      '',
      '{{organisation.name}} has issued a certificate for application {{application.reference}}.',
      '',
      'Certificate reference: {{certificate.reference}}.',
      '',
      'Open {{portal.url}} to download it. The link is time-limited.',
      '',
      'The certificate records a decision authorised people in the organisation made. It is not a determination made by software.',
    ].join('\n'),
  },
  {
    name: 'Revocation letter',
    kind: 'revocation',
    subjectTemplate: 'Certificate update for application {{application.reference}}',
    bodyTemplate: [
      'Dear {{applicant.name}},',
      '',
      '{{organisation.name}} has revoked certificate {{certificate.reference}} for application {{application.reference}}.',
      '',
      'That revocation was recorded by an authorised person. Read the letter at {{portal.url}}.',
    ].join('\n'),
  },
  {
    name: 'General letter',
    kind: 'general',
    subjectTemplate: 'Message about application {{application.reference}}',
    bodyTemplate: [
      'Dear {{applicant.name}},',
      '',
      '{{organisation.name}} has a message about application {{application.reference}}.',
      '',
      'Read it at {{portal.url}}.',
    ].join('\n'),
  },
];

export function starterFor(kind: CorrespondenceKind): StarterTemplate {
  const found = STARTER_TEMPLATES.find((template) => template.kind === kind);
  if (!found) {
    throw new Error(`No starter template for ${kind}.`);
  }
  return found;
}

/** Tokens referenced by a template, in first-seen order. */
export function mergeFieldTokens(template: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(TOKEN)) {
    const name = match[1]?.trim() ?? '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  return found;
}

/** Tokens that are not in the closed merge-field list. */
export function unknownMergeFields(template: string): string[] {
  return mergeFieldTokens(template).filter(
    (name) => !FIELD_NAME.test(name) || !MERGE_FIELD_SET.has(name),
  );
}

/** Referenced fields whose value is missing or blank. */
export function blankMergeFields(
  template: string,
  values: Readonly<Record<string, string>>,
): string[] {
  return mergeFieldTokens(template).filter((name) => {
    if (!MERGE_FIELD_SET.has(name)) return false;
    return (values[name] ?? '').trim().length === 0;
  });
}

/** Replace known `{{field}}` tokens. Unknown tokens are left untouched. */
export function renderMerge(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(TOKEN, (full, raw: string) => {
    const name = raw.trim();
    if (!MERGE_FIELD_SET.has(name)) return full;
    return values[name] ?? '';
  });
}

export function outcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return '';
  if (Object.prototype.hasOwnProperty.call(RECORDED_OUTCOME_LABELS, outcome)) {
    return RECORDED_OUTCOME_LABELS[outcome as RecordedOutcome];
  }
  return '';
}

export function formatCorrespondenceDate(value: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'long',
    timeZone: 'Australia/Sydney',
  }).format(value);
}

/** Pull a contact email from organisation-defined intake, if one was recorded. */
export function emailFromIntake(intake: unknown): string | null {
  if (!intake || typeof intake !== 'object') return null;
  const record = intake as Record<string, unknown>;
  for (const key of ['email', 'contactEmail', 'applicantEmail']) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (EMAIL.test(trimmed) && trimmed.length <= 320) return trimmed;
  }
  return null;
}

export type SendBlock =
  | 'not_draft'
  | 'decision_not_finalised'
  | 'certificate_not_issued'
  | 'certificate_not_revoked'
  | 'evidence_due_date_required'
  | 'recipient_email_required'
  | 'missing_merge_values'
  | 'related_record_required';

export interface SendFacts {
  readonly kind: CorrespondenceKind;
  readonly status: CorrespondenceStatus;
  readonly channel: CorrespondenceChannel;
  /** Decision lifecycle. Outcome letters require `finalised`. */
  readonly decisionStatus: string | null;
  /** Certificate lifecycle. Issuing requires `signed`; revocation requires `revoked`. */
  readonly certificateStatus: string | null;
  readonly evidenceDueAt: Date | null;
  readonly recipientEmail: string | null;
  readonly missingMergeFields: readonly string[];
  /** Outcome, certificate, revocation and evidence letters must name their record. */
  readonly hasRelatedRecord: boolean;
}

/**
 * Why a draft cannot be sent, or null when Send is allowed.
 * Outcome letters are blocked until a person has finalised the decision.
 * This function does not send anything.
 */
export function sendBlock(facts: SendFacts): SendBlock | null {
  if (facts.status !== 'draft') return 'not_draft';
  if (facts.kind === 'outcome') {
    if (!facts.hasRelatedRecord) return 'related_record_required';
    if (facts.decisionStatus !== 'finalised') return 'decision_not_finalised';
  }
  if (facts.kind === 'certificate') {
    if (!facts.hasRelatedRecord) return 'related_record_required';
    if (facts.certificateStatus !== 'signed') return 'certificate_not_issued';
  }
  if (facts.kind === 'revocation') {
    if (!facts.hasRelatedRecord) return 'related_record_required';
    if (facts.certificateStatus !== 'revoked') return 'certificate_not_revoked';
  }
  if (facts.kind === 'evidence_request') {
    if (!facts.hasRelatedRecord) return 'related_record_required';
    if (!facts.evidenceDueAt) return 'evidence_due_date_required';
  }
  if (facts.channel === 'email' && !facts.recipientEmail) {
    return 'recipient_email_required';
  }
  if (facts.missingMergeFields.length > 0) return 'missing_merge_values';
  return null;
}

/**
 * Kind-specific send permission, on top of `correspondence:send`.
 * An outcome letter additionally requires `decision:finalise`, so preparing
 * a case cannot by itself dispatch the outcome.
 */
export function maySendKind(
  kind: CorrespondenceKind,
  permissions: ReadonlySet<string>,
): boolean {
  if (!permissions.has('correspondence:send')) return false;
  switch (kind) {
    case 'outcome':
      return permissions.has('decision:finalise');
    case 'certificate':
      return (
        permissions.has('certificate:generate') || permissions.has('certificate:sign')
      );
    case 'revocation':
      return (
        permissions.has('certificate:revoke') || permissions.has('certificate:generate')
      );
    case 'evidence_request':
      return permissions.has('evidence:request');
    case 'general':
      return true;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export interface MinimisedEmail {
  readonly subject: string;
  readonly text: string;
}

export interface MinimiseEmailInput {
  readonly kind: CorrespondenceKind;
  readonly organisationName: string;
  readonly applicationReference: string;
  /** Real link for the queued email, or a redaction marker for the stored copy. */
  readonly portalUrl: string;
  readonly expiresOn: string;
  /** Included only for evidence requests. Never an evidence description. */
  readonly dueDate?: string | null;
}

/**
 * Email copy that omits outcome wording, evidence description and certificate
 * contents. Evidence requests may include the due date, because that is the
 * operational notice. Detail stays behind the secure link.
 */
export function minimiseEmail(input: MinimiseEmailInput): MinimisedEmail {
  const subject = `Update on application ${input.applicationReference}`;
  const lines = [
    `${input.organisationName} has an update about application ${input.applicationReference}.`,
    '',
  ];
  if (input.kind === 'evidence_request' && input.dueDate) {
    lines.push(`Please provide the requested information by ${input.dueDate}.`);
    lines.push('');
  }
  lines.push(
    'Open the secure link below to read the letter. This email does not include the detail.',
    `The link expires on ${input.expiresOn}.`,
    '',
    input.portalUrl,
    '',
    input.organisationName,
  );
  return { subject, text: lines.join('\n') };
}

/** True when minimised email text contains applicant-sensitive letter detail. */
export function emailContainsSensitiveDetail(
  email: MinimisedEmail,
  detail: {
    readonly outcomeLabel?: string | null;
    readonly evidenceSummary?: string | null;
    readonly certificateReference?: string | null;
  },
): boolean {
  const haystack = `${email.subject}\n${email.text}`;
  for (const value of [
    detail.outcomeLabel,
    detail.evidenceSummary,
    detail.certificateReference,
  ]) {
    const needle = value?.trim();
    if (needle && needle.length >= 3 && haystack.includes(needle)) return true;
  }
  return false;
}
